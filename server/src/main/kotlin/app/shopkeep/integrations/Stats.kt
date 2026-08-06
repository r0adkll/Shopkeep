package app.shopkeep.integrations

import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.catalog.ProductRepository
import app.shopkeep.db.dbQuery
import app.shopkeep.inventory.MaterialsTable
import app.shopkeep.inventory.InventoryTransactionsTable
import app.shopkeep.listings.ListingConfigurationsTable
import app.shopkeep.listings.ListingRepository
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.selectAll
import java.time.Duration
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId

/* Phase 6 (vault: Stats.md, dashboard concept locked 2026-08-06).
 * Everything aggregates the per-order profit atom the order detail already
 * shows: revenue = buyer paid − tax (Etsy remits tax), minus real fees
 * (payments API), reserved-BOM materials at unit cost, labor at the global
 * rate. Plain queries over orders/events/ledger — no analytics store. */

@Serializable
data class StatDay(val date: String, val revenueMinor: Long, val profitMinor: Long, val orders: Int)

@Serializable
data class StatTotals(
    val revenueMinor: Long, val profitMinor: Long, val orders: Int,
    val materialsMinor: Long, val feesMinor: Long, val laborMinor: Long,
)

@Serializable
data class StatVariation(val name: String, val colorHex: String?, val units: Int, val revenueMinor: Long)

@Serializable
data class StatListingMargin(
    val listing: String, val units: Int, val revenueMinor: Long,
    val materialsMinor: Long, val feesMinor: Long, val laborMinor: Long,
)

@Serializable
data class StatLane(val name: String, val avgHours: Double, val samplesHours: List<Double>)

@Serializable
data class StatBacklog(val name: String, val count: Int)

@Serializable
data class StatDeadStock(val name: String, val colorHex: String?, val idleDays: Long, val available: Double, val unit: String, val worthMinor: Long)

@Serializable
data class StatWeekSpend(val weekStart: String, val spendMinor: Long)

@Serializable
data class StatsResponse(
    val days: Int,
    val current: StatTotals,
    val prior: StatTotals,
    val daily: List<StatDay>,
    val ordersPerWeek: List<Int>,
    val spendWeekly: List<StatWeekSpend>,
    val variations: List<StatVariation>,
    val margins: List<StatListingMargin>,
    val lanes: List<StatLane>,
    val cycleAvgHours: Double,
    val cycleMedianHours: Double,
    val backlog: List<StatBacklog>,
    val deadStock: List<StatDeadStock>,
)

@SingleIn(AppScope::class)
@Inject
class StatsService(
    private val products: ProductRepository,
    private val listings: ListingRepository,
    private val laneRepository: LaneRepository,
) {
    private data class OrderCalc(
        val id: Long, val placed: OffsetDateTime, val revenue: Long,
        var materials: Long = 0, val fees: Long, var labor: Long = 0,
    ) { val profit get() = revenue - materials - fees - labor }

    suspend fun compute(days: Int): StatsResponse {
        val zone = ZoneId.systemDefault()
        val now = OffsetDateTime.now()
        val from = now.minusDays(days.toLong())
        val priorFrom = now.minusDays(days * 2L)

        // material unit costs + colors, listing/product maps — one pass each
        val matInfo = dbQuery {
            MaterialsTable.selectAll().associate {
                it[MaterialsTable.id] to Triple(
                    if (it[MaterialsTable.costQuantity].toDouble() > 0) it[MaterialsTable.costMinor] / it[MaterialsTable.costQuantity].toDouble() else 0.0,
                    it[MaterialsTable.attributes]["color"],
                    it[MaterialsTable.name],
                )
            }
        }
        val cfgToListing = dbQuery {
            ListingConfigurationsTable.selectAll().associate {
                it[ListingConfigurationsTable.id] to it[ListingConfigurationsTable.listingId]
            }
        }
        val laborRate = products.laborRateMinor()
        val productMinutes = products.list().associate { it.id to it.laborMinutes }
        val listingMeta = listings.list(includeArchived = true).associate { it.id to Pair(it.input.title, it.input.productId) }

        val orders = dbQuery {
            OrdersTable.selectAll().where { OrdersTable.placedAt greaterEq priorFrom }.toList()
        }.filter { !it[OrdersTable.platformStatus].lowercase().startsWith("cancel") }
        val calcs = orders.associate { o ->
            o[OrdersTable.id] to OrderCalc(
                id = o[OrdersTable.id],
                placed = o[OrdersTable.placedAt] ?: o[OrdersTable.ingestedAt] ?: now,
                revenue = o[OrdersTable.totalMinor] - (o[OrdersTable.taxMinor] ?: 0),
                fees = o[OrdersTable.feesMinor] ?: 0,
            )
        }

        val lines = dbQuery {
            OrderLinesTable.selectAll().where { OrderLinesTable.orderId inList calcs.keys.toList() }.toList()
        }
        val variations = mutableMapOf<String, Triple<String?, Int, Long>>() // name -> hex, units, revenue
        val marginByListing = mutableMapOf<String, StatListingMargin>()
        for (l in lines) {
            val calc = calcs[l[OrderLinesTable.orderId]] ?: continue
            val inWindow = calc.placed >= from
            val bomMinor = (l[OrderLinesTable.reservedBom] ?: emptyList()).sumOf { b ->
                ((matInfo[b.materialId]?.first ?: 0.0) * b.qty).toLong()
            }
            calc.materials += bomMinor
            val listingId = l[OrderLinesTable.listingConfigurationId]?.let(cfgToListing::get)
                ?: l[OrderLinesTable.matchedListingId]
            val meta = listingId?.let(listingMeta::get)
            val minutes = (meta?.second?.let(productMinutes::get) ?: 0) * l[OrderLinesTable.quantity]
            val laborMinor = if (laborRate > 0) minutes * laborRate / 60L else 0L
            calc.labor += laborMinor

            if (!inWindow) continue
            // color demand: the line's color-ish variation value; hex from a
            // material of that color when one exists
            val colorVal = l[OrderLinesTable.variations]
                .firstOrNull { it.name.contains("color", ignoreCase = true) }?.value
            if (colorVal != null) {
                // hex: the line's dominant reserved filament wears the color;
                // fall back to a material whose name matches the value
                val bomHex = (l[OrderLinesTable.reservedBom] ?: emptyList())
                    .sortedByDescending { it.qty }
                    .firstNotNullOfOrNull { matInfo[it.materialId]?.second }
                val hex = bomHex
                    ?: matInfo.values.firstOrNull { it.third.contains(colorVal, ignoreCase = true) && it.second != null }?.second
                val prev = variations[colorVal] ?: Triple(hex, 0, 0L)
                variations[colorVal] = Triple(prev.first ?: hex, prev.second + l[OrderLinesTable.quantity], prev.third + l[OrderLinesTable.priceMinor] * l[OrderLinesTable.quantity])
            }
            val lTitle = meta?.first ?: l[OrderLinesTable.title]
            // per-listing fees: allocated later from order-level? keep line share of order fees by revenue is overkill —
            // margin table allocates order fees proportionally by line revenue at this shop's scale.
            val prevM = marginByListing[lTitle] ?: StatListingMargin(lTitle, 0, 0, 0, 0, 0)
            marginByListing[lTitle] = prevM.copy(
                units = prevM.units + l[OrderLinesTable.quantity],
                revenueMinor = prevM.revenueMinor + l[OrderLinesTable.priceMinor] * l[OrderLinesTable.quantity],
                materialsMinor = prevM.materialsMinor + bomMinor,
                laborMinor = prevM.laborMinor + laborMinor,
            )
        }
        // allocate order fees onto listings proportionally by revenue
        for (calc in calcs.values.filter { it.placed >= from }) {
            val orderLines = lines.filter { it[OrderLinesTable.orderId] == calc.id }
            val lineRev = orderLines.sumOf { it[OrderLinesTable.priceMinor] * it[OrderLinesTable.quantity] }.coerceAtLeast(1)
            for (l in orderLines) {
                val listingId = l[OrderLinesTable.listingConfigurationId]?.let(cfgToListing::get) ?: l[OrderLinesTable.matchedListingId]
                val title = listingId?.let(listingMeta::get)?.first ?: l[OrderLinesTable.title]
                val m = marginByListing[title] ?: continue
                marginByListing[title] = m.copy(feesMinor = m.feesMinor + calc.fees * (l[OrderLinesTable.priceMinor] * l[OrderLinesTable.quantity]) / lineRev)
            }
        }

        fun totals(list: Collection<OrderCalc>) = StatTotals(
            revenueMinor = list.sumOf { it.revenue }, profitMinor = list.sumOf { it.profit },
            orders = list.size, materialsMinor = list.sumOf { it.materials },
            feesMinor = list.sumOf { it.fees }, laborMinor = list.sumOf { it.labor },
        )
        val cur = calcs.values.filter { it.placed >= from }
        val prior = calcs.values.filter { it.placed < from }

        val byDay = cur.groupBy { it.placed.atZoneSameInstant(zone).toLocalDate() }
        val daily = (0 until days).map { i ->
            val d = LocalDate.now(zone).minusDays((days - 1 - i).toLong())
            val list = byDay[d] ?: emptyList()
            StatDay(d.toString(), list.sumOf { it.revenue }, list.sumOf { it.profit }, list.size)
        }
        val ordersPerWeek = daily.chunked(7).map { wk -> wk.sumOf { it.orders } }

        // purchase spend: PURCHASE ledger deltas × unit cost, weekly buckets
        val spend = dbQuery {
            InventoryTransactionsTable.selectAll()
                .where { InventoryTransactionsTable.createdAt greaterEq from }
                .toList()
        }.filter { it[InventoryTransactionsTable.kind] == "PURCHASE" }
            .groupBy { it[InventoryTransactionsTable.createdAt]!!.atZoneSameInstant(zone).toLocalDate().with(java.time.DayOfWeek.MONDAY) }
            .toSortedMap()
            .map { (wk, rows) ->
                StatWeekSpend(wk.toString(), rows.sumOf { r ->
                    ((matInfo[r[InventoryTransactionsTable.materialId]]?.first ?: 0.0) * r[InventoryTransactionsTable.delta].toDouble()).toLong()
                })
            }

        // stage dwell from order events (closed intervals only), current backlog
        val events = dbQuery {
            OrderEventsTable.selectAll().where { OrderEventsTable.orderId inList calcs.keys.toList() }
                .orderBy(OrderEventsTable.id).toList()
        }.groupBy { it[OrderEventsTable.orderId] }
        val dwell = mutableMapOf<String, MutableList<Double>>()
        val cycles = mutableListOf<Double>()
        for ((_, evs) in events) {
            for (i in 0 until evs.size - 1) {
                val a = evs[i][OrderEventsTable.createdAt] ?: continue
                val b = evs[i + 1][OrderEventsTable.createdAt] ?: continue
                dwell.getOrPut(evs[i][OrderEventsTable.toCategory]) { mutableListOf() }
                    .add(Duration.between(a, b).toMinutes() / 60.0)
            }
            val first = evs.firstOrNull()?.get(OrderEventsTable.createdAt)
            val done = evs.lastOrNull { it[OrderEventsTable.toCategory].contains("complete", true) || it[OrderEventsTable.toCategory].contains("shipped", true) }
                ?.get(OrderEventsTable.createdAt)
            if (first != null && done != null && done > first) cycles.add(Duration.between(first, done).toMinutes() / 60.0)
        }
        // order_events doubles as an activity trail (match notes etc.) — only
        // rows whose category is a real lane count as dwell, case-normalized
        val laneOrder = laneRepository.list().map { it.name }
        val laneByLower = laneOrder.associateBy { it.lowercase() }
        val lanesOut = laneOrder.mapNotNull { name ->
            val s = dwell.filterKeys { laneByLower[it.lowercase()] == name }.values.flatten()
            if (s.isEmpty()) null else StatLane(name, s.average(), s.sorted().take(60))
        }
        val laneNameById = laneRepository.list().associate { it.id to it.name }
        val backlog = dbQuery {
            OrdersTable.selectAll().where { OrdersTable.archivedAt.isNull() }.toList()
        }.filter { it[OrdersTable.completedAt] == null }
            .groupBy { it[OrdersTable.laneId]?.let(laneNameById::get) ?: it[OrdersTable.category] }
            .let { g -> (laneOrder.filter(g::containsKey) + g.keys.filter { it !in laneOrder }).map { StatBacklog(it, g[it]!!.size) } }

        // dead stock: available > 0, no consumption/reservation in 45+ days
        val lastUse = dbQuery {
            InventoryTransactionsTable.selectAll().toList()
        }.filter { it[InventoryTransactionsTable.kind] in setOf("CONSUMPTION", "RESERVATION") }
            .groupBy { it[InventoryTransactionsTable.materialId] }
            .mapValues { (_, rows) -> rows.mapNotNull { it[InventoryTransactionsTable.createdAt] }.maxOrNull() }
        val stocks = dbQuery {
            InventoryTransactionsTable.selectAll().toList()
        }.groupBy { it[InventoryTransactionsTable.materialId] }
        val deadStock = dbQuery { MaterialsTable.selectAll().where { MaterialsTable.archivedAt.isNull() }.toList() }
            .mapNotNull { m ->
                val id = m[MaterialsTable.id]
                val rows = stocks[id] ?: return@mapNotNull null
                val onHand = rows.filter { it[InventoryTransactionsTable.kind] in setOf("PURCHASE", "ADJUSTMENT", "CONSUMPTION") }
                    .sumOf { it[InventoryTransactionsTable.delta].toDouble() }
                if (onHand <= 0) return@mapNotNull null
                val last = lastUse[id] ?: rows.mapNotNull { it[InventoryTransactionsTable.createdAt] }.minOrNull() ?: return@mapNotNull null
                val idle = Duration.between(last, now).toDays()
                if (idle < 45) return@mapNotNull null
                val unitCost = matInfo[id]?.first ?: 0.0
                StatDeadStock(
                    name = m[MaterialsTable.name], colorHex = m[MaterialsTable.attributes]["color"],
                    idleDays = idle, available = onHand, unit = m[MaterialsTable.unit],
                    worthMinor = (unitCost * onHand).toLong(),
                )
            }.sortedByDescending { it.idleDays }

        return StatsResponse(
            days = days,
            current = totals(cur), prior = totals(prior),
            daily = daily,
            ordersPerWeek = ordersPerWeek,
            spendWeekly = spend,
            variations = variations.map { (n, t) -> StatVariation(n, t.first, t.second, t.third) }.sortedByDescending { it.units },
            margins = marginByListing.values.sortedByDescending { it.revenueMinor },
            lanes = lanesOut,
            cycleAvgHours = if (cycles.isEmpty()) 0.0 else cycles.average(),
            cycleMedianHours = if (cycles.isEmpty()) 0.0 else cycles.sorted()[cycles.size / 2],
            backlog = backlog,
            deadStock = deadStock,
        )
    }
}

fun Route.statsRoutes(stats: StatsService) {
    authenticate(SESSION_AUTH) {
        get("/stats") {
            val days = call.request.queryParameters["days"]?.toIntOrNull()?.coerceIn(7, 365) ?: 90
            call.respond(stats.compute(days))
        }
    }
}
