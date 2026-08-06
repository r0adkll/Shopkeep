package app.shopkeep.inventory

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.auth.UserSession
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import kotlinx.serialization.Serializable

@Serializable
data class CreateMaterialRequest(
    val material: MaterialInput,
    /** Optional opening stock, written as an `adjustment` ledger entry. */
    val initialQuantity: Double? = null,
)

@Serializable
data class TransactionRequest(val delta: Double, val kind: TxnKind, val note: String? = null)

@Serializable
data class MaterialDetail(val material: Material, val ledger: List<LedgerEntry>)

@Serializable
data class ArchiveRequest(val archived: Boolean)

@Serializable
data class WeighInRequest(
    val grossGrams: Double,
    val tareGrams: Double,
    /** True when the tare was set or corrected this weigh-in — persists it. */
    val saveTare: Boolean = false,
    /** Optional near-empty shortcut: archive the spool in the same breath. */
    val markEmpty: Boolean = false,
)

/** Kinds a human may write directly; reservation/release belong to the order pipeline (Phase 4). */
private val MANUAL_KINDS = setOf(TxnKind.PURCHASE, TxnKind.ADJUSTMENT, TxnKind.CONSUMPTION)

fun Route.inventoryRoutes(materials: MaterialRepository) {
    authenticate(SESSION_AUTH) {
        get("/inventory/materials") {
            val includeArchived = call.request.queryParameters["includeArchived"] == "true"
            call.respond(materials.list(includeArchived))
        }

        post("/inventory/materials") {
            val req = call.receive<CreateMaterialRequest>()
            if (req.material.name.isBlank() || req.material.category.isBlank() || req.material.unit.isBlank()) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Name, category, and unit are required."))
                return@post
            }
            val id = materials.create(req.material)
            if (req.initialQuantity != null && req.initialQuantity != 0.0) {
                val userId = call.principal<UserSession>()!!.userId
                materials.recordTransaction(id, req.initialQuantity, TxnKind.ADJUSTMENT, "Initial stock", userId)
            }
            call.respond(HttpStatusCode.Created, materials.get(id)!!)
        }

        get("/inventory/materials/{id}") {
            val id = call.parameters["id"]?.toLongOrNull()
            val material = id?.let { materials.get(it) }
            if (material == null) {
                call.respond(HttpStatusCode.NotFound, ApiError("Material not found."))
            } else {
                call.respond(MaterialDetail(material, materials.ledger(id)))
            }
        }

        patch("/inventory/materials/{id}") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null || materials.get(id) == null) {
                call.respond(HttpStatusCode.NotFound, ApiError("Material not found."))
                return@patch
            }
            materials.update(id, call.receive<MaterialInput>())
            call.respond(materials.get(id)!!)
        }

        delete("/inventory/materials/{id}") {
            val id = call.parameters["id"]?.toLongOrNull()
            val err = id?.let { materials.delete(it) } ?: "Material not found."
            if (err == null) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.Conflict, ApiError(err))
        }

        post("/inventory/materials/{id}/archive") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<ArchiveRequest>()
            if (id == null || !materials.setArchived(id, req.archived)) {
                call.respond(HttpStatusCode.NotFound, ApiError("Material not found."))
            } else {
                call.respond(materials.get(id)!!)
            }
        }

        post("/inventory/materials/{id}/transactions") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null || materials.get(id) == null) {
                call.respond(HttpStatusCode.NotFound, ApiError("Material not found."))
                return@post
            }
            val req = call.receive<TransactionRequest>()
            if (req.kind !in MANUAL_KINDS) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Reservations are managed by the order queue."))
                return@post
            }
            if (req.delta == 0.0) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Delta must be non-zero."))
                return@post
            }
            val userId = call.principal<UserSession>()!!.userId
            materials.recordTransaction(id, req.delta, req.kind, req.note, userId)
            call.respond(MaterialDetail(materials.get(id)!!, materials.ledger(id)))
        }

        // Weigh-in audit (vault: Inventory UX): gross − tare = what's really
        // on the spool; the gap vs. on-hand becomes one ADJUSTMENT event.
        // Reserved stock is a logical hold on physically-present material, so
        // the comparison is against on-hand, never available.
        post("/inventory/materials/{id}/weigh-in") {
            val id = call.parameters["id"]?.toLongOrNull()
            val m = id?.let { materials.get(it) }
            if (m == null) {
                call.respond(HttpStatusCode.NotFound, ApiError("Material not found."))
                return@post
            }
            val req = call.receive<WeighInRequest>()
            if (req.grossGrams < 0 || req.tareGrams < 0 || req.grossGrams > 100_000) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Weights must be sensible non-negative grams."))
                return@post
            }
            fun g(v: Double) = if (v % 1.0 == 0.0) v.toLong().toString() else "%.1f".format(v)
            val net = (req.grossGrams - req.tareGrams).coerceAtLeast(0.0)
            val delta = net - m.stock.onHand
            val userId = call.principal<UserSession>()!!.userId
            if (kotlin.math.abs(delta) >= 0.05) {
                materials.recordTransaction(
                    id, delta, TxnKind.ADJUSTMENT,
                    "weigh-in: ${g(req.grossGrams)} g gross − ${g(req.tareGrams)} g tare = ${g(net)} g (was ${g(m.stock.onHand)} g)",
                    userId,
                )
            }
            if (req.saveTare) materials.setAttribute(id, "spoolWeightGrams", g(req.tareGrams))
            if (req.markEmpty) materials.setArchived(id, true)
            call.respond(MaterialDetail(materials.get(id)!!, materials.ledger(id)))
        }

        // Needs-purchasing: below-threshold materials, most urgent first
        // (vault: Inventory UX — fewest remaining relative to threshold wins).
        get("/inventory/purchasing") {
            val ranked = materials.list()
                .filter { it.lowStockThreshold != null && it.status != StockStatus.OK }
                .sortedBy { it.stock.available / (it.lowStockThreshold ?: 1.0) }
            call.respond(ranked)
        }
    }
}
