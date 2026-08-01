package app.shopkeep.auth

import app.shopkeep.config.AppConfig
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.forms.submitForm
import io.ktor.client.request.get
import io.ktor.client.request.headers
import io.ktor.http.HttpHeaders
import io.ktor.http.URLBuilder
import io.ktor.http.parameters
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class OidcDiscovery(
    @SerialName("authorization_endpoint") val authorizationEndpoint: String,
    @SerialName("token_endpoint") val tokenEndpoint: String,
    @SerialName("userinfo_endpoint") val userinfoEndpoint: String,
)

@Serializable
data class OidcTokens(
    @SerialName("access_token") val accessToken: String,
    @SerialName("token_type") val tokenType: String,
)

@Serializable
data class OidcUserInfo(
    val sub: String,
    val email: String? = null,
    val name: String? = null,
    @SerialName("preferred_username") val preferredUsername: String? = null,
)

/**
 * Minimal OIDC authorization-code client (vault: D10). Identity claims come from the
 * provider's userinfo endpoint over TLS rather than local id_token signature
 * verification — sufficient for a confidential client; JWKS validation can be added
 * later without changing the flow.
 */
@SingleIn(AppScope::class)
@Inject
class OidcService(
    private val config: AppConfig,
    private val http: HttpClient,
) {
    val enabled: Boolean get() = config.oidcEnabled
    val redirectUri: String get() = "${config.baseUrl}/api/v1/auth/oidc/callback"

    private var cachedDiscovery: OidcDiscovery? = null
    private val discoveryLock = Mutex()

    private suspend fun discovery(): OidcDiscovery = discoveryLock.withLock {
        cachedDiscovery ?: http
            .get("${config.oidcIssuer!!.trimEnd('/')}/.well-known/openid-configuration")
            .body<OidcDiscovery>()
            .also { cachedDiscovery = it }
    }

    suspend fun authorizationUrl(state: String): String {
        val url = URLBuilder(discovery().authorizationEndpoint)
        url.parameters.apply {
            append("client_id", config.oidcClientId!!)
            append("redirect_uri", redirectUri)
            append("response_type", "code")
            append("scope", "openid email profile")
            append("state", state)
        }
        return url.buildString()
    }

    suspend fun fetchUser(code: String): OidcUserInfo {
        val tokens: OidcTokens = http.submitForm(
            url = discovery().tokenEndpoint,
            formParameters = parameters {
                append("grant_type", "authorization_code")
                append("code", code)
                append("redirect_uri", redirectUri)
                append("client_id", config.oidcClientId!!)
                append("client_secret", config.oidcClientSecret!!)
            },
        ).body()

        return http.get(discovery().userinfoEndpoint) {
            headers { append(HttpHeaders.Authorization, "Bearer ${tokens.accessToken}") }
        }.body()
    }
}
