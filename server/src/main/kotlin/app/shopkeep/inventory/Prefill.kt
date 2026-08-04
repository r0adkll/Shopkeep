package app.shopkeep.inventory

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpStatusCode
import io.ktor.http.isSuccess
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.post
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.InetAddress
import java.net.URI

/* Paste-a-vendor-link prefill: server-side fetch (browser CORS forbids
 * client-side), structured-data extraction, filament heuristics. Shopify
 * stores (Overture, Polymaker, Bambu Lab) expose /products/<handle>.js as a
 * supported storefront endpoint — no scraping. Everything else falls back to
 * JSON-LD Product then OpenGraph. Amazon is best-effort: no structured data
 * and aggressive bot checks; failures still return the URL for vendorUrl. */

@Serializable
data class PrefillRequest(val url: String)

@Serializable
data class PrefillResult(
    val vendorUrl: String,
    val source: String, // shopify | jsonld | og | none
    val name: String? = null,
    val brand: String? = null,
    val category: String? = null,
    val type: String? = null,
    val unit: String? = null,
    val costMinor: Long? = null,
    val currency: String? = null,
    val costQuantity: Double? = null,
    val fullQuantity: Double? = null,
    val colorName: String? = null,
    val colorHex: String? = null,
    val rawTitle: String? = null,
    val note: String? = null,
)

private val TYPE_TOKENS = listOf(
    "silk pla" to "Silk PLA", "pla+" to "PLA+", "pla" to "PLA", "petg" to "PETG",
    "tpu" to "TPU", "abs" to "ABS", "asa" to "ASA", "nylon" to "Nylon", "pc" to "PC",
)
private val WEIGHT_RE = Regex("""(\d+(?:\.\d+)?)\s*(kg|g)\b""", RegexOption.IGNORE_CASE)
private val NON_COLOR_OPTION = Regex("""^\d|(\d\s*(mm|kg|g)\b)""", RegexOption.IGNORE_CASE)
private val lenientJson = Json { ignoreUnknownKeys = true; isLenient = true }

@SingleIn(AppScope::class)
@Inject
class VendorPrefillService(private val http: HttpClient, private val materials: MaterialRepository) {

    suspend fun prefill(rawUrl: String): PrefillResult {
        val uri = runCatching { URI(rawUrl.trim()) }.getOrNull()
            ?: return PrefillResult(rawUrl, "none", note = "Not a valid URL.")
        if (uri.scheme !in setOf("http", "https") || uri.host == null) {
            return PrefillResult(rawUrl, "none", note = "Only http(s) product links.")
        }
        guardHost(uri.host)?.let { return PrefillResult(rawUrl, "none", note = it) }

        // Variant selectors differ per platform: Shopify uses ?variant=,
        // Bambu Lab's store uses ?id=.
        val variantId = Regex("""(?:^|[?&])(?:variant|id)=(\d+)""").find(uri.query ?: "")?.groupValues?.get(1)

        // 1) Shopify storefront JSON — covers Overture/Polymaker-style stores.
        val handle = Regex("""/products/([\w-]+)""").find(uri.path ?: "")?.groupValues?.get(1)
        if (handle != null) {
            fromShopify(uri, handle, variantId)?.let { return it }
        }

        // 2) Generic HTML: JSON-LD Product/ProductGroup, then OpenGraph.
        val html = fetchCapped("${uri.scheme}://${uri.host}${uri.rawPath ?: ""}${uri.rawQuery?.let { "?$it" } ?: ""}")
            ?: return PrefillResult(rawUrl, "none", note = "Couldn't fetch the page (some vendors, e.g. Amazon, block server fetches). URL kept.")
        fromJsonLd(rawUrl, html, variantId)?.let { return it }
        fromOg(rawUrl, html)?.let { return it }
        return PrefillResult(rawUrl, "none", note = "No product data found on the page. URL kept.")
    }

    /** SSRF guard for a self-hosted app fetching arbitrary URLs. */
    private fun guardHost(host: String): String? = runCatching {
        val addr = InetAddress.getByName(host)
        if (addr.isLoopbackAddress || addr.isSiteLocalAddress || addr.isLinkLocalAddress ||
            addr.isAnyLocalAddress || addr.isMulticastAddress
        ) "That address points inside your network — only public product pages." else null
    }.getOrElse { "Couldn't resolve that host." }

    private suspend fun fetchCapped(url: String, accept: String = "text/html"): String? = runCatching {
        withTimeout(10_000) {
            val resp = http.get(url) {
                header("Accept", accept)
                header("User-Agent", "Mozilla/5.0 (compatible; Shopkeep/1.0; +self-hosted inventory)")
            }
            if (!resp.status.isSuccess()) null
            else resp.bodyAsText().take(2_000_000)
        }
    }.getOrNull()

    private suspend fun fromShopify(uri: URI, handle: String, variantId: String?): PrefillResult? {
        val body = fetchCapped("${uri.scheme}://${uri.host}/products/$handle.js", accept = "application/json") ?: return null
        val p = runCatching { lenientJson.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
        val title = p.str("title") ?: return null
        val vendor = p.str("vendor")
        val variants = (p["variants"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
        val variant = variants.firstOrNull { it.str("id") == variantId }
            ?: variants.firstOrNull { it["available"]?.jsonPrimitive?.content == "true" }
            ?: variants.firstOrNull()
        // price is in cents; .js carries the shop currency implicitly (USD shops)
        val priceMinor = (variant?.num("price") ?: p.num("price"))?.toLong()
        val grams = variant?.num("grams")?.takeIf { it > 0.0 }
        val colorName = listOfNotNull(variant?.str("option1"), variant?.str("option2"), variant?.str("option3"))
            .firstOrNull { it.isNotBlank() && !NON_COLOR_OPTION.containsMatchIn(it) && !it.equals("Default Title", true) }
        return heuristics(
            url = uri.toString(), source = "shopify", title = title, brand = vendor,
            priceMinor = priceMinor, currency = null, grams = grams, colorName = colorName,
        )
    }

    private suspend fun fromJsonLd(url: String, html: String, variantId: String?): PrefillResult? {
        val scripts = Regex("""<script[^>]*application/ld\+json[^>]*>(.*?)</script>""", RegexOption.DOT_MATCHES_ALL)
            .findAll(html).map { it.groupValues[1] }
        for (s in scripts) {
            val root = runCatching { lenientJson.parseToJsonElement(s) }.getOrNull() ?: continue
            val node = findProduct(root) ?: continue
            // ProductGroup (e.g. Bambu Lab): per-color variant Products under
            // hasVariant, keyed by sku == the URL's variant id.
            val groupName = if (typeOf(node)?.contains("ProductGroup") == true) node.str("name") else null
            val product = if (groupName != null) {
                val variants = (node["hasVariant"] as? JsonArray)?.mapNotNull { it as? JsonObject } ?: emptyList()
                variants.firstOrNull { it.str("sku") == variantId }
                    ?: variants.firstOrNull { (it["offers"] as? JsonObject)?.str("url")?.contains("=$variantId") == true }
                    ?: variants.firstOrNull() ?: node
            } else node
            val title = product.str("name") ?: groupName ?: continue
            val brand = brandOf(node) ?: brandOf(product)
            val offer = when (val o = product["offers"]) {
                is JsonArray -> o.firstOrNull() as? JsonObject
                is JsonObject -> o
                else -> null
            }
            val price = offer?.num("price") ?: offer?.str("price")?.toDoubleOrNull()
            return heuristics(
                url = url, source = "jsonld", title = title, brand = brand,
                priceMinor = price?.let { Math.round(it * 100) }, currency = offer?.str("priceCurrency"),
                grams = null, colorName = product.str("color") ?: variantColor(groupName, product.str("name")),
            )
        }
        return null
    }

    /** "PLA Basic - Cyan (10603) / Refill / 1kg" with group "PLA Basic" -> "Cyan". */
    private fun variantColor(group: String?, name: String?): String? {
        if (group == null || name == null || !name.startsWith("$group - ")) return null
        return name.removePrefix("$group - ").substringBefore("/")
            .replace(Regex("""\(\s*[\w-]+\s*\)"""), "").trim().takeIf { it.isNotBlank() }
    }

    private fun brandOf(o: JsonObject): String? = when (val b = o["brand"]) {
        is JsonObject -> b.str("name")
        else -> (b as? kotlinx.serialization.json.JsonPrimitive)?.content
    }

    private fun typeOf(o: JsonObject): String? =
        o["@type"]?.let { t -> if (t is JsonArray) t.joinToString { x -> x.jsonPrimitive.content } else t.jsonPrimitive.content }

    private fun findProduct(el: JsonElement): JsonObject? = when (el) {
        is JsonObject -> {
            if (typeOf(el)?.contains("Product") == true) el
            else (el["@graph"] as? JsonArray)?.firstNotNullOfOrNull { findProduct(it) }
        }
        is JsonArray -> el.firstNotNullOfOrNull { findProduct(it) }
        else -> null
    }

    private suspend fun fromOg(url: String, html: String): PrefillResult? {
        fun meta(prop: String): String? =
            Regex("""<meta[^>]+(?:property|name)=["']$prop["'][^>]+content=["']([^"']+)["']""", RegexOption.IGNORE_CASE)
                .find(html)?.groupValues?.get(1)
                ?: Regex("""<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']$prop["']""", RegexOption.IGNORE_CASE)
                    .find(html)?.groupValues?.get(1)
        val title = meta("og:title") ?: return null
        val price = meta("product:price:amount") ?: meta("og:price:amount")
        return heuristics(
            url = url, source = "og", title = htmlUnescape(title), brand = meta("og:site_name"),
            priceMinor = price?.toDoubleOrNull()?.let { Math.round(it * 100) },
            currency = meta("product:price:currency") ?: meta("og:price:currency"),
            grams = null, colorName = null,
        )
    }

    private suspend fun heuristics(
        url: String, source: String, title: String, brand: String?,
        priceMinor: Long?, currency: String?, grams: Double?, colorName: String?,
    ): PrefillResult {
        val hay = "$title ${colorName ?: ""}".lowercase()
        val type = TYPE_TOKENS.firstOrNull { hay.contains(it.first) }?.second
        val isFilament = type != null || hay.contains("filament")
        val weight = grams ?: WEIGHT_RE.find(title)?.let { m ->
            val n = m.groupValues[1].toDouble()
            if (m.groupValues[2].equals("kg", true)) n * 1000 else n
        }
        val known = materials.list(includeArchived = true)
        val brands = known.mapNotNull { it.brand }.distinct()
        // Normalize the vendor string onto a brand you already use ("Overture3D" -> "Overture").
        val normBrand = brand?.let { b -> brands.firstOrNull { it.contains(b, true) || b.contains(it, true) } ?: b }
        val hex = colorName?.let { c ->
            (known.firstOrNull { m -> m.brand.equals(normBrand, true) && m.name.contains(c, true) && m.attributes["color"] != null }
                ?: known.firstOrNull { m -> m.name.contains(c, true) && m.attributes["color"] != null })
                ?.attributes?.get("color")
        }
        val suggested = when {
            colorName != null && type != null -> "$colorName $type"
            else -> title.substringBefore(",").trim().take(60)
        }
        return PrefillResult(
            vendorUrl = url, source = source,
            name = suggested, brand = normBrand,
            category = if (isFilament) "filament" else null,
            type = type,
            unit = if (isFilament) "g" else null,
            costMinor = priceMinor, currency = currency,
            costQuantity = weight, fullQuantity = weight,
            colorName = colorName, colorHex = hex, rawTitle = title,
        )
    }

    private fun htmlUnescape(s: String) = s
        .replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")

    private fun JsonObject.str(key: String): String? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.content
    private fun JsonObject.num(key: String): Double? = (this[key] as? kotlinx.serialization.json.JsonPrimitive)?.content?.toDoubleOrNull()
}

fun Route.vendorPrefillRoutes(prefill: VendorPrefillService) {
    authenticate(SESSION_AUTH) {
        post("/inventory/materials/prefill") {
            val req = runCatching { call.receive<PrefillRequest>() }.getOrNull()
            if (req == null || req.url.isBlank()) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Paste a product URL."))
            } else call.respond(prefill.prefill(req.url))
        }
    }
}
