package app.shopkeep.inventory

import app.shopkeep.db.dbQuery
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.json.jsonb
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.sum
import org.jetbrains.exposed.sql.update
import java.math.BigDecimal
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

/*
 * Vault: Data Model.md (materials + inventory ledger, D5).
 * Stock is NEVER a stored integer — it derives from ledger rows:
 *   on-hand  = Σ delta where kind ∈ (purchase, adjustment, consumption)
 *   reserved = −Σ delta where kind ∈ (reservation, release)
 *   available = on-hand − reserved
 * Reservation/release rows arrive with orders in Phase 4; the math is fixed now.
 */

enum class TxnKind { PURCHASE, RESERVATION, RELEASE, CONSUMPTION, ADJUSTMENT }

enum class StockStatus { OK, LOW, CRITICAL }

object MaterialsTable : Table("materials") {
    val id = long("id").autoIncrement()
    val name = text("name")
    val brand = text("brand").nullable()
    val category = text("category")
    val type = text("type")
    val unit = text("unit")
    val costMinor = long("cost_minor")
    val costQuantity = decimal("cost_quantity", 12, 2)
    val currency = text("currency")
    val lowStockThreshold = decimal("low_stock_threshold", 12, 2).nullable()
    val reorderQuantity = decimal("reorder_quantity", 12, 2).nullable()
    val fullQuantity = decimal("full_quantity", 12, 2).nullable()
    val vendorUrl = text("vendor_url").nullable()
    val attributes = jsonb<Map<String, String>>("attributes", Json.Default)
    val archivedAt = timestampWithTimeZone("archived_at").nullable()
    val createdAt = timestampWithTimeZone("created_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

object InventoryTransactionsTable : Table("inventory_transactions") {
    val id = long("id").autoIncrement()
    val materialId = long("material_id")
    val delta = decimal("delta", 12, 3)
    val kind = text("kind")
    val note = text("note").nullable()
    val createdBy = long("created_by").nullable()
    val createdAt = timestampWithTimeZone("created_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class Stock(val onHand: Double, val reserved: Double, val available: Double)

@Serializable
data class Material(
    val id: Long,
    val name: String,
    val brand: String? = null,
    val category: String,
    val type: String,
    val unit: String,
    val costMinor: Long,
    val costQuantity: Double,
    val currency: String,
    val lowStockThreshold: Double?,
    val reorderQuantity: Double?,
    val fullQuantity: Double?,
    val vendorUrl: String?,
    val attributes: Map<String, String>,
    val archived: Boolean,
    val stock: Stock,
    val status: StockStatus,
)

@Serializable
data class MaterialInput(
    val name: String,
    val brand: String? = null,
    val category: String,
    val type: String,
    val unit: String,
    val costMinor: Long = 0,
    val costQuantity: Double = 1.0,
    val currency: String = "USD",
    val lowStockThreshold: Double? = null,
    val reorderQuantity: Double? = null,
    val fullQuantity: Double? = null,
    val vendorUrl: String? = null,
    val attributes: Map<String, String> = emptyMap(),
)

@Serializable
data class LedgerEntry(
    val id: Long,
    val delta: Double,
    val kind: TxnKind,
    val note: String?,
    val runningOnHand: Double,
    val createdAt: String?,
)

@SingleIn(AppScope::class)
@Inject
class MaterialRepository {

    suspend fun list(includeArchived: Boolean = false): List<Material> = dbQuery {
        val stocks = aggregateStock()
        MaterialsTable.selectAll()
            .let { if (includeArchived) it else it.where { MaterialsTable.archivedAt.isNull() } }
            .orderBy(MaterialsTable.category)
            .map { it.toMaterial(stocks[it[MaterialsTable.id]] ?: Stock(0.0, 0.0, 0.0)) }
    }

    suspend fun get(id: Long): Material? = dbQuery {
        val stock = aggregateStock(id)[id] ?: Stock(0.0, 0.0, 0.0)
        MaterialsTable.selectAll().where { MaterialsTable.id eq id }.singleOrNull()?.toMaterial(stock)
    }

    suspend fun create(input: MaterialInput): Long = dbQuery {
        MaterialsTable.insert { apply(it, input) } get MaterialsTable.id
    }

    suspend fun update(id: Long, input: MaterialInput): Boolean = dbQuery {
        MaterialsTable.update({ MaterialsTable.id eq id }) { apply(it, input) } > 0
    }

    suspend fun setArchived(id: Long, archived: Boolean): Boolean = dbQuery {
        MaterialsTable.update({ MaterialsTable.id eq id }) {
            it[archivedAt] = if (archived) OffsetDateTime.now() else null
        } > 0
    }

    suspend fun recordTransaction(materialId: Long, delta: Double, kind: TxnKind, note: String?, userId: Long?): Long =
        dbQuery {
            InventoryTransactionsTable.insert {
                it[InventoryTransactionsTable.materialId] = materialId
                it[InventoryTransactionsTable.delta] = BigDecimal.valueOf(delta)
                it[InventoryTransactionsTable.kind] = kind.name.lowercase()
                it[InventoryTransactionsTable.note] = note?.takeIf { n -> n.isNotBlank() }
                it[createdBy] = userId
            } get InventoryTransactionsTable.id
        }

    /** Full ledger, oldest first, with a running on-hand balance for the history chart. */
    suspend fun ledger(materialId: Long): List<LedgerEntry> = dbQuery {
        var running = 0.0
        InventoryTransactionsTable.selectAll()
            .where { InventoryTransactionsTable.materialId eq materialId }
            .orderBy(InventoryTransactionsTable.id)
            .map { row ->
                val kind = TxnKind.valueOf(row[InventoryTransactionsTable.kind].uppercase())
                val delta = row[InventoryTransactionsTable.delta].toDouble()
                if (kind == TxnKind.PURCHASE || kind == TxnKind.ADJUSTMENT || kind == TxnKind.CONSUMPTION) {
                    running += delta
                }
                LedgerEntry(
                    id = row[InventoryTransactionsTable.id],
                    delta = delta,
                    kind = kind,
                    note = row[InventoryTransactionsTable.note],
                    runningOnHand = running,
                    createdAt = row[InventoryTransactionsTable.createdAt]?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                )
            }
    }

    private fun aggregateStock(materialId: Long? = null): Map<Long, Stock> {
        val sums = mutableMapOf<Long, MutableMap<String, Double>>()
        val deltaSum = InventoryTransactionsTable.delta.sum()
        InventoryTransactionsTable
            .select(InventoryTransactionsTable.materialId, InventoryTransactionsTable.kind, deltaSum)
            .let { q ->
                if (materialId != null) q.where { InventoryTransactionsTable.materialId eq materialId } else q
            }
            .groupBy(InventoryTransactionsTable.materialId, InventoryTransactionsTable.kind)
            .forEach { row ->
                val id = row[InventoryTransactionsTable.materialId]
                val kind = row[InventoryTransactionsTable.kind]
                sums.getOrPut(id) { mutableMapOf() }[kind] = row[deltaSum]?.toDouble() ?: 0.0
            }
        return sums.mapValues { (_, byKind) ->
            val onHand = (byKind["purchase"] ?: 0.0) + (byKind["adjustment"] ?: 0.0) + (byKind["consumption"] ?: 0.0)
            val reserved = -((byKind["reservation"] ?: 0.0) + (byKind["release"] ?: 0.0))
            Stock(onHand = onHand, reserved = reserved, available = onHand - reserved)
        }
    }

    private fun MaterialsTable.apply(it: org.jetbrains.exposed.sql.statements.UpdateBuilder<*>, input: MaterialInput) {
        it[name] = input.name.trim()
        it[brand] = input.brand?.trim()?.takeIf { b -> b.isNotEmpty() }
        it[category] = input.category.trim().lowercase()
        it[type] = input.type.trim()
        it[unit] = input.unit.trim()
        it[costMinor] = input.costMinor
        it[costQuantity] = BigDecimal.valueOf(input.costQuantity)
        it[currency] = input.currency
        it[lowStockThreshold] = input.lowStockThreshold?.let(BigDecimal::valueOf)
        it[reorderQuantity] = input.reorderQuantity?.let(BigDecimal::valueOf)
        it[fullQuantity] = input.fullQuantity?.let(BigDecimal::valueOf)
        it[vendorUrl] = input.vendorUrl?.takeIf { v -> v.isNotBlank() }
        it[attributes] = input.attributes
    }

    private fun ResultRow.toMaterial(stock: Stock): Material {
        val threshold = this[MaterialsTable.lowStockThreshold]?.toDouble()
        // Buildable-units drives status once Products exist (Phase 2); until then
        // the static threshold is the health signal (vault: Inventory UX).
        val status = when {
            threshold == null -> StockStatus.OK
            stock.available <= threshold * 0.5 -> StockStatus.CRITICAL
            stock.available <= threshold -> StockStatus.LOW
            else -> StockStatus.OK
        }
        return Material(
            id = this[MaterialsTable.id],
            name = this[MaterialsTable.name],
            brand = this[MaterialsTable.brand],
            category = this[MaterialsTable.category],
            type = this[MaterialsTable.type],
            unit = this[MaterialsTable.unit],
            costMinor = this[MaterialsTable.costMinor],
            costQuantity = this[MaterialsTable.costQuantity].toDouble(),
            currency = this[MaterialsTable.currency],
            lowStockThreshold = threshold,
            reorderQuantity = this[MaterialsTable.reorderQuantity]?.toDouble(),
            fullQuantity = this[MaterialsTable.fullQuantity]?.toDouble(),
            vendorUrl = this[MaterialsTable.vendorUrl],
            attributes = this[MaterialsTable.attributes],
            archived = this[MaterialsTable.archivedAt] != null,
            stock = stock,
            status = status,
        )
    }
}
