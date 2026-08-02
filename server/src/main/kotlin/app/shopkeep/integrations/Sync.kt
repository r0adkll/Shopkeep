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
import org.jetbrains.exposed.sql.update
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
    val laneId = long("lane_id").nullable()
    val flagShort = bool("flag_short")
    val flagAdhoc = bool("flag_adhoc")
    val completedAt = timestampWithTimeZone("completed_at").nullable()
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
data class LineColor(val hex: String?, val name: String)

@Serializable
data class OrderLineView(
    val id: Long,
    val title: String,
    val rawSku: String?,
    val quantity: Int,
    val priceMinor: Long,
    val matchedSku: String?,
    val productName: String?,
    val colors: List<LineColor> = emptyList(),
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
    val laneId: Long?,
    val flagShort: Boolean,
    val flagAdhoc: Boolean,
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
    private val lanes: LaneRepository,
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
            var anyPersonalized = false
            var anyUnmatched = false
            var anyShort = false
            var anyAdhoc = false
            var totalUnits = 0

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
                if (personalization.isNotEmpty()) anyPersonalized = true
                totalUnits += txn.quantity
                if (configRow != null) {
                    matched++
                    if (reserveLine(orderId, receipt.receiptId, configRow, txn.quantity)) anyShort = true
                    val listingId = configRow[ListingConfigurationsTable.listingId]
                    unitsByListing[listingId] = (unitsByListing[listingId] ?: 0) + txn.quantity
                } else { unmatched++; anyUnmatched = true }
            }

            // Packaging reservations: one band per listing-group per order (D14).
            for ((listingId, units) in unitsByListing) {
                val listing = listings.get(listingId) ?: continue
                val profileId = listing.input.packagingProfileId ?: continue
                val band = listings.resolvePackaging(profileId, units).band ?: continue
                if (band.kind == "adhoc") anyAdhoc = true
                for (m in band.materials) {
                    materials.recordTransaction(
                        m.materialId, -m.quantity, TxnKind.RESERVATION,
                        "Order #${receipt.receiptId} packaging", null,
                    )
                }
            }

            // Arrival-only routing (locked queue concept) + flags for card chips.
            val platform = dbQuery {
                ConnectionsTable.selectAll().where { ConnectionsTable.id eq connectionId }
                    .single()[ConnectionsTable.platform]
            }
            val laneId = lanes.route(OrderFacts(anyPersonalized, anyShort, anyUnmatched, anyAdhoc, platform, totalUnits))
            val laneName = lanes.list().first { it.id == laneId }.name
            dbQuery {
                OrdersTable.update({ OrdersTable.id eq orderId }) {
                    it[OrdersTable.laneId] = laneId
                    it[flagShort] = anyShort
                    it[flagAdhoc] = anyAdhoc
                }
                if (laneName != "New") OrderEventsTable.insert {
                    it[OrderEventsTable.orderId] = orderId
                    it[fromCategory] = "new"
                    it[toCategory] = laneName
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
    ): Boolean {
        val listingId = configRow[ListingConfigurationsTable.listingId]
        val selections = configRow[ListingConfigurationsTable.selections]
        val listing = listings.get(listingId) ?: return false
        val product = products.get(listing.input.productId) ?: return false
        val note = "Order #$receiptId"
        var short = false

        suspend fun reserve(materialId: Long, qty: Double) {
            materials.recordTransaction(materialId, -qty, TxnKind.RESERVATION, note, null)
            if ((materials.get(materialId)?.stock?.available ?: 0.0) < 0) short = true
        }
        product.slots.forEachIndexed { idx, slot ->
            val materialId = when (slot.kind) {
                SlotKind.FIXED -> slot.fixedMaterialId
                else -> selections.firstOrNull { it.slotIndex == idx }?.materialId
            } ?: return@forEachIndexed
            reserve(materialId, slot.quantity * quantity)
        }
        for (extra in listing.input.extras) {
            reserve(extra.materialId, if (extra.basis == "per_unit") extra.quantity * quantity else extra.quantity)
        }
        return short
    }

    suspend fun listOrders(): List<OrderView> {
        // configId -> (sku, productName, colors)
        val configInfo = dbQuery {
            val listingProduct = ListingsTable.selectAll().associate {
                it[ListingsTable.id] to it[ListingsTable.productId]
            }
            val productNames = app.shopkeep.catalog.ProductsTable.selectAll().associate {
                it[app.shopkeep.catalog.ProductsTable.id] to it[app.shopkeep.catalog.ProductsTable.name]
            }
            ListingConfigurationsTable.selectAll().associate { c ->
                val pname = listingProduct[c[ListingConfigurationsTable.listingId]]?.let(productNames::get)
                c[ListingConfigurationsTable.id] to Triple(
                    c[ListingConfigurationsTable.sku],
                    pname,
                    c[ListingConfigurationsTable.selections].map { s -> LineColor(s.color, s.materialName) },
                )
            }
        }
        return dbQuery {
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
                laneId = o[OrdersTable.laneId],
                flagShort = o[OrdersTable.flagShort],
                flagAdhoc = o[OrdersTable.flagAdhoc],
                lines = OrderLinesTable.selectAll().where { OrderLinesTable.orderId eq oid }.map { l ->
                    OrderLineView(
                        id = l[OrderLinesTable.id],
                        title = l[OrderLinesTable.title],
                        rawSku = l[OrderLinesTable.rawSku],
                        quantity = l[OrderLinesTable.quantity],
                        priceMinor = l[OrderLinesTable.priceMinor],
                        matchedSku = l[OrderLinesTable.listingConfigurationId]?.let { configInfo[it]?.first },
                        productName = l[OrderLinesTable.listingConfigurationId]?.let { configInfo[it]?.second },
                        colors = l[OrderLinesTable.listingConfigurationId]?.let { configInfo[it]?.third } ?: emptyList(),
                        variations = l[OrderLinesTable.variations],
                        personalization = l[OrderLinesTable.personalization],
                    )
                },
            )
        }
    }
    }
}
