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
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.URLBuilder
import io.ktor.http.isSuccess
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
    val apiSharedSecretEnc = text("api_shared_secret_enc").nullable()
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
    val syncCursor = timestampWithTimeZone("sync_cursor").nullable()
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class EtsyMoney(val amount: Long = 0, val divisor: Long = 100, @SerialName("currency_code") val currencyCode: String = "USD") {
    val minor: Long get() = if (divisor == 0L) amount else amount * 100 / divisor
}

@Serializable
data class EtsyVariation(
    @SerialName("property_id") val propertyId: Long = 0,
    @SerialName("formatted_name") val name: String = "",
    @SerialName("formatted_value") val value: String = "",
)

@Serializable
data class EtsyTransaction(
    @SerialName("transaction_id") val transactionId: Long = 0,
    @SerialName("listing_id") val listingId: Long? = null,
    val title: String = "",
    val sku: String? = null,
    val quantity: Int = 1,
    val price: EtsyMoney = EtsyMoney(),
    val variations: List<EtsyVariation> = emptyList(),
)

/* ---------- shop listings (import picker, D17) ---------- */

@Serializable
data class EtsyPropertyValue(
    @SerialName("property_name") val propertyName: String = "",
    val values: List<String> = emptyList(),
)

@Serializable
data class EtsyOffering(val price: EtsyMoney = EtsyMoney())

@Serializable
data class EtsyInventoryProduct(
    val sku: String? = null,
    @SerialName("property_values") val propertyValues: List<EtsyPropertyValue> = emptyList(),
    val offerings: List<EtsyOffering> = emptyList(),
)

@Serializable
data class EtsyInventory(val products: List<EtsyInventoryProduct> = emptyList())

@Serializable
data class EtsyShopListing(
    @SerialName("listing_id") val listingId: Long = 0,
    val title: String = "",
    val description: String = "",
    val state: String = "",
    val quantity: Int = 0,
    val tags: List<String> = emptyList(),
    val inventory: EtsyInventory? = null,
)

@Serializable
data class EtsyShopListings(val count: Int = 0, val results: List<EtsyShopListing> = emptyList())

@Serializable
data class EtsyReceipt(
    @SerialName("receipt_id") val receiptId: Long = 0,
    val name: String = "",
    @SerialName("message_from_buyer") val messageFromBuyer: String? = null,
    val grandtotal: EtsyMoney = EtsyMoney(),
    @SerialName("created_timestamp") val createdTimestamp: Long = 0,
    val status: String = "paid", // paid|completed|open|payment processing|canceled|fully refunded|partially refunded
    val transactions: List<EtsyTransaction> = emptyList(),
    // Ship-to, status, gift, and money breakdown (order detail concept).
    @SerialName("first_line") val firstLine: String? = null,
    @SerialName("second_line") val secondLine: String? = null,
    val city: String? = null,
    val state: String? = null,
    val zip: String? = null,
    @SerialName("country_iso") val countryIso: String? = null,
    @SerialName("payment_method") val paymentMethod: String? = null,
    @SerialName("is_paid") val isPaid: Boolean = true,
    @SerialName("is_shipped") val isShipped: Boolean = false,
    @SerialName("is_gift") val isGift: Boolean = false,
    @SerialName("gift_message") val giftMessage: String? = null,
    @SerialName("gift_sender") val giftSender: String? = null,
    val subtotal: EtsyMoney? = null,
    @SerialName("total_shipping_cost") val totalShippingCost: EtsyMoney? = null,
    @SerialName("total_tax_cost") val totalTaxCost: EtsyMoney? = null,
    @SerialName("discount_amt") val discountAmt: EtsyMoney? = null,
)

@Serializable
data class EtsyReceipts(val count: Int = 0, val results: List<EtsyReceipt> = emptyList())

@Serializable
data class EtsyPayment(@SerialName("amount_fees") val amountFees: EtsyMoney = EtsyMoney())

@Serializable
data class EtsyPayments(val count: Int = 0, val results: List<EtsyPayment> = emptyList())

object OauthPendingTable : Table("oauth_pending") {
    val state = text("state")
    val platform = text("platform")
    val apiKeystring = text("api_keystring")
    val sharedSecret = text("shared_secret")
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

// shops_r: getMe/getShop require it (learned from real Etsy's 403, 2026-08-02).
const val ETSY_SCOPES = "shops_r transactions_r transactions_w listings_r listings_w"

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
    val lastSyncedAt: String?,
    val orderCount: Long,
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
    // Mock mode: the BROWSER-facing authorize URL goes through baseUrl (Vite in
    // dev), but the server's own calls (token/api) hit itself directly on
    // 127.0.0.1 — never through the frontend dev server, and IPv4-explicit.
    private val selfBase get() = "http://127.0.0.1:${config.port}/api/v1/mock-etsy"
    private val authBase get() = if (config.etsyMock) "${config.baseUrl}/api/v1/mock-etsy/oauth/connect" else config.etsyAuthBase
    private val tokenBase get() = if (config.etsyMock) "$selfBase/oauth/token" else config.etsyTokenBase
    private val apiBase get() = if (config.etsyMock) selfBase else config.etsyApiBase

    /* ---------- OAuth handshake ---------- */

    suspend fun startEtsy(keystring: String, sharedSecret: String, label: String): String {
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
                it[OauthPendingTable.sharedSecret] = sharedSecret.trim()
                it[OauthPendingTable.label] = label.trim()
                it[OauthPendingTable.verifier] = verifier
            }
        }
        val url = URLBuilder(authBase)
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
        val sharedSecret = pending[OauthPendingTable.sharedSecret]

        val tokenResp = http.submitForm(
            url = tokenBase,
            formParameters = parameters {
                append("grant_type", "authorization_code")
                append("client_id", keystring)
                append("redirect_uri", redirectUri)
                append("code", code)
                append("code_verifier", pending[OauthPendingTable.verifier])
            },
        )
        if (!tokenResp.status.isSuccess()) {
            error("Etsy token exchange ${tokenResp.status.value}: ${tokenResp.bodyAsText().take(300)}")
        }
        val tokens: EtsyTokens = tokenResp.body()

        val me: EtsyMe = etsyGet("$apiBase/users/me", keystring, sharedSecret, tokens.accessToken)
        val shopName = me.shopId?.let { sid ->
            runCatching {
                etsyGet<EtsyShop>("$apiBase/shops/$sid", keystring, sharedSecret, tokens.accessToken).shopName
            }.getOrNull()
        }

        return dbQuery {
            ConnectionsTable.insert {
                it[platform] = "etsy"
                it[label] = pending[OauthPendingTable.label]
                it[apiKeystring] = keystring
                it[apiSharedSecretEnc] = sharedSecret.takeIf { s -> s.isNotBlank() }?.let(crypto::encrypt)
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

    // Etsy enforcement (Feb 2026): x-api-key is keystring:shared_secret.
    // Status checked BEFORE deserializing so Etsy's error JSON surfaces as the
    // actual message instead of a MissingFieldException on our DTO.
    private suspend inline fun <reified T> etsyGet(url: String, keystring: String, sharedSecret: String, token: String): T {
        val resp = http.get(url) {
            headers {
                append("x-api-key", if (sharedSecret.isBlank()) keystring else "$keystring:$sharedSecret")
                append(HttpHeaders.Authorization, "Bearer $token")
            }
        }
        if (!resp.status.isSuccess()) {
            error("Etsy ${resp.status.value} on ${url.substringAfter("/v3/")}: ${resp.bodyAsText().take(300)}")
        }
        return resp.body()
    }

    /* ---------- lifecycle ---------- */

    suspend fun list(): List<Connection> = dbQuery {
        ConnectionsTable.selectAll().orderBy(ConnectionsTable.id).map { it.toConnection() }
    }

    /** Hard-deletes only when no orders reference the connection; otherwise
     *  soft-disconnects (tokens wiped, status flipped) so order provenance
     *  survives — orders are never orphaned (vault: never delete orders). */
    suspend fun delete(id: Long): Boolean = dbQuery {
        val hasOrders = OrdersTable.selectAll().where { OrdersTable.connectionId eq id }.any()
        if (hasOrders) {
            ConnectionsTable.update({ ConnectionsTable.id eq id }) {
                it[status] = "disconnected"
                it[accessTokenEnc] = null
                it[refreshTokenEnc] = null
                it[tokenExpiresAt] = null
            } > 0
        } else {
            ConnectionsTable.deleteWhere { ConnectionsTable.id eq id } > 0
        }
    }

    /** Live check: refresh token if near expiry, hit users/me, update status. */
    suspend fun verify(id: Long): Connection? {
        val row = dbQuery { ConnectionsTable.selectAll().where { ConnectionsTable.id eq id }.singleOrNull() }
            ?: return null
        val keystring = row[ConnectionsTable.apiKeystring]
        val sharedSecret = row[ConnectionsTable.apiSharedSecretEnc]?.let(crypto::decrypt) ?: ""
        return try {
            var access = row[ConnectionsTable.accessTokenEnc]?.let(crypto::decrypt) ?: error("No token stored.")
            val expiresAt = row[ConnectionsTable.tokenExpiresAt]
            if (expiresAt == null || expiresAt.isBefore(OffsetDateTime.now().plusMinutes(5))) {
                val refresh = row[ConnectionsTable.refreshTokenEnc]?.let(crypto::decrypt) ?: error("No refresh token.")
                val refreshResp = http.submitForm(
                    url = tokenBase,
                    formParameters = parameters {
                        append("grant_type", "refresh_token")
                        append("client_id", keystring)
                        append("refresh_token", refresh)
                    },
                )
                if (!refreshResp.status.isSuccess()) {
                    error("Etsy token refresh ${refreshResp.status.value}: ${refreshResp.bodyAsText().take(300)}")
                }
                val tokens: EtsyTokens = refreshResp.body()
                access = tokens.accessToken
                dbQuery {
                    ConnectionsTable.update({ ConnectionsTable.id eq id }) {
                        it[accessTokenEnc] = crypto.encrypt(tokens.accessToken)
                        it[refreshTokenEnc] = crypto.encrypt(tokens.refreshToken)
                        it[tokenExpiresAt] = OffsetDateTime.now().plusSeconds(tokens.expiresIn)
                    }
                }
            }
            etsyGet<EtsyMe>("$apiBase/users/me", keystring, sharedSecret, access)
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

    /** Paid receipts since the cursor; refreshes tokens via verify() first. */
    suspend fun fetchReceipts(connectionId: Long, sinceEpochSeconds: Long?): EtsyReceipts? {
        val status = verify(connectionId)?.status ?: return null
        if (status != "connected") return null
        val row = dbQuery { ConnectionsTable.selectAll().where { ConnectionsTable.id eq connectionId }.single() }
        val keystring = row[ConnectionsTable.apiKeystring]
        val secret = row[ConnectionsTable.apiSharedSecretEnc]?.let(crypto::decrypt) ?: ""
        val access = row[ConnectionsTable.accessTokenEnc]?.let(crypto::decrypt) ?: return null
        val shopId = row[ConnectionsTable.shopId] ?: return null
        // First sync (no cursor): only OPEN orders — a real shop's history would
        // otherwise flood the intake lane with already-shipped receipts. After
        // that the cursor scopes each pull and shipped-state echoes still arrive.
        val since = sinceEpochSeconds?.let { "&min_last_modified=$it" } ?: "&was_shipped=false"
        return etsyGet("$apiBase/shops/$shopId/receipts?was_paid=true&limit=100$since", keystring, secret, access)
    }

    /** Active + draft listings with inventory, for the import picker (D17). */
    suspend fun fetchShopListings(connectionId: Long): List<EtsyShopListing>? {
        val status = verify(connectionId)?.status ?: return null
        if (status != "connected") return null
        val row = dbQuery { ConnectionsTable.selectAll().where { ConnectionsTable.id eq connectionId }.single() }
        val keystring = row[ConnectionsTable.apiKeystring]
        val secret = row[ConnectionsTable.apiSharedSecretEnc]?.let(crypto::decrypt) ?: ""
        val access = row[ConnectionsTable.accessTokenEnc]?.let(crypto::decrypt) ?: return null
        val shopId = row[ConnectionsTable.shopId] ?: return null
        return listOf("active", "draft").flatMap { state ->
            runCatching {
                etsyGet<EtsyShopListings>(
                    "$apiBase/shops/$shopId/listings?state=$state&limit=100&includes=Inventory",
                    keystring, secret, access,
                ).results
            }.getOrElse { emptyList() }
        }
    }

    /** Etsy's actual processing fees for a receipt (payments API amount_fees), in minor units. */
    suspend fun fetchPaymentFees(connectionId: Long, receiptId: Long): Long? {
        val row = dbQuery { ConnectionsTable.selectAll().where { ConnectionsTable.id eq connectionId }.singleOrNull() }
            ?: return null
        val keystring = row[ConnectionsTable.apiKeystring]
        val secret = row[ConnectionsTable.apiSharedSecretEnc]?.let(crypto::decrypt) ?: ""
        val access = row[ConnectionsTable.accessTokenEnc]?.let(crypto::decrypt) ?: return null
        val shopId = row[ConnectionsTable.shopId] ?: return null
        return runCatching {
            etsyGet<EtsyPayments>("$apiBase/shops/$shopId/receipts/$receiptId/payments", keystring, secret, access)
                .results.firstOrNull()?.amountFees?.minor
        }.getOrNull()
    }

    suspend fun connectedIds(): List<Long> = dbQuery {
        ConnectionsTable.selectAll().where { ConnectionsTable.status eq "connected" }.map { it[ConnectionsTable.id] }
    }

    suspend fun cursor(connectionId: Long): OffsetDateTime? = dbQuery {
        ConnectionsTable.selectAll().where { ConnectionsTable.id eq connectionId }
            .singleOrNull()?.get(ConnectionsTable.syncCursor)
    }

    suspend fun setCursor(connectionId: Long, at: OffsetDateTime): Unit = dbQuery {
        ConnectionsTable.update({ ConnectionsTable.id eq connectionId }) { it[syncCursor] = at }
    }

    private fun org.jetbrains.exposed.sql.ResultRow.toConnection(): Connection = Connection(
        id = this[ConnectionsTable.id],
        platform = this[ConnectionsTable.platform],
        label = this[ConnectionsTable.label],
        shopId = this[ConnectionsTable.shopId],
        shopName = this[ConnectionsTable.shopName],
        scopes = this[ConnectionsTable.scopes],
        status = this[ConnectionsTable.status],
        lastVerifiedAt = this[ConnectionsTable.lastVerifiedAt]?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
        errorMessage = this[ConnectionsTable.errorMessage],
        lastSyncedAt = this[ConnectionsTable.syncCursor]?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME),
        orderCount = OrdersTable.selectAll().where { OrdersTable.connectionId eq this@toConnection[ConnectionsTable.id] }.count(),
        capabilities = ETSY_CAPABILITIES,
    )
}
