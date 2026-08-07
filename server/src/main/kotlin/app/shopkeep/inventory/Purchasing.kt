package app.shopkeep.inventory

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.auth.UserSession
import app.shopkeep.db.dbQuery
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

/* Purchasing panel (vault: Inventory UX / Design Process, locked 2026-08-07):
 * need → ordered → received. Low stock ranks itself (threshold math), the
 * receive step writes the PURCHASE ledger entry and refreshes the material's
 * cost basis when the price changed. Rows survive receipt as history. */

object PurchasesTable : Table("purchases") {
    val id = long("id").autoIncrement()
    val materialId = long("material_id")
    val quantity = decimal("quantity", 12, 2)
    val estCostMinor = long("est_cost_minor").nullable()
    val orderedAt = timestampWithTimeZone("ordered_at").nullable()
    val receivedAt = timestampWithTimeZone("received_at").nullable()
    val createdAt = timestampWithTimeZone("created_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class PanelNeed(
    val material: Material,
    val suggestedQty: Double,
    val estCostMinor: Long,
    /** Set when this row is a manual add (queued) rather than a low-stock nag. */
    val purchaseId: Long? = null,
)

@Serializable
data class PanelOnOrder(
    val id: Long,
    val material: Material,
    val quantity: Double,
    val estCostMinor: Long?,
    val orderedAt: String?,
)

@Serializable
data class PurchasingPanel(val needs: List<PanelNeed>, val onOrder: List<PanelOnOrder>)

@Serializable
data class AddPurchaseRequest(val materialId: Long, val quantity: Double, val estCostMinor: Long? = null, val ordered: Boolean = false)

@Serializable
data class ReceiveRequest(val quantity: Double, val costMinor: Long? = null)

@SingleIn(AppScope::class)
@Inject
class PurchaseRepository(private val materials: MaterialRepository) {

    suspend fun panel(): PurchasingPanel {
        val mats = materials.list()
        val active = dbQuery {
            PurchasesTable.selectAll().where { PurchasesTable.receivedAt.isNull() }.toList()
        }
        val onOrderByMat = active.filter { it[PurchasesTable.orderedAt] != null }
        val queued = active.filter { it[PurchasesTable.orderedAt] == null }
        val onOrderMatIds = onOrderByMat.map { it[PurchasesTable.materialId] }.toSet()
        val byId = mats.associateBy { it.id }

        fun suggested(m: Material) = m.reorderQuantity ?: m.fullQuantity ?: m.lowStockThreshold ?: 1.0
        fun unitCost(m: Material) = if (m.costQuantity > 0) m.costMinor / m.costQuantity else 0.0

        // low stock nags itself; a material already on order stops nagging
        val low = mats
            .filter { it.lowStockThreshold != null && it.status != StockStatus.OK && it.id !in onOrderMatIds }
            .sortedBy { it.stock.available / (it.lowStockThreshold ?: 1.0) }
            .map { m -> PanelNeed(m, suggested(m), (unitCost(m) * suggested(m)).toLong()) }
        val lowIds = low.map { it.material.id }.toSet()
        val manual = queued.mapNotNull { row ->
            val m = byId[row[PurchasesTable.materialId]] ?: return@mapNotNull null
            if (m.id in lowIds || m.id in onOrderMatIds) return@mapNotNull null
            val qty = row[PurchasesTable.quantity].toDouble()
            PanelNeed(m, qty, (unitCost(m) * qty).toLong(), purchaseId = row[PurchasesTable.id])
        }
        val onOrder = onOrderByMat.mapNotNull { row ->
            val m = byId[row[PurchasesTable.materialId]] ?: return@mapNotNull null
            PanelOnOrder(
                id = row[PurchasesTable.id], material = m,
                quantity = row[PurchasesTable.quantity].toDouble(),
                estCostMinor = row[PurchasesTable.estCostMinor],
                orderedAt = row[PurchasesTable.orderedAt]?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
            )
        }.sortedByDescending { it.id }
        return PurchasingPanel(low + manual, onOrder)
    }

    suspend fun add(req: AddPurchaseRequest): Long = dbQuery {
        PurchasesTable.insert {
            it[materialId] = req.materialId
            it[quantity] = req.quantity.toBigDecimal()
            it[estCostMinor] = req.estCostMinor
            it[orderedAt] = if (req.ordered) OffsetDateTime.now() else null
            it[createdAt] = OffsetDateTime.now()
        } get PurchasesTable.id
    }

    suspend fun markOrdered(id: Long, quantity: Double?, estCostMinor: Long?): Boolean = dbQuery {
        PurchasesTable.update({ PurchasesTable.id eq id }) {
            it[orderedAt] = OffsetDateTime.now()
            if (quantity != null) it[PurchasesTable.quantity] = quantity.toBigDecimal()
            if (estCostMinor != null) it[PurchasesTable.estCostMinor] = estCostMinor
        } > 0
    }

    suspend fun receive(id: Long, req: ReceiveRequest, userId: Long): Material? {
        val row = dbQuery {
            PurchasesTable.selectAll().where { PurchasesTable.id eq id }.singleOrNull()
        } ?: return null
        val materialId = row[PurchasesTable.materialId]
        materials.recordTransaction(
            materialId, req.quantity, TxnKind.PURCHASE,
            "received order" + (req.costMinor?.let { " — $${"%.2f".format(it / 100.0)}" } ?: ""),
            userId,
        )
        // price changed → the cost basis follows reality, keeping margins honest
        if (req.costMinor != null && req.quantity > 0) {
            dbQuery {
                MaterialsTable.update({ MaterialsTable.id eq materialId }) {
                    it[costMinor] = req.costMinor
                    it[costQuantity] = req.quantity.toBigDecimal()
                }
            }
        }
        dbQuery { PurchasesTable.update({ PurchasesTable.id eq id }) { it[receivedAt] = OffsetDateTime.now() } }
        return materials.get(materialId)
    }

    suspend fun remove(id: Long): Boolean = dbQuery {
        val active = PurchasesTable.selectAll()
            .where { (PurchasesTable.id eq id) and PurchasesTable.receivedAt.isNull() }
            .singleOrNull() != null
        active && PurchasesTable.deleteWhere { PurchasesTable.id eq id } > 0
    }
}

fun Route.purchasingRoutes(purchases: PurchaseRepository) {
    authenticate(SESSION_AUTH) {
        get("/inventory/purchasing/panel") { call.respond(purchases.panel()) }

        post("/inventory/purchasing") {
            val req = call.receive<AddPurchaseRequest>()
            if (req.quantity <= 0) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Quantity must be positive."))
                return@post
            }
            purchases.add(req)
            call.respond(purchases.panel())
        }

        post("/inventory/purchasing/{id}/receive") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<ReceiveRequest>()
            if (id == null || req.quantity <= 0) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("A positive received quantity is required."))
                return@post
            }
            val userId = call.principal<UserSession>()!!.userId
            val m = purchases.receive(id, req, userId)
            if (m == null) call.respond(HttpStatusCode.NotFound, ApiError("Purchase not found."))
            else call.respond(purchases.panel())
        }

        delete("/inventory/purchasing/{id}") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null || !purchases.remove(id)) {
                call.respond(HttpStatusCode.NotFound, ApiError("Purchase not found."))
            } else call.respond(purchases.panel())
        }
    }
}
