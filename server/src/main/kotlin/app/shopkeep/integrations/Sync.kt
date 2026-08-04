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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.andWhere
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.insertIgnore
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
    val shipName = text("ship_name").nullable()
    val shipLine1 = text("ship_line1").nullable()
    val shipLine2 = text("ship_line2").nullable()
    val shipCity = text("ship_city").nullable()
    val shipState = text("ship_state").nullable()
    val shipZip = text("ship_zip").nullable()
    val shipCountry = text("ship_country").nullable()
    val paymentMethod = text("payment_method").nullable()
    val isGift = bool("is_gift")
    val giftMessage = text("gift_message").nullable()
    val giftSender = text("gift_sender").nullable()
    val subtotalMinor = long("subtotal_minor").nullable()
    val shippingMinor = long("shipping_minor").nullable()
    val taxMinor = long("tax_minor").nullable()
    val discountMinor = long("discount_minor").nullable()
    val feesMinor = long("fees_minor").nullable()
    val platformPaid = bool("platform_paid")
    val platformShipped = bool("platform_shipped")
    val platformStatus = text("platform_status")
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
    val platformListingId = text("platform_listing_id").nullable()
    val matchedListingId = long("matched_listing_id").nullable()
    val resolvedSelections = jsonb<List<app.shopkeep.catalog.ConfigSelection>>("resolved_selections", Json.Default).nullable()
    val needsReview = bool("needs_review")
    val reviewReasons = jsonb<List<String>>("review_reasons", Json.Default)
    val reservedBom = jsonb<List<BomLine>>("reserved_bom", Json.Default).nullable()
    override val primaryKey = PrimaryKey(id)
}

/** Mirror of Etsy's payment-account ledger — real money events (labels,
 *  fees, ads). shipping_transaction entries reference receipts directly;
 *  shipping_labels carry actual postage but join to nothing (vault: Etsy
 *  Integration) so they feed shop-level spend, not per-order lines. */
object PlatformLedgerTable : Table("platform_ledger_entries") {
    val entryId = long("entry_id")
    val connectionId = long("connection_id")
    val ledgerType = text("ledger_type")
    val referenceType = text("reference_type").nullable()
    val referenceId = text("reference_id").nullable()
    val amountMinor = long("amount_minor")
    val currency = text("currency")
    val createdAt = timestampWithTimeZone("created_at").nullable()
    override val primaryKey = PrimaryKey(entryId)
}

/** Remembered manual matches: platform listing id -> canonical listing. */
object ListingMatchesTable : Table("listing_matches") {
    val platformListingId = text("platform_listing_id")
    val listingId = long("listing_id")
    override val primaryKey = PrimaryKey(platformListingId)
}

object OrderEventsTable : Table("order_events") {
    val id = long("id").autoIncrement()
    val orderId = long("order_id")
    val fromCategory = text("from_category").nullable()
    val toCategory = text("to_category")
    val userId = long("user_id").nullable()
    val createdAt = timestampWithTimeZone("created_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

object OrderNotesTable : Table("order_notes") {
    val id = long("id").autoIncrement()
    val orderId = long("order_id")
    val userId = long("user_id").nullable()
    val body = text("body")
    val documentIds = jsonb<List<Long>>("document_ids", Json.Default)
    val createdAt = timestampWithTimeZone("created_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class BomLine(val materialId: Long, val qty: Double)

@Serializable
data class MatchLineResult(val ok: Boolean, val sweptSiblings: Int, val error: String? = null)

@Serializable
data class RematchResult(val backfilled: Int, val matched: Int)

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
    val matchedListing: Boolean = false,
    val matchedListingId: Long? = null, // canonical listing behind either match path
    val needsReview: Boolean = false,
    val reviewReasons: List<String> = emptyList(),
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
    val platformStatus: String,
    val lines: List<OrderLineView>,
)

@Serializable
data class OrderMaterialView(
    val materialId: Long,
    val name: String,
    val colorHex: String?,
    val quantity: Double,
    val unit: String,
    val packaging: Boolean,
    val status: String, // reserved | short | consumed
    val availableNow: Double? = null,
)

@Serializable
data class OrderEventView(val from: String?, val to: String, val author: String?, val at: String?)

@Serializable
data class OrderNoteView(
    val id: Long,
    val author: String,
    val body: String,
    val documentIds: List<Long>,
    val at: String?,
)

@Serializable
data class OrderDetail(
    val order: OrderView,
    val shipFeesMinor: Long? = null, // exact: receipt-linked shipping_transaction ledger entries
    val shipEstimateMinor: Long? = null, // estimate: USPS quote or packaging profile's expected postage
    val shipEstimateSource: String? = null, // usps | profile
    val shipName: String?,
    val shipLine1: String?,
    val shipLine2: String?,
    val shipCity: String?,
    val shipState: String?,
    val shipZip: String?,
    val shipCountry: String?,
    val paymentMethod: String?,
    val isGift: Boolean,
    val giftMessage: String?,
    val giftSender: String?,
    val subtotalMinor: Long?,
    val shippingMinor: Long?,
    val taxMinor: Long?,
    val discountMinor: Long?,
    val feesMinor: Long?,
    val platformPaid: Boolean,
    val platformShipped: Boolean,
    val completedAt: String?,
    val materialsCostMinor: Long?,
    val laborMinor: Long?,
    val materials: List<OrderMaterialView>,
    val events: List<OrderEventView>,
    val notes: List<OrderNoteView>,
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
    private val designs: app.shopkeep.catalog.DesignRepository,
    private val push: PushService,
) {
    // One sync at a time: the background poller and a manual Sync-now racing
    // each other produced duplicate-key 500s on the first real ingest.
    private val syncMutex = Mutex()

    suspend fun syncAll(): Map<Long, SyncResult> {
        val results = connections.connectedIds().associateWith {
            runCatching { syncConnection(it) }.getOrElse { SyncResult(0, 0, 0, 0) }
        }
        // Listing drift check rides the same poll cadence (one fetch per shop).
        results.keys.forEach { runCatching { push.refreshSyncStates(it) } }
        return results
    }

    suspend fun syncConnection(connectionId: Long): SyncResult = syncMutex.withLock {
        syncConnectionLocked(connectionId)
    }

    private suspend fun syncConnectionLocked(connectionId: Long): SyncResult {
        val since = connections.cursor(connectionId)?.toEpochSecond()
        val receipts = connections.fetchReceipts(connectionId, since) ?: return SyncResult(0, 0, 0, 0)
        var created = 0
        var matched = 0
        var unmatched = 0

        val deadStatuses = setOf("canceled", "fully refunded")
        for (receipt in receipts.results) {
            val existing = dbQuery {
                OrdersTable.selectAll()
                    .where { OrdersTable.connectionId eq connectionId }
                    .andWhere { OrdersTable.platformOrderId eq receipt.receiptId.toString() }
                    .singleOrNull()
            }
            if (existing != null) {
                applyStatusUpdate(existing, receipt, deadStatuses)
                continue
            }
            // Already dead on Etsy: never enters the queue at all.
            if (receipt.status.lowercase() in deadStatuses) continue

            val orderId = dbQuery {
                // insertIgnore: cross-process races (second app instance, poller
                // overlap) degrade to a skip instead of a duplicate-key error.
                val oid = OrdersTable.insertIgnore {
                    it[OrdersTable.connectionId] = connectionId
                    it[platformOrderId] = receipt.receiptId.toString()
                    it[category] = "new"
                    it[buyerName] = receipt.name
                    it[buyerMessage] = receipt.messageFromBuyer
                    it[totalMinor] = receipt.grandtotal.minor
                    it[currency] = receipt.grandtotal.currencyCode
                    it[placedAt] = OffsetDateTime.ofInstant(Instant.ofEpochSecond(receipt.createdTimestamp), ZoneOffset.UTC)
                    it[shipName] = receipt.name.takeIf { s -> s.isNotBlank() }
                    it[shipLine1] = receipt.firstLine
                    it[shipLine2] = receipt.secondLine
                    it[shipCity] = receipt.city
                    it[shipState] = receipt.state
                    it[shipZip] = receipt.zip
                    it[shipCountry] = receipt.countryIso
                    it[paymentMethod] = receipt.paymentMethod
                    it[isGift] = receipt.isGift
                    it[giftMessage] = receipt.giftMessage
                    it[giftSender] = receipt.giftSender
                    it[subtotalMinor] = receipt.subtotal?.minor
                    it[shippingMinor] = receipt.totalShippingCost?.minor
                    it[taxMinor] = receipt.totalTaxCost?.minor
                    it[discountMinor] = receipt.discountAmt?.minor
                    it[platformPaid] = receipt.isPaid
                    it[platformShipped] = receipt.isShipped
                    it[platformStatus] = receipt.status.lowercase()
                }.resultedValues?.singleOrNull()?.get(OrdersTable.id)
                if (oid != null) OrderEventsTable.insert {
                    it[OrderEventsTable.orderId] = oid
                    it[fromCategory] = null
                    it[toCategory] = "new"
                }
                oid
            } ?: continue
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
                // Imported-listing match (D17): Etsy listing id -> mapped materials.
                val imported = if (configRow == null) resolveImportedLine(txn) else null
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
                        it[platformListingId] = txn.listingId?.toString()
                        it[matchedListingId] = imported?.listingId
                        it[resolvedSelections] = imported?.selections
                        it[needsReview] = imported?.needsReview ?: false
                        it[reviewReasons] = imported?.reasons ?: emptyList()
                        it[reservedBom] = imported?.bom?.map { (m, q) -> BomLine(m, q) }
                    }
                }
                if (personalization.isNotEmpty()) anyPersonalized = true
                totalUnits += txn.quantity
                if (configRow != null) {
                    matched++
                    if (reserveLine(orderId, receipt.receiptId, configRow, txn.quantity)) anyShort = true
                    val listingId = configRow[ListingConfigurationsTable.listingId]
                    unitsByListing[listingId] = (unitsByListing[listingId] ?: 0) + txn.quantity
                } else if (imported != null) {
                    matched++
                    if (reserveResolved(imported, txn.quantity, "Order #${receipt.receiptId}")) anyShort = true
                    unitsByListing[imported.listingId] = (unitsByListing[imported.listingId] ?: 0) + txn.quantity
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

            // Real processing fees from the payments API (concept: net profit).
            connections.fetchPaymentFees(connectionId, receipt.receiptId)?.let { fees ->
                dbQuery { OrdersTable.update({ OrdersTable.id eq orderId }) { it[feesMinor] = fees } }
            }
        }
        connections.setCursor(connectionId, OffsetDateTime.now())
        // Money-side mirror rides every poll (labels, fees, ads — Stats fuel).
        runCatching { ingestLedger(connectionId) }
        return SyncResult(receipts.results.size, created, matched, unmatched)
    }

    /** Status echo for orders we already track: cancellation releases the
     *  reservations and hides the order; Etsy-side shipping auto-completes
     *  (vault: label purchase on Etsy echoes back). */
    private suspend fun applyStatusUpdate(
        existing: org.jetbrains.exposed.sql.ResultRow,
        receipt: EtsyReceipt,
        deadStatuses: Set<String>,
    ) {
        val orderId = existing[OrdersTable.id]
        val prevStatus = existing[OrdersTable.platformStatus]
        val prevShipped = existing[OrdersTable.platformShipped]
        val newStatus = receipt.status.lowercase()
        if (prevStatus == newStatus && prevShipped == receipt.isShipped) return

        dbQuery {
            OrdersTable.update({ OrdersTable.id eq orderId }) {
                it[platformStatus] = newStatus
                it[platformPaid] = receipt.isPaid
                it[platformShipped] = receipt.isShipped
            }
        }
        val nowDead = newStatus in deadStatuses && prevStatus !in deadStatuses
        if (nowDead && existing[OrdersTable.completedAt] == null) {
            releaseReservations(existing[OrdersTable.platformOrderId])
            dbQuery {
                OrderEventsTable.insert {
                    it[OrderEventsTable.orderId] = orderId
                    it[fromCategory] = null
                    it[toCategory] = "canceled on Etsy — reservations released"
                }
            }
        } else if (receipt.isShipped && !prevShipped && existing[OrdersTable.completedAt] == null &&
            newStatus !in deadStatuses
        ) {
            lanes.move(orderId, lanes.doneLaneId(), null)
        }
    }

    /** Ledger ingestion: idempotent by entry_id; resumes from the newest
     *  stored entry (first run backfills one 31-day window, Etsy's max). */
    suspend fun ingestLedger(connectionId: Long) {
        val now = Instant.now().epochSecond
        val newest = dbQuery {
            PlatformLedgerTable.selectAll()
                .where { PlatformLedgerTable.connectionId eq connectionId }
                .maxOfOrNull { it[PlatformLedgerTable.createdAt]?.toEpochSecond() ?: 0L }
        } ?: 0L
        val min = maxOf(newest - 3600, now - 2_678_000)
        val entries = connections.fetchLedgerEntries(connectionId, min, now) ?: return
        dbQuery {
            for (e in entries) {
                PlatformLedgerTable.insertIgnore {
                    it[entryId] = e.entryId
                    it[PlatformLedgerTable.connectionId] = connectionId
                    it[ledgerType] = e.ledgerType
                    it[referenceType] = e.referenceType
                    it[referenceId] = e.referenceId?.toString()
                    it[amountMinor] = e.amount
                    it[currency] = e.currency
                    it[createdAt] = OffsetDateTime.ofInstant(Instant.ofEpochSecond(e.createdTimestamp), ZoneOffset.UTC)
                }
            }
        }
    }

    /** Cancellation: outstanding reservations come back (lifecycle invariant #3). */
    private suspend fun releaseReservations(platformOrderId: String) = dbQuery {
        val note = "Order #$platformOrderId"
        app.shopkeep.inventory.InventoryTransactionsTable.selectAll()
            .where { app.shopkeep.inventory.InventoryTransactionsTable.kind eq "reservation" }
            .andWhere { app.shopkeep.inventory.InventoryTransactionsTable.note like "$note%" }
            .forEach { txn ->
                app.shopkeep.inventory.InventoryTransactionsTable.insert {
                    it[materialId] = txn[app.shopkeep.inventory.InventoryTransactionsTable.materialId]
                    it[delta] = txn[app.shopkeep.inventory.InventoryTransactionsTable.delta].negate()
                    it[kind] = TxnKind.RELEASE.name.lowercase()
                    it[app.shopkeep.inventory.InventoryTransactionsTable.note] = "$note (canceled)"
                }
            }
    }

    data class ImportedResolution(
        val listingId: Long,
        val productId: Long,
        val selections: List<app.shopkeep.catalog.ConfigSelection>,
        val needsReview: Boolean,
        /** Human-readable causes behind needsReview — shown on the order line. */
        val reasons: List<String> = emptyList(),
        /** Fully-expanded BOM (materialId -> qty per unit): choice slots via
         *  material/design resolution (incl. qty overrides + override sets),
         *  fixed slots, variant slot-deltas and extra materials. */
        val bom: List<Pair<Long, Double>>,
    )

    /** Etsy listing id -> Shopkeep listing (listing_level mode) -> variation
     *  values -> materials via platform_value. Values with no mapping (review /
     *  ignore / unknown) leave a gap and flag the line for review. */
    private suspend fun resolveImportedLine(txn: EtsyTransaction): ImportedResolution? {
        val etsyId = txn.listingId?.toString() ?: return null
        val targetId = resolvableListingId(etsyId) ?: return null
        val listing = listings.get(targetId) ?: return null
        return resolveWithListing(listing, txn)
    }

    /** Which canonical listing handles this platform listing id, if any —
     *  direct etsy link first, then a remembered manual match. */
    private suspend fun resolvableListingId(etsyId: String): Long? = dbQuery {
        ListingsTable.selectAll().where { ListingsTable.etsyListingId eq etsyId }.singleOrNull()
            ?.get(ListingsTable.id)
            ?: ListingMatchesTable.selectAll().where { ListingMatchesTable.platformListingId eq etsyId }.singleOrNull()
                ?.get(ListingMatchesTable.listingId)
    }

    /** Resolve a line against a specific listing (manual match bypasses lookup). */
    suspend fun resolveWithListing(listing: app.shopkeep.listings.Listing, txn: EtsyTransaction): ImportedResolution? {
        val product = products.get(listing.input.productId) ?: return null
        val reasons = mutableListOf<String>()
        val selections = mutableListOf<app.shopkeep.catalog.ConfigSelection>()
        val bom = mutableMapOf<Long, Double>()
        fun addBom(materialId: Long, qty: Double) { bom[materialId] = (bom[materialId] ?: 0.0) + qty }
        val orderValues = txn.variations.filter { it.propertyId != PERSONALIZATION_PROPERTY_ID }
        val resolutions = listing.input.valueResolutions
        var variantAdj: app.shopkeep.catalog.VariantAdjustments? = null
        val slotQty = { pos: Int -> product.slots.getOrNull(pos)?.quantity ?: 0.0 }

        suspend fun addSelection(slotPos: Int, materialId: Long, qty: Double) {
            val mat = materials.get(materialId) ?: return
            addBom(materialId, qty)
            selections += app.shopkeep.catalog.ConfigSelection(
                slotIndex = slotPos,
                slotName = product.slots.getOrNull(slotPos)?.name ?: "slot $slotPos",
                materialId = mat.id, materialName = mat.name, color = mat.attributes["color"],
            )
        }

        // Pass 1: match each axis; collect designs to expand, a variant, and
        // any EXPLICIT override-set bind (authored axis-2, label-rename-safe).
        val pendingDesigns = mutableListOf<Long>()
        var boundOverrideKey: String? = null
        for (axis in listing.input.axes) {
            val varVal = orderValues.firstOrNull { it.name.equals(axis.displayName, ignoreCase = true) }?.value
            if (varVal == null) { reasons += "Etsy sent no value for axis “${axis.displayName}”"; continue }
            // axis value rows match by Etsy platform value or the buyer-facing label
            val hit = axis.values.firstOrNull {
                it.platformValue.equals(varVal, ignoreCase = true) || it.displayLabel.equals(varVal, ignoreCase = true)
            }
            if (hit != null) {
                when {
                    hit.overrideKey != null -> if (hit.overrideKey != "base") boundOverrideKey = hit.overrideKey
                    hit.variantId != null -> {
                        val v = designs.variant(hit.variantId!!)
                        if (v == null) reasons += "the variant behind “$varVal” no longer exists" else variantAdj = v.adjustments
                    }
                    hit.designId != null -> pendingDesigns += hit.designId!!
                    hit.materialId != null -> addSelection(axis.productSlotPosition, hit.materialId!!, slotQty(axis.productSlotPosition))
                    else -> reasons += "“$varVal” (${axis.displayName}) has no material/design/variant source on the listing"
                }
                continue
            }
            // imported-listing path: value_resolutions by axis+value
            val res = resolutions.firstOrNull { it.axis.equals(axis.displayName, true) && it.value.equals(varVal, true) }
            when (res?.kind) {
                "design" -> res.refId?.let { pendingDesigns += it } ?: run { reasons += "the design behind “$varVal” isn’t set" }
                "variant" -> {
                    val v = res.refId?.let { designs.variant(it) }
                    if (v == null) reasons += "the variant behind “$varVal” no longer exists" else variantAdj = v.adjustments
                }
                "ignore" -> {}
                "review" -> reasons += "“$varVal” (${axis.displayName}) is set to review-per-order — pick its materials by hand"
                else -> reasons += "“$varVal” (${axis.displayName}) is unmapped on the listing"
            }
        }
        // Pass 2: expand designs — explicit bind wins; else name-match any
        // order value against override-set keys (imported listings).
        for (designId in pendingDesigns) {
            val d = designs.design(designId)
            if (d == null) { reasons += "a mapped design was deleted from the product"; continue }
            val set = boundOverrideKey?.let { k -> d.overrideSets.firstOrNull { it.key.equals(k, true) } }
                ?: d.overrideSets.firstOrNull { os -> orderValues.any { it.value.equals(os.key, ignoreCase = true) } }
            for (a in (set?.assignments ?: d.assignments)) {
                addSelection(a.slotPosition, a.materialId, a.qtyOverride ?: slotQty(a.slotPosition))
            }
        }
        // resolutions can also live on non-slot axes (e.g. a style axis mapped to variants)
        for (res in resolutions) {
            if (res.kind != "variant" || variantAdj != null) continue
            if (orderValues.any { it.name.equals(res.axis, true) && it.value.equals(res.value, true) }) {
                val v = res.refId?.let { designs.variant(it) }
                if (v != null) variantAdj = v.adjustments else reasons += "the variant behind “${res.value}” no longer exists"
            }
        }
        // fixed slots
        product.slots.forEach { slot ->
            if (slot.kind == SlotKind.FIXED && slot.fixedMaterialId != null) addBom(slot.fixedMaterialId!!, slot.quantity)
        }
        // variant adjustments: slot deltas apply to whatever material filled the slot
        variantAdj?.let { adj ->
            adj.slotDeltas.forEach { d ->
                val target = selections.firstOrNull { it.slotIndex == d.slotPosition }?.materialId
                    ?: product.slots.getOrNull(d.slotPosition)?.fixedMaterialId
                if (target != null) {
                    if (d.removed) bom[target] = ((bom[target] ?: 0.0) - slotQty(d.slotPosition)).coerceAtLeast(0.0)
                    else if (d.deltaQty != null) bom[target] = ((bom[target] ?: 0.0) + d.deltaQty).coerceAtLeast(0.0)
                }
            }
            adj.extras.forEach { e -> addBom(e.materialId, e.quantity) }
        }
        return ImportedResolution(
            listing.id, listing.input.productId, selections, reasons.isNotEmpty(), reasons,
            bom.filterValues { it > 0 }.toList(),
        )
    }

    /** Reserve a dynamically-resolved line from its fully-expanded BOM. */
    private suspend fun reserveResolved(r: ImportedResolution, quantity: Int, note: String): Boolean {
        var short = false
        for ((materialId, qty) in r.bom) {
            materials.recordTransaction(materialId, -qty * quantity, TxnKind.RESERVATION, note, null)
            if ((materials.get(materialId)?.stock?.available ?: 0.0) < 0) short = true
        }
        return short
    }

    /** Activation hook: resolve waiting unmatched lines for this listing. */
    suspend fun retroMatch(listingId: Long, etsyListingId: String): Int {
        var count = 0
        val lines = dbQuery {
            OrderLinesTable.selectAll()
                .where { OrderLinesTable.platformListingId eq etsyListingId }
                .andWhere { OrderLinesTable.matchedListingId.isNull() }
                .andWhere { OrderLinesTable.listingConfigurationId.isNull() }
                .toList()
        }
        for (l in lines) {
            val txn = EtsyTransaction(
                listingId = etsyListingId.toLong(),
                quantity = l[OrderLinesTable.quantity],
                variations = l[OrderLinesTable.variations] + l[OrderLinesTable.personalization],
            )
            val r = resolveImportedLine(txn) ?: continue
            applyResolution(l, r, "matched via imported listing")
            count++
        }
        return count
    }

    /** Shared tail of every match path: reserve (live orders only), stamp the
     *  line, flag shortfalls, leave an event. */
    private suspend fun applyResolution(l: org.jetbrains.exposed.sql.ResultRow, r: ImportedResolution, how: String) {
        val order = dbQuery {
            OrdersTable.selectAll().where { OrdersTable.id eq l[OrderLinesTable.orderId] }.single()
        }
        // Skip dead/completed orders: nothing to reserve anymore.
        val dead = order[OrdersTable.platformStatus] in setOf("canceled", "fully refunded")
        val short = if (!dead && order[OrdersTable.completedAt] == null) {
            reserveResolved(r, l[OrderLinesTable.quantity], "Order #${order[OrdersTable.platformOrderId]}")
        } else false
        dbQuery {
            OrderLinesTable.update({ OrderLinesTable.id eq l[OrderLinesTable.id] }) {
                it[matchedListingId] = r.listingId
                it[resolvedSelections] = r.selections
                it[needsReview] = r.needsReview
                it[reviewReasons] = r.reasons
                it[reservedBom] = if (!dead && order[OrdersTable.completedAt] == null) r.bom.map { (m, q) -> BomLine(m, q) } else null
            }
            val stillUnmatched = OrderLinesTable.selectAll()
                .where { OrderLinesTable.orderId eq order[OrdersTable.id] }
                .any { row -> row[OrderLinesTable.listingConfigurationId] == null && row[OrderLinesTable.matchedListingId] == null }
            if (short) {
                OrdersTable.update({ OrdersTable.id eq order[OrdersTable.id] }) { it[flagShort] = true }
            }
            OrderEventsTable.insert {
                it[OrderEventsTable.orderId] = order[OrdersTable.id]
                it[fromCategory] = null
                it[toCategory] = if (stillUnmatched) "line $how" else "$how — materials reserved"
            }
        }
    }

    /** Manual match: resolve one line against a chosen listing; optionally
     *  remember platform listing id -> listing and sweep siblings. */
    suspend fun matchLine(lineId: Long, listingId: Long, remember: Boolean): MatchLineResult? {
        val l = dbQuery {
            OrderLinesTable.selectAll().where { OrderLinesTable.id eq lineId }.singleOrNull()
        } ?: return null
        if (l[OrderLinesTable.matchedListingId] != null || l[OrderLinesTable.listingConfigurationId] != null) {
            return MatchLineResult(false, 0, "Line is already matched.")
        }
        val listing = listings.get(listingId) ?: return null
        val txn = EtsyTransaction(
            listingId = null,
            quantity = l[OrderLinesTable.quantity],
            variations = l[OrderLinesTable.variations] + l[OrderLinesTable.personalization],
        )
        val r = resolveWithListing(listing, txn) ?: return MatchLineResult(false, 0, "That listing's product couldn't be loaded.")
        applyResolution(l, r, "matched manually")
        var swept = 0
        val pid = l[OrderLinesTable.platformListingId]
        if (remember && pid != null) {
            dbQuery {
                ListingMatchesTable.deleteWhere { ListingMatchesTable.platformListingId eq pid }
                ListingMatchesTable.insert {
                    it[platformListingId] = pid
                    it[ListingMatchesTable.listingId] = listingId
                }
            }
            // sibling lines from the same platform listing now resolve too
            swept = retroMatch(listingId, pid)
        }
        return MatchLineResult(true, swept, null)
    }

    /** Re-resolve an already-matched line against its listing's CURRENT
     *  mappings (after the owner fixes designs/values): release exactly what
     *  the line reserved, resolve fresh, reserve anew. */
    suspend fun reresolveLine(lineId: Long): MatchLineResult? {
        val l = dbQuery {
            OrderLinesTable.selectAll().where { OrderLinesTable.id eq lineId }.singleOrNull()
        } ?: return null
        val targetId = l[OrderLinesTable.matchedListingId]
            ?: return MatchLineResult(false, 0, "Line isn't matched via a listing.")
        val listing = listings.get(targetId) ?: return MatchLineResult(false, 0, "Listing not found.")
        val order = dbQuery {
            OrdersTable.selectAll().where { OrdersTable.id eq l[OrderLinesTable.orderId] }.single()
        }
        val alive = order[OrdersTable.platformStatus] !in setOf("canceled", "fully refunded") &&
            order[OrdersTable.completedAt] == null
        if (alive) {
            val note = "Order #${order[OrdersTable.platformOrderId]}"
            val oldBom = l[OrderLinesTable.reservedBom]
            if (oldBom != null) {
                for (b in oldBom) {
                    materials.recordTransaction(b.materialId, b.qty * l[OrderLinesTable.quantity], TxnKind.RELEASE, "$note (re-resolve)", null)
                }
            } else {
                // pre-BOM-tracking line: only safe to net out the order's
                // reservations when this is its sole matched line
                val siblings = dbQuery {
                    OrderLinesTable.selectAll().where { OrderLinesTable.orderId eq order[OrdersTable.id] }
                        .count { it[OrderLinesTable.id] != lineId && (it[OrderLinesTable.matchedListingId] != null || it[OrderLinesTable.listingConfigurationId] != null) }
                }
                if (siblings > 0) return MatchLineResult(false, 0, "Can't safely release this line's old reservations (other matched lines predate BOM tracking).")
                dbQuery {
                    app.shopkeep.inventory.InventoryTransactionsTable.selectAll()
                        .where { app.shopkeep.inventory.InventoryTransactionsTable.note eq note }
                        .groupBy { it[app.shopkeep.inventory.InventoryTransactionsTable.materialId] }
                        .mapValues { (_, txns) -> txns.sumOf { it[app.shopkeep.inventory.InventoryTransactionsTable.delta].toDouble() } }
                        .filterValues { it < 0 }
                } .forEach { (matId, net) ->
                    materials.recordTransaction(matId, -net, TxnKind.RELEASE, "$note (re-resolve)", null)
                }
            }
        }
        val txn = EtsyTransaction(
            listingId = null,
            quantity = l[OrderLinesTable.quantity],
            variations = l[OrderLinesTable.variations] + l[OrderLinesTable.personalization],
        )
        val r = resolveWithListing(listing, txn) ?: return MatchLineResult(false, 0, "The listing's product couldn't be loaded.")
        applyResolution(l, r, "re-resolved from the listing's current mappings")
        return MatchLineResult(true, 0, null)
    }

    /** Re-run matching on demand: backfill platform listing ids that early
     *  ingests never stamped (from the Etsy receipt), then retro-match every
     *  unmatched line whose platform listing resolves to a canonical listing. */
    suspend fun rematchAll(): RematchResult {
        var backfilled = 0
        val missing = dbQuery {
            OrderLinesTable.selectAll()
                .where { OrderLinesTable.platformListingId.isNull() }
                .andWhere { OrderLinesTable.matchedListingId.isNull() }
                .andWhere { OrderLinesTable.listingConfigurationId.isNull() }
                .map { Triple(it[OrderLinesTable.id], it[OrderLinesTable.orderId], it[OrderLinesTable.platformRef]) }
        }
        val orderInfo = missing.map { it.second }.distinct().associateWith { oid ->
            dbQuery {
                OrdersTable.selectAll().where { OrdersTable.id eq oid }.singleOrNull()
                    ?.let { it[OrdersTable.connectionId] to it[OrdersTable.platformOrderId] }
            }
        }
        val receipts = mutableMapOf<Long, EtsyReceipt?>()
        for ((lineId, oid, ref) in missing) {
            val (connId, receiptId) = orderInfo[oid] ?: continue
            val receipt = receipts.getOrPut(oid) { connections.fetchReceipt(connId, receiptId) } ?: continue
            val txn = receipt.transactions.firstOrNull { it.transactionId.toString() == ref } ?: continue
            val pid = txn.listingId?.toString() ?: continue
            dbQuery { OrderLinesTable.update({ OrderLinesTable.id eq lineId }) { it[platformListingId] = pid } }
            backfilled++
        }
        var matched = 0
        val pids = dbQuery {
            OrderLinesTable.selectAll()
                .where { OrderLinesTable.platformListingId.isNotNull() }
                .andWhere { OrderLinesTable.matchedListingId.isNull() }
                .andWhere { OrderLinesTable.listingConfigurationId.isNull() }
                .mapNotNull { it[OrderLinesTable.platformListingId] }.distinct()
        }
        for (pid in pids) {
            val target = resolvableListingId(pid) ?: continue
            matched += retroMatch(target, pid)
        }
        return RematchResult(backfilled, matched)
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
        // configId -> (sku, productName, colors); listingId -> productName
        var listingProductNames = mapOf<Long, String>()
        var configListing = mapOf<Long, Long>()
        val configInfo = dbQuery {
            val listingProduct = ListingsTable.selectAll().associate {
                it[ListingsTable.id] to it[ListingsTable.productId]
            }
            val productNames = app.shopkeep.catalog.ProductsTable.selectAll().associate {
                it[app.shopkeep.catalog.ProductsTable.id] to it[app.shopkeep.catalog.ProductsTable.name]
            }
            listingProductNames = listingProduct.mapNotNull { (lid, pid) ->
                productNames[pid]?.let { lid to it }
            }.toMap()
            configListing = ListingConfigurationsTable.selectAll().associate {
                it[ListingConfigurationsTable.id] to it[ListingConfigurationsTable.listingId]
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
                platformStatus = o[OrdersTable.platformStatus],
                lines = OrderLinesTable.selectAll().where { OrderLinesTable.orderId eq oid }.map { l ->
                    OrderLineView(
                        id = l[OrderLinesTable.id],
                        title = l[OrderLinesTable.title],
                        rawSku = l[OrderLinesTable.rawSku],
                        quantity = l[OrderLinesTable.quantity],
                        priceMinor = l[OrderLinesTable.priceMinor],
                        matchedSku = l[OrderLinesTable.listingConfigurationId]?.let { configInfo[it]?.first },
                        matchedListing = l[OrderLinesTable.matchedListingId] != null,
                        matchedListingId = l[OrderLinesTable.matchedListingId]
                            ?: l[OrderLinesTable.listingConfigurationId]?.let(configListing::get),
                        needsReview = l[OrderLinesTable.needsReview],
                        reviewReasons = l[OrderLinesTable.reviewReasons],
                        productName = l[OrderLinesTable.listingConfigurationId]?.let { configInfo[it]?.second }
                            ?: l[OrderLinesTable.matchedListingId]?.let(listingProductNames::get),
                        colors = l[OrderLinesTable.listingConfigurationId]?.let { configInfo[it]?.third }
                            ?: l[OrderLinesTable.resolvedSelections]?.map { s -> LineColor(s.color, s.materialName) }
                            ?: emptyList(),
                        variations = l[OrderLinesTable.variations],
                        personalization = l[OrderLinesTable.personalization],
                    )
                },
            )
        }
    }
    }

    /** Everything the order detail panel shows (locked concept, 2026-08-02). */
    suspend fun orderDetail(orderId: Long): OrderDetail? {
        val summary = listOrders().firstOrNull { it.id == orderId } ?: return null
        val o = dbQuery { OrdersTable.selectAll().where { OrdersTable.id eq orderId }.singleOrNull() } ?: return null
        val completed = o[OrdersTable.completedAt] != null
        val notePrefix = "Order #${o[OrdersTable.platformOrderId]}"

        // The order's reserved BOM straight from the ledger, priced with material costs.
        var matsCost = 0.0
        val mats = dbQuery {
            app.shopkeep.inventory.InventoryTransactionsTable
                .join(
                    app.shopkeep.inventory.MaterialsTable,
                    org.jetbrains.exposed.sql.JoinType.INNER,
                    onColumn = app.shopkeep.inventory.InventoryTransactionsTable.materialId,
                    otherColumn = app.shopkeep.inventory.MaterialsTable.id,
                )
                .selectAll()
                .where { app.shopkeep.inventory.InventoryTransactionsTable.kind eq "reservation" }
                .andWhere { app.shopkeep.inventory.InventoryTransactionsTable.note like "$notePrefix%" }
                .map { r ->
                    val qty = -r[app.shopkeep.inventory.InventoryTransactionsTable.delta].toDouble()
                    val costQty = r[app.shopkeep.inventory.MaterialsTable.costQuantity].toDouble()
                    if (costQty > 0) matsCost += qty * r[app.shopkeep.inventory.MaterialsTable.costMinor] / costQty
                    Triple(
                        r[app.shopkeep.inventory.MaterialsTable.id],
                        OrderMaterialView(
                            materialId = r[app.shopkeep.inventory.MaterialsTable.id],
                            name = r[app.shopkeep.inventory.MaterialsTable.name],
                            colorHex = r[app.shopkeep.inventory.MaterialsTable.attributes]["color"],
                            quantity = qty,
                            unit = r[app.shopkeep.inventory.MaterialsTable.unit],
                            packaging = (r[app.shopkeep.inventory.InventoryTransactionsTable.note] ?: "").endsWith("packaging"),
                            status = if (completed) "consumed" else "reserved",
                        ),
                        qty,
                    )
                }
        }
        // Collapse duplicate materials (recipe + extras can hit the same spool).
        val materialRows = mats.groupBy { it.first }.map { (_, rows) ->
            rows.first().second.copy(quantity = rows.sumOf { it.third })
        }.map { row ->
            if (row.status == "reserved") {
                val avail = materials.get(row.materialId)?.stock?.available
                if (avail != null && avail < 0) row.copy(status = "short", availableNow = avail) else row
            } else row
        }

        // Labor: matched lines' product labor at the global rate (recipe builder math).
        val rate = products.laborRateMinor()
        var laborMinutes = 0
        dbQuery {
            OrderLinesTable.selectAll().where { OrderLinesTable.orderId eq orderId }.toList()
        }.forEach { l ->
            val configId = l[OrderLinesTable.listingConfigurationId]
            val listingId = configId?.let { c ->
                dbQuery {
                    ListingConfigurationsTable.selectAll().where { ListingConfigurationsTable.id eq c }
                        .singleOrNull()?.get(ListingConfigurationsTable.listingId)
                }
            } ?: l[OrderLinesTable.matchedListingId] ?: return@forEach
            val productId = listings.get(listingId)?.input?.productId ?: return@forEach
            val minutes = products.get(productId)?.laborMinutes ?: 0
            laborMinutes += minutes * l[OrderLinesTable.quantity]
        }
        val laborMinor = if (rate > 0) laborMinutes * rate / 60 else 0

        val users = dbQuery {
            app.shopkeep.auth.UsersTable.selectAll().associate {
                it[app.shopkeep.auth.UsersTable.id] to it[app.shopkeep.auth.UsersTable.displayName]
            }
        }
        val events = dbQuery {
            OrderEventsTable.selectAll().where { OrderEventsTable.orderId eq orderId }
                .orderBy(OrderEventsTable.id).map { e ->
                    OrderEventView(
                        from = e[OrderEventsTable.fromCategory],
                        to = e[OrderEventsTable.toCategory],
                        author = e[OrderEventsTable.userId]?.let(users::get),
                        at = e[OrderEventsTable.createdAt]?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                    )
                }
        }
        val notes = dbQuery {
            OrderNotesTable.selectAll().where { OrderNotesTable.orderId eq orderId }
                .orderBy(OrderNotesTable.id).map { n ->
                    OrderNoteView(
                        id = n[OrderNotesTable.id],
                        author = n[OrderNotesTable.userId]?.let(users::get) ?: "Unknown",
                        body = n[OrderNotesTable.body],
                        documentIds = n[OrderNotesTable.documentIds],
                        at = n[OrderNotesTable.createdAt]?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
                    )
                }
        }

        // Shipping cost side (vault: Etsy Integration): receipt-linked
        // shipping_transaction ledger entries are exact; the label cost is an
        // estimate from the packaging profile until labels join to orders.
        val shipFees = dbQuery {
            -PlatformLedgerTable.selectAll()
                .where { PlatformLedgerTable.ledgerType eq "shipping_transaction" }
                .andWhere { PlatformLedgerTable.referenceId eq o[OrdersTable.platformOrderId] }
                .sumOf { it[PlatformLedgerTable.amountMinor] } // ledger charges are negative; costs read positive
        }.takeIf { it != 0L }
        // Three tiers (D22): USPS commercial quote (domestic, dims + weight
        // known) -> packaging profile static estimate -> none.
        val profileIds = summary.lines
            .mapNotNull { it.matchedListingId }.distinct()
            .mapNotNull { lid -> listings.get(lid)?.input?.packagingProfileId }.distinct()
        val staticEstimate = profileIds.mapNotNull { pid ->
            dbQuery {
                app.shopkeep.listings.PackagingProfilesTable.selectAll()
                    .where { app.shopkeep.listings.PackagingProfilesTable.id eq pid }.singleOrNull()
                    ?.get(app.shopkeep.listings.PackagingProfilesTable.shipCostEstimateMinor)
            }
        }.maxOrNull()
        val uspsEstimate = uspsEstimateFor(o, profileIds)
        val shipEstimate = uspsEstimate ?: staticEstimate
        val shipEstimateSource = if (uspsEstimate != null) "usps" else if (staticEstimate != null) "profile" else null

        return OrderDetail(
            order = summary,
            shipFeesMinor = shipFees,
            shipEstimateMinor = shipEstimate,
            shipEstimateSource = shipEstimateSource,
            shipName = o[OrdersTable.shipName],
            shipLine1 = o[OrdersTable.shipLine1],
            shipLine2 = o[OrdersTable.shipLine2],
            shipCity = o[OrdersTable.shipCity],
            shipState = o[OrdersTable.shipState],
            shipZip = o[OrdersTable.shipZip],
            shipCountry = o[OrdersTable.shipCountry],
            paymentMethod = o[OrdersTable.paymentMethod],
            isGift = o[OrdersTable.isGift],
            giftMessage = o[OrdersTable.giftMessage],
            giftSender = o[OrdersTable.giftSender],
            subtotalMinor = o[OrdersTable.subtotalMinor],
            shippingMinor = o[OrdersTable.shippingMinor],
            taxMinor = o[OrdersTable.taxMinor],
            discountMinor = o[OrdersTable.discountMinor],
            feesMinor = o[OrdersTable.feesMinor],
            platformPaid = o[OrdersTable.platformPaid],
            platformShipped = o[OrdersTable.platformShipped],
            completedAt = o[OrdersTable.completedAt]?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
            materialsCostMinor = if (materialRows.isEmpty()) null else matsCost.toLong(),
            laborMinor = if (materialRows.isEmpty()) null else laborMinor,
            materials = materialRows,
            events = events,
            notes = notes,
        )
    }

    /** USPS commercial quote for this order (D22): weight from product
     *  override or the line's reserved BOM (+ per-piece weightGrams attrs),
     *  box dims from the packaging band's box material. Null on any gap —
     *  the caller falls back to the static profile estimate. */
    private suspend fun uspsEstimateFor(o: org.jetbrains.exposed.sql.ResultRow, profileIds: List<Long>): Long? {
        val country = o[OrdersTable.shipCountry] ?: return null
        if (country.uppercase() !in setOf("US", "USA", "UNITED STATES")) return null
        val zip = o[OrdersTable.shipZip] ?: return null
        val rawLines = dbQuery {
            OrderLinesTable.selectAll().where { OrderLinesTable.orderId eq o[OrdersTable.id] }.toList()
        }
        var weight = 0.0
        var units = 0
        for (l in rawLines) {
            units += l[OrderLinesTable.quantity]
            val listingId = l[OrderLinesTable.matchedListingId]
                ?: l[OrderLinesTable.listingConfigurationId]?.let { c ->
                    dbQuery {
                        ListingConfigurationsTable.selectAll().where { ListingConfigurationsTable.id eq c }
                            .singleOrNull()?.get(ListingConfigurationsTable.listingId)
                    }
                } ?: return null // unmatched line -> weight unknowable
            val productId = listings.get(listingId)?.input?.productId ?: return null
            val perUnit = products.get(productId)?.shipWeightGrams?.toDouble() ?: run {
                val bom = l[OrderLinesTable.reservedBom] ?: return null
                var g = 0.0
                for (b in bom) {
                    val m = materials.get(b.materialId) ?: continue
                    g += when (m.unit) {
                        "g" -> b.qty
                        else -> (m.attributes["weightGrams"]?.toDoubleOrNull() ?: return null) * b.qty
                    }
                }
                g
            }
            weight += perUnit * l[OrderLinesTable.quantity]
        }
        if (weight <= 0) return null
        val profileId = profileIds.firstOrNull() ?: return null
        val band = listings.resolvePackaging(profileId, units).band ?: return null
        var dims: Triple<Double, Double, Double>? = null
        var boxWeight = 0.0
        for (bm in band.materials) {
            val m = materials.get(bm.materialId) ?: continue
            val len = m.attributes["lengthIn"]?.toDoubleOrNull()
            val wid = m.attributes["widthIn"]?.toDoubleOrNull()
            val hei = m.attributes["heightIn"]?.toDoubleOrNull()
            if (len != null && wid != null && hei != null && dims == null) dims = Triple(len, wid, hei)
            boxWeight += (m.attributes["weightGrams"]?.toDoubleOrNull() ?: 0.0) * bm.quantity
        }
        val (lgt, wdt, hgt) = dims ?: return null
        return connections.uspsQuote(zip, weight + boxWeight, lgt, wdt, hgt)
    }

    suspend fun addNote(orderId: Long, userId: Long?, body: String, documentIds: List<Long>): Boolean {
        val exists = dbQuery { OrdersTable.selectAll().where { OrdersTable.id eq orderId }.any() }
        if (!exists) return false
        dbQuery {
            OrderNotesTable.insert {
                it[OrderNotesTable.orderId] = orderId
                it[OrderNotesTable.userId] = userId
                it[OrderNotesTable.body] = body
                it[OrderNotesTable.documentIds] = documentIds
            }
        }
        return true
    }
}
