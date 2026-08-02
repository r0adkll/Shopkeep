package app.shopkeep.integrations

import io.ktor.http.HttpStatusCode
import io.ktor.server.request.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondRedirect
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Dev-only Etsy test double (ETSY_MOCK=true) — the Dex pattern applied to
 * storefronts: the whole connect → verify → ingest pipeline runs against
 * this until app approval lands, at which point real Etsy is a config flip.
 * It deliberately ENFORCES Etsy's current contract (keystring:shared_secret
 * header, Feb 2026) so the real integration can't drift.
 */

@Serializable
private data class MockTokens(
    @SerialName("access_token") val accessToken: String = "12345.mock-access-token",
    @SerialName("refresh_token") val refreshToken: String = "12345.mock-refresh-token",
    @SerialName("expires_in") val expiresIn: Long = 3600,
    @SerialName("token_type") val tokenType: String = "Bearer",
)

@Serializable
private data class MockMe(@SerialName("user_id") val userId: Long = 12345, @SerialName("shop_id") val shopId: Long = 424242)

@Serializable
private data class MockShop(
    @SerialName("shop_id") val shopId: Long = 424242,
    @SerialName("shop_name") val shopName: String = "MockGameCases",
)

@Serializable
private data class MockError(val error: String)

private fun validApiKey(header: String?): Boolean =
    header != null && header.contains(":") && header.substringBefore(":").isNotBlank() &&
        header.substringAfter(":").isNotBlank()

fun Route.mockEtsyRoutes() {
    // Simulates Etsy's grant screen: immediately consents and bounces back.
    get("/mock-etsy/oauth/connect") {
        val redirect = call.request.queryParameters["redirect_uri"]
        val state = call.request.queryParameters["state"]
        val challenge = call.request.queryParameters["code_challenge"]
        if (redirect == null || state == null || challenge == null) {
            call.respond(HttpStatusCode.BadRequest, MockError("missing redirect_uri/state/code_challenge"))
            return@get
        }
        call.respondRedirect("$redirect?code=mock-auth-code&state=$state")
    }

    post("/mock-etsy/oauth/token") {
        // Accepts both authorization_code and refresh_token grants.
        call.respond(MockTokens())
    }

    get("/mock-etsy/users/me") {
        if (!validApiKey(call.request.header("x-api-key"))) {
            call.respond(HttpStatusCode.Unauthorized, MockError("x-api-key must be keystring:shared_secret (Etsy enforcement, Feb 2026)"))
            return@get
        }
        call.respond(MockMe())
    }

    get("/mock-etsy/shops/{id}") {
        if (!validApiKey(call.request.header("x-api-key"))) {
            call.respond(HttpStatusCode.Unauthorized, MockError("x-api-key must be keystring:shared_secret"))
            return@get
        }
        call.respond(MockShop())
    }
}
