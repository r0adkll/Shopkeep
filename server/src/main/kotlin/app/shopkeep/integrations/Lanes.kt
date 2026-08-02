package app.shopkeep.integrations

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.auth.requireAdmin
import app.shopkeep.db.dbQuery
import app.shopkeep.inventory.MaterialRepository
import app.shopkeep.inventory.TxnKind
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.andWhere
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update
import java.time.OffsetDateTime

/* Locked queue concept: lanes are data; rules run on ARRIVAL ONLY;
 * intake + done roles are the fixed semantics. */

object QueueLanesTable : Table("queue_lanes") {
    val id = long("id").autoIncrement()
    val name = text("name")
    val position = integer("position")
    val role = text("role").nullable()
    override val primaryKey = PrimaryKey(id)
}

object LaneRulesTable : Table("lane_rules") {
    val id = long("id").autoIncrement()
    val laneId = long("lane_id")
    val position = integer("position")
    val condition = text("condition")
    val value = text("value").nullable()
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class LaneRule(val condition: String, val value: String? = null)

@Serializable
data class Lane(val id: Long? = null, val name: String, val role: String? = null, val rules: List<LaneRule> = emptyList())

/** Facts computed at ingest; rules only ever see these (arrival-only). */
data class OrderFacts(
    val personalized: Boolean,
    val shortfall: Boolean,
    val unmatched: Boolean,
    val adhocPackaging: Boolean,
    val platform: String,
    val units: Int,
)

@SingleIn(AppScope::class)
@Inject
class LaneRepository(private val materials: MaterialRepository) {

    suspend fun list(): List<Lane> = dbQuery {
        QueueLanesTable.selectAll().orderBy(QueueLanesTable.position).map { l ->
            Lane(
                id = l[QueueLanesTable.id],
                name = l[QueueLanesTable.name],
                role = l[QueueLanesTable.role],
                rules = LaneRulesTable.selectAll().where { LaneRulesTable.laneId eq l[QueueLanesTable.id] }
                    .orderBy(LaneRulesTable.position)
                    .map { LaneRule(it[LaneRulesTable.condition], it[LaneRulesTable.value]) },
            )
        }
    }

    /** Full-replace save; deleted lanes' orders reassign to intake. */
    suspend fun replaceAll(lanes: List<Lane>): List<Lane> {
        require(lanes.count { it.role == "intake" } == 1) { "Exactly one intake lane required." }
        require(lanes.count { it.role == "done" } == 1) { "Exactly one done lane required." }
        dbQuery {
            val keptIds = lanes.mapNotNull { it.id }.toSet()
            val intakeExistingId = lanes.first { it.role == "intake" }.id
            QueueLanesTable.selectAll().map { it[QueueLanesTable.id] }.filter { it !in keptIds }.forEach { dead ->
                if (intakeExistingId != null) {
                    OrdersTable.update({ OrdersTable.laneId eq dead }) { it[laneId] = intakeExistingId }
                }
                QueueLanesTable.deleteWhere { QueueLanesTable.id eq dead }
            }
            lanes.forEachIndexed { pos, lane ->
                val laneId = if (lane.id != null) {
                    QueueLanesTable.update({ QueueLanesTable.id eq lane.id }) {
                        it[name] = lane.name.trim()
                        it[position] = pos
                        it[role] = lane.role
                    }
                    LaneRulesTable.deleteWhere { LaneRulesTable.laneId eq lane.id }
                    lane.id
                } else {
                    QueueLanesTable.insert {
                        it[name] = lane.name.trim()
                        it[position] = pos
                        it[role] = lane.role
                    } get QueueLanesTable.id
                }
                lane.rules.forEachIndexed { rpos, r ->
                    LaneRulesTable.insert {
                        it[LaneRulesTable.laneId] = laneId
                        it[position] = rpos
                        it[condition] = r.condition
                        it[value] = r.value
                    }
                }
            }
        }
        return list()
    }

    suspend fun intakeLaneId(): Long = dbQuery {
        QueueLanesTable.selectAll().where { QueueLanesTable.role eq "intake" }.first()[QueueLanesTable.id]
    }

    suspend fun doneLaneId(): Long = dbQuery {
        QueueLanesTable.selectAll().where { QueueLanesTable.role eq "done" }.first()[QueueLanesTable.id]
    }

    /** Arrival-only routing: first matching rule in lane order wins, else intake. */
    suspend fun route(facts: OrderFacts): Long {
        for (lane in list()) {
            for (r in lane.rules) {
                val hit = when (r.condition) {
                    "personalized" -> facts.personalized
                    "shortfall" -> facts.shortfall
                    "unmatched" -> facts.unmatched
                    "adhoc_packaging" -> facts.adhocPackaging
                    "platform" -> facts.platform.equals(r.value ?: "", ignoreCase = true)
                    "units_gte" -> facts.units >= (r.value?.toIntOrNull() ?: Int.MAX_VALUE)
                    else -> false
                }
                if (hit) return lane.id!!
            }
        }
        return intakeLaneId()
    }

    /** Move an order; entering the done lane converts reservations to consumption. */
    suspend fun move(orderId: Long, targetLaneId: Long, userId: Long?): Boolean {
        val lanes = list().associateBy { it.id!! }
        val target = lanes[targetLaneId] ?: return false
        return dbQuery {
            val order = OrdersTable.selectAll().where { OrdersTable.id eq orderId }.singleOrNull()
                ?: return@dbQuery false
            val fromLane = order[OrdersTable.laneId]?.let { lanes[it] }
            OrdersTable.update({ OrdersTable.id eq orderId }) {
                it[laneId] = targetLaneId
                if (target.role == "done") it[completedAt] = OffsetDateTime.now()
            }
            OrderEventsTable.insert {
                it[OrderEventsTable.orderId] = orderId
                it[fromCategory] = fromLane?.name
                it[toCategory] = target.name
                it[OrderEventsTable.userId] = userId
            }
            if (target.role == "done" && fromLane?.role != "done" && order[OrdersTable.completedAt] == null) {
                // reservations -> consumption (vault lifecycle invariant #2)
                val note = "Order #${order[OrdersTable.platformOrderId]}"
                app.shopkeep.inventory.InventoryTransactionsTable.selectAll()
                    .where { app.shopkeep.inventory.InventoryTransactionsTable.kind eq "reservation" }
                    .andWhere { app.shopkeep.inventory.InventoryTransactionsTable.note like "$note%" }
                    .forEach { txn ->
                        val delta = txn[app.shopkeep.inventory.InventoryTransactionsTable.delta].toDouble()
                        val mid = txn[app.shopkeep.inventory.InventoryTransactionsTable.materialId]
                        listOf(TxnKind.RELEASE to -delta, TxnKind.CONSUMPTION to delta).forEach { (kind, d) ->
                            app.shopkeep.inventory.InventoryTransactionsTable.insert {
                                it[materialId] = mid
                                it[app.shopkeep.inventory.InventoryTransactionsTable.delta] = java.math.BigDecimal.valueOf(d)
                                it[app.shopkeep.inventory.InventoryTransactionsTable.kind] = kind.name.lowercase()
                                it[app.shopkeep.inventory.InventoryTransactionsTable.note] = "$note (completed)"
                            }
                        }
                    }
            }
            true
        }
    }
}

@Serializable
data class MoveRequest(val laneId: Long)

fun Route.laneRoutes(lanes: LaneRepository) {
    authenticate(SESSION_AUTH) {
        get("/lanes") { call.respond(lanes.list()) }
        post("/orders/{id}/move") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<MoveRequest>()
            val userId = call.principal<app.shopkeep.auth.UserSession>()?.userId
            if (id == null || !lanes.move(id, req.laneId, userId)) {
                call.respond(HttpStatusCode.NotFound, ApiError("Order or lane not found."))
            } else call.respond(HttpStatusCode.OK, MoveRequest(req.laneId))
        }
    }
    requireAdmin {
        put("/lanes") {
            try {
                call.respond(lanes.replaceAll(call.receive()))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError(e.message ?: "Invalid lanes."))
            }
        }
    }
}
