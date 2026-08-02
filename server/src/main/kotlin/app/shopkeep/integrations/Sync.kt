package app.shopkeep.integrations

import app.shopkeep.catalog.ProductRepository
import app.shopkeep.catalog.SlotKind
import app.shopkeep.db.dbQuery
import app.shopkeep.inventory.MaterialRepository
import app.shopkeep.inventory.TxnKind
import app.shopkeep.listings.ListingConfigurationsTable
import app.shopkeep.listings.ListingRepository
import app.shopkeep.listings.ListingsTable
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.andWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.json.jsonb
import org.jetbrains.exposed.sql.selectAll
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/* Vault: Order Management + Data Model lifecycle invariants.
 * Ingest is idempotent (connection + platform_order_id); matched lines
 * reserve inventory on arrival; unmatched lines reserve NOTHING and stay
 * loud until Phase 4's manual-match UI. */

object OrdersTable : Table("orders") {
    val id = long("id").autoIncrement()
    val connectionId = long("connection_id")
    val platformOrderId = text("platform_order_id")
    val category = text("category")
    val buyerName = text("buyer_name")
    val buyerMessage = text("buyer_message").nullable()
    val totalMinor = long("total_minor")
    val currency = text("currency")
    val placedAt = timestampWithTimeZone("placed_at").nullable()
    val ingestedAt = timestampWithTimeZone("ingested_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

object OrderLinesTable : Table("order_lines") {
    val id = long("id").autoIncrement()
    val orderId = long("order_id")
    val platformRef = text("platform_ref")
    val rawSku = text("raw_sku").nullable()
    val title = text("title")
    val quantity = integer("quantity")
    val priceMinor = long("price_minor")
    val variations = jsonb<List<EtsyVariation>>("variations", Json.Default)
    val personalization = jsonb<List<EtsyVariation>>("personalization", Json.Default)
    val listingConfigurationId = long("listing_configuration_id").nullable()
    override val primaryKey = PrimaryKey(id)
}

object OrderEventsTable : Table("order_events") {
    val id = long("id").autoIncrement()
    val orderId = long("order_id")
    val fromCategory = text("from_category").nullable()
    val toCategory = text("to_category")
    val userId = long("user_id").nullable()
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class OrderLineView(
    val id: Long,
    val title: String,
    val rawSku: String?,
    val quantity: Int,
    val priceMinor: Long,
    val matchedSku: String?,
    val variations: List<EtsyVariation>,
    val personalization: List<EtsyVariation>,
)

@Serializable
data class OrderView(
    val id: Long,
    val platformOrderId: String,
    val category: String,
    val buyerName: String,
    val buyerMessage: String?,
    val totalMinor: Long,
    val currency: String,
    val placedAt: String?,
    val lines: List<OrderLineView>,
)

@Serializable
data class SyncResult(val fetched: Int, val created: Int, val matchedLines: Int, val unmatchedLines: Int)

private const val PERSONALIZATION_PROPERTY_ID = 54L

@SingleIn(AppScope::class)
@Inject
class SyncService(
    private val connections: ConnectionRepository,
    private val materials: MaterialRepository,
    private val products: ProductRepository,
    private val listings: ListingRepository,
) {
    suspend fun syncAll(): Map<Long, SyncResult> =
        connections.connectedIds().associateWith { runCatching { syncConnection(it) }.getOrElse { SyncResult(0, 0, 0, 0) } }

    suspend fun syncConnection(connectionId: Long): SyncResult {
        val since = connections.cursor(connectionId)?.toEpochSecond()
        val receipts = connections.fetchReceipts(connectionId, since) ?: return SyncResult(0, 0, 0, 0)
        var created = 0
        var matched = 0
        var unmatched = 0

        for (receipt in receipts.results) {
            val exists = dbQuery {
                OrdersTable.selectAll()
                    .where { OrdersTable.connectionId eq connectionId }
                    .andWhere { OrdersTable.platformOrderId eq receipt.receiptId.toString() }
                    .any()
            }
            if (exists) continue

            val orderId = dbQuery {
                val oid = OrdersTable.insert {
                    it[OrdersTable.connectionId] = connectionId
                    it[platformOrderId] = receipt.receiptId.toString()
                    it[category] = "new"
                    it[buyerName] = receipt.name
                    it[buyerMessage] = receipt.messageFromBuyer
                    it[totalMinor] = receipt.grandtotal.minor
                    it[currency] = receipt.grandtotal.currencyCode
                    it[placedAt] = OffsetDateTime.ofInstant(Instant.ofEpochSecond(receipt.createdTimestamp), ZoneOffset.UTC)
                } get OrdersTable.id
                OrderEventsTable.insert {
                    it[OrderEventsTable.orderId] = oid
                    it[fromCategory] = null
                    it[toCategory] = "new"
                }
                oid
            }
            created++

            // listingId -> total units, for packaging resolution per order
            val unitsByListing = mutableMapOf<Long, Int>()

            for (txn in receipt.transactions) {
                val configRow = txn.sku?.let { sku ->
                    dbQuery {
                        ListingConfigurationsTable.selectAll()
                            .where { ListingConfigurationsTable.sku eq sku }.singleOrNull()
                    }
                }
                val personalization = txn.variations.filter { it.propertyId == PERSONALIZATION_PROPERTY_ID }
                dbQuery {
                    OrderLinesTable.insert {
                        it[OrderLinesTable.orderId] = orderId
                        it[platformRef] = txn.transactionId.toString()
                        it[rawSku] = txn.sku
                        it[title] = txn.title
                        it[quantity] = txn.quantity
                        it[priceMinor] = txn.price.minor
                        it[variations] = txn.variations.filter { v -> v.propertyId != PERSONALIZATION_PROPERTY_ID }
                        it[OrderLinesTable.personalization] = personalization
                        it[listingConfigurationId] = configRow?.get(ListingConfigurationsTable.id)
                    }
                }
                if (configRow != null) {
                    matched++
                    reserveLine(orderId, receipt.receiptId, configRow, txn.quantity)
                    val listingId = configRow[ListingConfigurationsTable.listingId]
                    unitsByListing[listingId] = (unitsByListing[listingId] ?: 0) + txn.quantity
                } else unmatched++
            }

            // Packaging reservations: one band per listing-group per order (D14).
            for ((listingId, units) in unitsByListing) {
                val listing = listings.get(listingId) ?: continue
                val profileId = listing.input.packagingProfileId ?: continue
                val band = listings.resolvePackaging(profileId, units).band ?: continue
                for (m in band.materials) {
                    materials.recordTransaction(
                        m.materialId, -m.quantity, TxnKind.RESERVATION,
                        "Order #${receipt.receiptId} packaging", null,
                    )
                }
            }
        }
        connections.setCursor(connectionId, OffsetDateTime.now())
        return SyncResult(receipts.results.size, created, matched, unmatched)
    }

    /** Reserve the line's full bill of materials: recipe slots + listing extras. */
    private suspend fun reserveLine(
        orderId: Long,
        receiptId: Long,
        configRow: org.jetbrains.exposed.sql.ResultRow,
        quantity: Int,
    ) {
        val listingId = configRow[ListingConfigurationsTable.listingId]
        val selections = configRow[ListingConfigurationsTable.selections]
        val listing = listings.get(listingId) ?: return
        val product = products.get(listing.input.productId) ?: return
        val note = "Order #$receiptId"

        product.slots.forEachIndexed { idx, slot ->
            val materialId = when (slot.kind) {
                SlotKind.FIXED -> slot.fixedMaterialId
                else -> selections.firstOrNull { it.slotIndex == idx }?.materialId
            } ?: return@forEachIndexed
            materials.recordTransaction(materialId, -(slot.quantity * quantity), TxnKind.RESERVATION, note, null)
        }
        for (extra in listing.input.extras) {
            val qty = if (extra.basis == "per_unit") extra.quantity * quantity else extra.quantity
            materials.recordTransaction(extra.materialId, -qty, TxnKind.RESERVATION, note, null)
        }
    }

    suspend fun listOrders(): List<OrderView> = dbQuery {
        val configSkus = ListingConfigurationsTable.selectAll()
            .associate { it[ListingConfigurationsTable.id] to it[ListingConfigurationsTable.sku] }
        OrdersTable.selectAll().orderBy(OrdersTable.id, org.jetbrains.exposed.sql.SortOrder.DESC).map { o ->
            val oid = o[OrdersTable.id]
            OrderView(
                id = oid,
                platformOrderId = o[OrdersTable.platformOrderId],
                category = o[OrdersTable.category],
                buyerName = o[OrdersTable.buyerName],
                buyerMessage = o[OrdersTable.buyerMessage],
                totalMinor = o[OrdersTable.totalMinor],
                currency = o[OrdersTable.currency],
                placedAt = o[OrdersTable.placedAt]?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                lines = OrderLinesTable.selectAll().where { OrderLinesTable.orderId eq oid }.map { l ->
                    OrderLineView(
                        id = l[OrderLinesTable.id],
                        title = l[OrderLinesTable.title],
                        rawSku = l[OrderLinesTable.rawSku],
                        quantity = l[OrderLinesTable.quantity],
                        priceMinor = l[OrderLinesTable.priceMinor],
                        matchedSku = l[OrderLinesTable.listingConfigurationId]?.let(configSkus::get),
                        variations = l[OrderLinesTable.variations],
                        personalization = l[OrderLinesTable.personalization],
                    )
                },
            )
        }
    }
}
