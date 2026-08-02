package app.shopkeep.integrations

import app.shopkeep.config.AppConfig
import app.shopkeep.db.dbQuery
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
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/* Vault: Architecture (StorefrontAdapter seam) + Etsy Integration.
 * OAuth 2.0 + PKCE against Etsy v3; tokens AES-GCM encrypted at rest. */

object ConnectionsTable : Table("storefront_connections") {
    val id = long("id").autoIncrement()
    val platform = text("platform")
    val label = text("label")
    val apiKeystring = text("api_keystring")
    val shopId = text("shop_id").nullable()
    val shopName = text("shop_name").nullable()
    val userRef = text("user_ref").nullable()
    val accessTokenEnc = text("access_token_enc").nullable()
    val refreshTokenEnc = text("refresh_token_enc").nullable()
    val tokenExpiresAt = timestampWithTimeZone("token_expires_at").nullable()
    val scopes = text("scopes")
    val status = text("status")
    val lastVerifiedAt = timestampWithTimeZone("last_verified_at").nullable()
    val errorMessage = text("error_message").nullable()
    override val primaryKey = PrimaryKey(id)
}

object OauthPendingTable : Table("oauth_pending") {
    val state = text("state")
    val platform = text("platform")
    val apiKeystring = text("api_keystring")
    val label = text("label")
    val verifier = text("verifier")
    override val primaryKey = PrimaryKey(state)
}

/** AES-GCM at-rest encryption for OAuth tokens (key from env; vault D12 caveat). */
class TokenCrypto(secret: String) {
    private val key = SecretKeySpec(MessageDigest.getInstance("SHA-256").digest(secret.toByteArray()), "AES")
    private val rng = SecureRandom()

    fun encrypt(plain: String): String {
        val iv = ByteArray(12).also(rng::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(128, iv))
        return Base64.getEncoder().encodeToString(iv + cipher.doFinal(plain.toByteArray()))
    }

    fun decrypt(enc: String): String {
        val bytes = Base64.getDecoder().decode(enc)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)))
    }
}

@Serializable
data class PlatformCapabilities(
    val maxPhotos: Int,
    val maxVideos: Int,
    val maxTags: Int,
    val tagCharLimit: Int,
    val titleCharLimit: Int,
    val maxVariationAxes: Int,
    val skuOnAllAxes: Boolean,
    val listingFeeMinor: Long,
    val renewalFeeMinor: Long,
)

val ETSY_CAPABILITIES = PlatformCapabilities(
    maxPhotos = 20, maxVideos = 1, maxTags = 13, tagCharLimit = 20, titleCharLimit = 140,
    maxVariationAxes = 3, skuOnAllAxes = true, listingFeeMinor = 20, renewalFeeMinor = 20,
)

const val ETSY_SCOPES = "transactions_r transactions_w listings_r listings_w"

@Serializable
data class Connection(
    val id: Long,
    val platform: String,
    val label: String,
    val shopId: String?,
    val shopName: String?,
    val scopes: String,
    val status: String,
    val lastVerifiedAt: String?,
    val errorMessage: String?,
    val capabilities: PlatformCapabilities,
)

@Serializable
private data class EtsyTokens(
    @SerialName("access_token") val accessToken: String,
    @SerialName("refresh_token") val refreshToken: String,
    @SerialName("expires_in") val expiresIn: Long,
)

@Serializable
private data class EtsyMe(@SerialName("user_id") val userId: Long, @SerialName("shop_id") val shopId: Long? = null)

@Serializable
private data class EtsyShop(@SerialName("shop_name") val shopName: String? = null)

@SingleIn(AppScope::class)
@Inject
class ConnectionRepository(private val config: AppConfig, private val http: HttpClient) {
    private val crypto = TokenCrypto(config.tokenEncryptionKey)
    private val redirectUri get() = "${config.baseUrl}/api/v1/integrations/etsy/callback"

    /* ---------- OAuth handshake ---------- */

    suspend fun startEtsy(keystring: String, label: String): String {
        val rng = SecureRandom()
        val state = ByteArray(24).also(rng::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
        val verifier = ByteArray(48).also(rng::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
        val challenge = Base64.getUrlEncoder().withoutPadding()
            .encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray()))
        dbQuery {
            OauthPendingTable.insert {
                it[OauthPendingTable.state] = state
                it[platform] = "etsy"
                it[apiKeystring] = keystring.trim()
                it[OauthPendingTable.label] = label.trim()
                it[OauthPendingTable.verifier] = verifier
            }
        }
        val url = URLBuilder("https://www.etsy.com/oauth/connect")
        url.parameters.apply {
            append("response_type", "code")
            append("client_id", keystring.trim())
            append("redirect_uri", redirectUri)
            append("scope", ETSY_SCOPES)
            append("state", state)
            append("code_challenge", challenge)
            append("code_challenge_method", "S256")
        }
        return url.buildString()
    }

    /** Completes the handshake: exchanges the code, fetches shop identity, stores encrypted tokens. */
    suspend fun completeEtsy(state: String, code: String): Long {
        val pending = dbQuery {
            OauthPendingTable.selectAll().where { OauthPendingTable.state eq state }.singleOrNull()?.also {
                OauthPendingTable.deleteWhere { OauthPendingTable.state eq state }
            }
        } ?: error("OAuth state mismatch — start the connection again.")
        val keystring = pending[OauthPendingTable.apiKeystring]

        val tokens: EtsyTokens = http.submitForm(
            url = "https://api.etsy.com/v3/public/oauth/token",
            formParameters = parameters {
                append("grant_type", "authorization_code")
                append("client_id", keystring)
                append("redirect_uri", redirectUri)
                append("code", code)
                append("code_verifier", pending[OauthPendingTable.verifier])
            },
        ).body()

        val me: EtsyMe = etsyGet("https://openapi.etsy.com/v3/application/users/me", keystring, tokens.accessToken)
        val shopName = me.shopId?.let { sid ->
            runCatching {
                etsyGet<EtsyShop>("https://openapi.etsy.com/v3/application/shops/$sid", keystring, tokens.accessToken).shopName
            }.getOrNull()
        }

        return dbQuery {
            ConnectionsTable.insert {
                it[platform] = "etsy"
                it[label] = pending[OauthPendingTable.label]
                it[apiKeystring] = keystring
                it[shopId] = me.shopId?.toString()
                it[ConnectionsTable.shopName] = shopName
                it[userRef] = me.userId.toString()
                it[accessTokenEnc] = crypto.encrypt(tokens.accessToken)
                it[refreshTokenEnc] = crypto.encrypt(tokens.refreshToken)
                it[tokenExpiresAt] = OffsetDateTime.now().plusSeconds(tokens.expiresIn)
                it[scopes] = ETSY_SCOPES
                it[status] = "connected"
                it[lastVerifiedAt] = OffsetDateTime.now()
            } get ConnectionsTable.id
        }
    }

    private suspend inline fun <reified T> etsyGet(url: String, keystring: String, token: String): T =
        http.get(url) {
            headers {
                append("x-api-key", keystring)
                append(HttpHeaders.Authorization, "Bearer $token")
            }
        }.body()

    /* ---------- lifecycle ---------- */

    suspend fun list(): List<Connection> = dbQuery {
        ConnectionsTable.selectAll().orderBy(ConnectionsTable.id).map { it.toConnection() }
    }

    suspend fun delete(id: Long): Boolean = dbQuery {
        ConnectionsTable.deleteWhere { ConnectionsTable.id eq id } > 0
    }

    /** Live check: refresh token if near expiry, hit users/me, update status. */
    suspend fun verify(id: Long): Connection? {
        val row = dbQuery { ConnectionsTable.selectAll().where { ConnectionsTable.id eq id }.singleOrNull() }
            ?: return null
        val keystring = row[ConnectionsTable.apiKeystring]
        return try {
            var access = row[ConnectionsTable.accessTokenEnc]?.let(crypto::decrypt) ?: error("No token stored.")
            val expiresAt = row[ConnectionsTable.tokenExpiresAt]
            if (expiresAt == null || expiresAt.isBefore(OffsetDateTime.now().plusMinutes(5))) {
                val refresh = row[ConnectionsTable.refreshTokenEnc]?.let(crypto::decrypt) ?: error("No refresh token.")
                val tokens: EtsyTokens = http.submitForm(
                    url = "https://api.etsy.com/v3/public/oauth/token",
                    formParameters = parameters {
                        append("grant_type", "refresh_token")
                        append("client_id", keystring)
                        append("refresh_token", refresh)
                    },
                ).body()
                access = tokens.accessToken
                dbQuery {
                    ConnectionsTable.update({ ConnectionsTable.id eq id }) {
                        it[accessTokenEnc] = crypto.encrypt(tokens.accessToken)
                        it[refreshTokenEnc] = crypto.encrypt(tokens.refreshToken)
                        it[tokenExpiresAt] = OffsetDateTime.now().plusSeconds(tokens.expiresIn)
                    }
                }
            }
            etsyGet<EtsyMe>("https://openapi.etsy.com/v3/application/users/me", keystring, access)
            dbQuery {
                ConnectionsTable.update({ ConnectionsTable.id eq id }) {
                    it[status] = "connected"
                    it[lastVerifiedAt] = OffsetDateTime.now()
                    it[errorMessage] = null
                }
                ConnectionsTable.selectAll().where { ConnectionsTable.id eq id }.single().toConnection()
            }
        } catch (e: Exception) {
            dbQuery {
                ConnectionsTable.update({ ConnectionsTable.id eq id }) {
                    it[status] = "error"
                    it[errorMessage] = e.message?.take(300) ?: "Verification failed"
                }
                ConnectionsTable.selectAll().where { ConnectionsTable.id eq id }.single().toConnection()
            }
        }
    }

    private fun org.jetbrains.exposed.sql.ResultRow.toConnection() = Connection(
        id = this[ConnectionsTable.id],
        platform = this[ConnectionsTable.platform],
        label = this[ConnectionsTable.label],
        shopId = this[ConnectionsTable.shopId],
        shopName = this[ConnectionsTable.shopName],
        scopes = this[ConnectionsTable.scopes],
        status = this[ConnectionsTable.status],
        lastVerifiedAt = this[ConnectionsTable.lastVerifiedAt]?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
        errorMessage = this[ConnectionsTable.errorMessage],
        capabilities = ETSY_CAPABILITIES,
    )
}
