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

/** Depletion forecast (Inventory UX, locked): trend-based run-out plus the
 *  chart's actionable payload — order-by = run-out minus vendor lead time
 *  (attributes.leadTimeDays, default 7). Null when usage is too quiet. */
@Serializable
data class Forecast(
    val ratePerDay: Double,
    val daysLeft: Double,
    val runOutDate: String,
    val orderByDate: String,
    val leadTimeDays: Int,
)

@Serializable
data class MaterialDetail(val material: Material, val ledger: List<LedgerEntry>, val forecast: Forecast? = null)

fun forecastFor(m: Material, ratePerDay: Double): Forecast? {
    if (ratePerDay < 0.0001 || m.stock.available <= 0) return null
    val daysLeft = m.stock.available / ratePerDay
    if (daysLeft > 365) return null
    val leadTime = m.attributes["leadTimeDays"]?.toIntOrNull()?.coerceIn(0, 90) ?: 7
    val runOut = java.time.LocalDate.now().plusDays(daysLeft.toLong())
    return Forecast(
        ratePerDay = ratePerDay,
        daysLeft = daysLeft,
        runOutDate = runOut.toString(),
        orderByDate = runOut.minusDays(leadTime.toLong()).toString(),
        leadTimeDays = leadTime,
    )
}

@Serializable
data class ArchiveRequest(val archived: Boolean)

@Serializable
data class WeighInRequest(
    val grossGrams: Double,
    val tareGrams: Double,
    /** Grams sitting in sealed, unweighed spools of the same material — the
     *  scale only sees the open spool; these are assumed untouched. Omitted =
     *  server derives it from on-hand vs. spool size. */
    val sealedGrams: Double? = null,
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
                val rate = materials.consumptionRates(listOf(id))[id] ?: 0.0
                call.respond(MaterialDetail(material, materials.ledger(id), forecastFor(material, rate)))
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
            val updated = materials.get(id)!!
            val rate = materials.consumptionRates(listOf(id))[id] ?: 0.0
            call.respond(MaterialDetail(updated, materials.ledger(id), forecastFor(updated, rate)))
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
            // Multi-spool holdings: on-hand may span several spools but the
            // scale only sees the open one. Sealed spools are assumed
            // untouched — default = every whole spool-size below on-hand
            // (4,560 g at 1 kg spools → 4 sealed + the 560 g being weighed).
            val full = m.fullQuantity
            val sealed = (req.sealedGrams
                ?: if (full != null && full > 0 && m.stock.onHand > full) (kotlin.math.ceil(m.stock.onHand / full) - 1) * full
                else 0.0)
                .coerceAtLeast(0.0)
            val delta = (sealed + net) - m.stock.onHand
            val userId = call.principal<UserSession>()!!.userId
            if (kotlin.math.abs(delta) >= 0.05) {
                val sealedNote = if (sealed > 0) " + ${g(sealed)} g sealed spools" else ""
                materials.recordTransaction(
                    id, delta, TxnKind.ADJUSTMENT,
                    "weigh-in: ${g(req.grossGrams)} g gross − ${g(req.tareGrams)} g tare = ${g(net)} g open spool$sealedNote (was ${g(m.stock.onHand)} g)",
                    userId,
                )
            }
            if (req.saveTare) materials.setAttribute(id, "spoolWeightGrams", g(req.tareGrams))
            // archiving only makes sense when this was the LAST spool
            if (req.markEmpty && sealed <= 0) materials.setArchived(id, true)
            val updated = materials.get(id)!!
            val rate = materials.consumptionRates(listOf(id))[id] ?: 0.0
            call.respond(MaterialDetail(updated, materials.ledger(id), forecastFor(updated, rate)))
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
