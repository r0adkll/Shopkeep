package app.shopkeep.integrations

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.auth.requireAdmin
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.response.respondRedirect
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.serialization.Serializable

@Serializable
data class StartEtsyRequest(val keystring: String, val sharedSecret: String = "", val label: String = "")

@Serializable
data class AddNoteRequest(val body: String = "", val documentIds: List<Long> = emptyList())

@kotlinx.serialization.Serializable
data class MatchLineRequest(val listingId: Long, val remember: Boolean = true)

@kotlinx.serialization.Serializable
data class UspsConnectRequest(
    val label: String = "USPS",
    val consumerKey: String,
    val consumerSecret: String,
    val originZip: String,
    val mailClass: String = "USPS_GROUND_ADVANTAGE",
)

@kotlinx.serialization.Serializable
data class UspsConfigRequest(val originZip: String, val mailClass: String = "USPS_GROUND_ADVANTAGE")

@Serializable
data class StartEtsyResponse(val authUrl: String, val redirectUri: String)

fun Route.integrationRoutes(connections: ConnectionRepository, sync: SyncService, baseUrl: String) {
    authenticate(SESSION_AUTH) {
        // Storefront config is admin-only (vault: Users & Auth role matrix).
        get("/integrations/connections") { call.respond(connections.list()) }

        get("/orders") { call.respond(sync.listOrders()) }

        // Phase 4 matching tooling: on-demand retro-match sweep + manual match.
        post("/orders/rematch") { call.respond(sync.rematchAll()) }

        post("/orders/lines/{id}/reresolve") {
            val r = call.parameters["id"]?.toLongOrNull()?.let { sync.reresolveLine(it) }
            when {
                r == null -> call.respond(HttpStatusCode.NotFound, ApiError("Line not found."))
                !r.ok -> call.respond(HttpStatusCode.UnprocessableEntity, ApiError(r.error ?: "Couldn't re-resolve."))
                else -> call.respond(r)
            }
        }

        post("/orders/lines/{id}/match") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<MatchLineRequest>()
            val r = id?.let { sync.matchLine(it, req.listingId, req.remember) }
            when {
                r == null -> call.respond(HttpStatusCode.NotFound, ApiError("Line or listing not found."))
                !r.ok -> call.respond(HttpStatusCode.UnprocessableEntity, ApiError(r.error ?: "Couldn't match."))
                else -> call.respond(r)
            }
        }

        get("/orders/{id}") {
            val detail = call.parameters["id"]?.toLongOrNull()?.let { sync.orderDetail(it) }
            if (detail == null) call.respond(HttpStatusCode.NotFound, ApiError("Order not found."))
            else call.respond(detail)
        }

        post("/orders/{id}/notes") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<AddNoteRequest>()
            if (req.body.isBlank() && req.documentIds.isEmpty()) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("A note needs text or a photo."))
                return@post
            }
            val userId = call.principal<app.shopkeep.auth.UserSession>()?.userId
            if (id == null || !sync.addNote(id, userId, req.body.trim(), req.documentIds)) {
                call.respond(HttpStatusCode.NotFound, ApiError("Order not found."))
            } else call.respond(HttpStatusCode.Created, AddNoteRequest(req.body.trim(), req.documentIds))
        }

        get("/integrations/etsy/callback") {
            val state = call.request.queryParameters["state"]
            val code = call.request.queryParameters["code"]
            val error = call.request.queryParameters["error"]
            if (error != null || state == null || code == null) {
                call.respondRedirect("/connections?error=${error ?: "missing_code"}")
                return@get
            }
            try {
                connections.completeEtsy(state, code)
                call.respondRedirect("/connections?connected=etsy")
            } catch (e: Exception) {
                call.application.environment.log.warn("Etsy OAuth completion failed", e)
                call.respondRedirect("/connections?error=exchange_failed")
            }
        }
    }

    requireAdmin {
        // USPS rate-quote connection (D22): credentials + origin config in-app.
        post("/integrations/usps/connect") {
            val req = call.receive<UspsConnectRequest>()
            if (req.consumerKey.isBlank() || req.consumerSecret.isBlank() || req.originZip.isBlank()) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Consumer key, secret, and origin ZIP are required."))
                return@post
            }
            val c = connections.createUsps(req.label, req.consumerKey, req.consumerSecret, req.originZip.trim(), req.mailClass)
            if (c == null) call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Couldn't create the USPS connection."))
            else call.respond(c)
        }

        put("/integrations/usps/{id}/config") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<UspsConfigRequest>()
            if (id == null || !connections.updateUspsConfig(id, req.originZip.trim(), req.mailClass)) {
                call.respond(HttpStatusCode.NotFound, ApiError("Connection not found."))
            } else call.respond(mapOf("ok" to true))
        }

        post("/integrations/etsy/start") {
            val req = call.receive<StartEtsyRequest>()
            if (req.keystring.isBlank() || req.sharedSecret.isBlank()) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Keystring and shared secret are both required (Etsy enforces keystring:secret since Feb 2026)."))
                return@post
            }
            call.respond(
                StartEtsyResponse(
                    authUrl = connections.startEtsy(req.keystring, req.sharedSecret, req.label),
                    redirectUri = "$baseUrl/api/v1/integrations/etsy/callback",
                ),
            )
        }

        post("/integrations/connections/{id}/sync") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null) call.respond(HttpStatusCode.NotFound, ApiError("Connection not found."))
            else call.respond(sync.syncConnection(id))
        }

        post("/integrations/connections/{id}/verify") {
            val conn = call.parameters["id"]?.toLongOrNull()?.let { connections.verify(it) }
            if (conn == null) call.respond(HttpStatusCode.NotFound, ApiError("Connection not found."))
            else call.respond(conn)
        }

        delete("/integrations/connections/{id}") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null || !connections.delete(id)) {
                call.respond(HttpStatusCode.NotFound, ApiError("Connection not found."))
            } else call.respond(HttpStatusCode.NoContent)
        }
    }
}
