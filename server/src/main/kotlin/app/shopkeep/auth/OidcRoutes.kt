package app.shopkeep.auth

import io.ktor.http.HttpStatusCode
import io.ktor.server.response.respond
import io.ktor.server.response.respondRedirect
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.sessions.sessions
import io.ktor.server.sessions.set
import io.ktor.util.date.GMTDate
import io.ktor.util.date.plus
import kotlinx.serialization.Serializable
import java.util.UUID
import kotlin.time.Duration.Companion.minutes

@Serializable
data class AuthProviders(val oidcEnabled: Boolean)

private const val STATE_COOKIE = "shopkeep_oidc_state"

fun Route.oidcRoutes(oidc: OidcService, users: UserRepository) {
    get("/auth/providers") {
        call.respond(AuthProviders(oidcEnabled = oidc.enabled))
    }

    get("/auth/oidc/login") {
        if (!oidc.enabled) {
            call.respond(HttpStatusCode.NotFound, ApiError("OIDC is not configured."))
            return@get
        }
        // The setup wizard must create the admin before SSO users can join (vault: Users & Auth).
        if (users.count() == 0L) {
            call.respondRedirect("/setup")
            return@get
        }
        val state = UUID.randomUUID().toString()
        call.response.cookies.append(
            name = STATE_COOKIE,
            value = state,
            path = "/api/v1/auth/oidc",
            httpOnly = true,
            expires = GMTDate().plus(10.minutes),
        )
        call.respondRedirect(oidc.authorizationUrl(state))
    }

    get("/auth/oidc/callback") {
        val state = call.request.queryParameters["state"]
        val code = call.request.queryParameters["code"]
        val expectedState = call.request.cookies[STATE_COOKIE]
        if (code == null || state == null || expectedState == null || state != expectedState) {
            call.respond(HttpStatusCode.BadRequest, ApiError("OIDC state mismatch — try signing in again."))
            return@get
        }
        call.response.cookies.append(
            name = STATE_COOKIE,
            value = "",
            path = "/api/v1/auth/oidc",
            expires = GMTDate(0),
        )

        val info = oidc.fetchUser(code)
        val user = users.findOrCreateOidcUser(
            subject = info.sub,
            email = info.email ?: "${info.sub}@oidc.local",
            displayName = info.name ?: info.preferredUsername ?: info.email ?: "SSO user",
        )
        call.sessions.set(UserSession(user.id, user.role))
        call.respondRedirect("/")
    }
}
