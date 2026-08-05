package app.shopkeep.inventory

import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.catalog.SettingsTable
import app.shopkeep.db.dbQuery
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.get
import io.ktor.http.isSuccess
import io.ktor.client.statement.HttpResponse
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.SqlExpressionBuilder.like
import org.jetbrains.exposed.sql.Op
import org.jetbrains.exposed.sql.count
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.batchInsert
import org.jetbrains.exposed.sql.deleteAll
import org.jetbrains.exposed.sql.json.jsonb
import org.jetbrains.exposed.sql.lowerCase
import org.jetbrains.exposed.sql.or
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.upsert
import java.io.ByteArrayInputStream
import java.time.Duration
import java.time.OffsetDateTime
import java.util.zip.GZIPInputStream

/* Local mirror of the Open Filament Database (openfilamentdatabase.org) —
 * community data: 150+ brands, 14k color variants with official hexes,
 * spool weights, densities. It ships as a static versioned JSON dump, so the
 * mirror is self-hosting-friendly: one download into Postgres (pg_dump keeps
 * it in backups), refreshed weekly by the poll loop, and everything keeps
 * working offline — the catalog just goes stale. Materials created from it
 * carry attributes.ofdVariantId, the stable key for future features
 * (brand palettes, weigh-in tares, printer telemetry matching). */

private const val DUMP_URL = "https://api.openfilamentdatabase.org/json/all.json.gz"
private const val VERSION_KEY = "filamentdb_version"
private const val REFRESHED_KEY = "filamentdb_refreshed_at"
private val STALE_AFTER: Duration = Duration.ofDays(7)

object FilamentCatalogTable : Table("filament_catalog") {
    val variantId = text("variant_id")
    val brand = text("brand")
    val line = text("line")
    val material = text("material")
    val colorName = text("color_name")
    val colorHex = text("color_hex").nullable()
    val density = decimal("density", 8, 4).nullable()
    val dataSheetUrl = text("data_sheet_url").nullable()
    val discontinued = bool("discontinued")
    val sizes = jsonb<List<CatalogSize>>("sizes", Json.Default)
    val links = jsonb<List<CatalogLink>>("links", Json.Default)
    override val primaryKey = PrimaryKey(variantId)
}

@Serializable
data class CatalogLink(val url: String, val store: String, val shipsFrom: List<String> = emptyList())

@Serializable
data class CatalogSize(
    val weightGrams: Double? = null,
    val spoolWeightGrams: Double? = null,
    val refill: Boolean = false,
    val articleNumber: String? = null,
)

@Serializable
data class CatalogFilament(
    val variantId: String,
    val brand: String,
    val line: String,
    val material: String,
    val colorName: String,
    val colorHex: String?,
    val density: Double?,
    val dataSheetUrl: String?,
    val discontinued: Boolean,
    val sizes: List<CatalogSize>,
    val links: List<CatalogLink> = emptyList(),
)

@Serializable
data class CatalogFacet(val name: String, val variants: Long)

/** Each facet is counted with the OTHER filter applied, so picking a brand
 *  narrows the material list to what that brand actually makes (and back). */
@Serializable
data class CatalogFacets(val brands: List<CatalogFacet>, val materials: List<CatalogFacet>)

@Serializable
data class CatalogStatus(
    val version: String?,
    val refreshedAt: String?,
    val variants: Long,
)

// Dump shapes — only the fields the mirror keeps. Community data is uneven
// (missing spool weights, absent flags), hence the defaults everywhere.
@Serializable private data class OfdBrand(val id: String, val name: String)
@Serializable private data class OfdFilament(
    val id: String,
    val name: String,
    val brand_id: String,
    val material: String? = null,
    val density: Double? = null,
    val data_sheet_url: String? = null,
    val discontinued: Boolean = false,
)
@Serializable private data class OfdVariant(
    val id: String,
    val name: String,
    val filament_id: String,
    val color_hex: String? = null,
    val discontinued: Boolean = false,
)
@Serializable private data class OfdSize(
    val id: String,
    val variant_id: String,
    val filament_weight: Double? = null,
    val empty_spool_weight: Double? = null,
    val spool_refill: Boolean = false,
    val article_number: String? = null,
)
@Serializable private data class OfdStore(
    val id: String,
    val name: String,
    val ships_from: List<String> = emptyList(),
)
@Serializable private data class OfdPurchaseLink(
    val store_id: String,
    val size_id: String,
    val url: String,
)
@Serializable private data class OfdDump(
    val version: String? = null,
    val brands: List<OfdBrand> = emptyList(),
    val filaments: List<OfdFilament> = emptyList(),
    val variants: List<OfdVariant> = emptyList(),
    val sizes: List<OfdSize> = emptyList(),
    val stores: List<OfdStore> = emptyList(),
    val purchase_links: List<OfdPurchaseLink> = emptyList(),
)

private val dumpJson = Json { ignoreUnknownKeys = true; isLenient = true }

@SingleIn(AppScope::class)
@Inject
class FilamentCatalogRepository(private val http: HttpClient) {

    suspend fun status(): CatalogStatus = dbQuery {
        CatalogStatus(
            version = setting(VERSION_KEY),
            refreshedAt = setting(REFRESHED_KEY),
            variants = FilamentCatalogTable.selectAll().count(),
        )
    }

    /** Poll-loop hook: cheap check every cycle, real work at most weekly. */
    suspend fun refreshIfStale() {
        val refreshedAt = dbQuery { setting(REFRESHED_KEY) }
            ?.let { runCatching { OffsetDateTime.parse(it) }.getOrNull() }
        val empty = dbQuery { FilamentCatalogTable.selectAll().empty() }
        if (!empty && refreshedAt != null &&
            Duration.between(refreshedAt, OffsetDateTime.now()) < STALE_AFTER
        ) return
        refresh()
    }

    suspend fun refresh(): CatalogStatus {
        val gz: ByteArray = withTimeout(60_000) {
            val resp: HttpResponse = http.get(DUMP_URL)
            check(resp.status.isSuccess()) { "Filament DB fetch failed: ${resp.status}" }
            resp.body()
        }
        val raw = GZIPInputStream(ByteArrayInputStream(gz)).readBytes().decodeToString()
        val dump = dumpJson.decodeFromString<OfdDump>(raw)

        val brandById = dump.brands.associate { it.id to it.name }
        val lineById = dump.filaments.associateBy { it.id }
        // Community rows duplicate sizes (spool + refill listed twice); dedupe
        // on what the app cares about.
        val sizesByVariant = dump.sizes.groupBy { it.variant_id }.mapValues { (_, list) ->
            list.map { CatalogSize(it.filament_weight, it.empty_spool_weight, it.spool_refill, it.article_number) }
                .distinctBy { Triple(it.weightGrams, it.refill, it.spoolWeightGrams) }
        }
        val storeById = dump.stores.associateBy { it.id }
        val variantBySize = dump.sizes.associate { it.id to it.variant_id }
        val linksByVariant = dump.purchase_links
            .mapNotNull { pl ->
                val variantId = variantBySize[pl.size_id] ?: return@mapNotNull null
                val store = storeById[pl.store_id] ?: return@mapNotNull null
                variantId to CatalogLink(pl.url, store.name, store.ships_from)
            }
            .groupBy({ it.first }, { it.second })
            .mapValues { (_, ls) -> ls.distinctBy { it.url }.take(12) }

        val rows = dump.variants.mapNotNull { v ->
            val line = lineById[v.filament_id] ?: return@mapNotNull null
            val brand = brandById[line.brand_id] ?: return@mapNotNull null
            CatalogFilament(
                variantId = v.id,
                brand = brand,
                line = line.name,
                material = line.material ?: "?",
                colorName = v.name,
                colorHex = v.color_hex?.uppercase()?.takeIf { Regex("^#[0-9A-F]{6}$").matches(it) },
                density = line.density,
                dataSheetUrl = line.data_sheet_url,
                discontinued = v.discontinued || line.discontinued,
                sizes = sizesByVariant[v.id] ?: emptyList(),
                links = linksByVariant[v.id] ?: emptyList(),
            )
        }.distinctBy { it.variantId }

        dbQuery {
            FilamentCatalogTable.deleteAll()
            FilamentCatalogTable.batchInsert(rows, shouldReturnGeneratedValues = false) { r ->
                this[FilamentCatalogTable.variantId] = r.variantId
                this[FilamentCatalogTable.brand] = r.brand
                this[FilamentCatalogTable.line] = r.line
                this[FilamentCatalogTable.material] = r.material
                this[FilamentCatalogTable.colorName] = r.colorName
                this[FilamentCatalogTable.colorHex] = r.colorHex
                this[FilamentCatalogTable.density] = r.density?.toBigDecimal()
                this[FilamentCatalogTable.dataSheetUrl] = r.dataSheetUrl
                this[FilamentCatalogTable.discontinued] = r.discontinued
                this[FilamentCatalogTable.sizes] = r.sizes
                this[FilamentCatalogTable.links] = r.links
            }
            dump.version?.let { v -> SettingsTable.upsert { it[key] = VERSION_KEY; it[value] = v } }
            SettingsTable.upsert { it[key] = REFRESHED_KEY; it[value] = OffsetDateTime.now().toString() }
        }
        return status()
    }

    /** Token search: every token must hit brand, line, material, or color. */
    suspend fun search(
        q: String,
        brand: String?,
        material: String?,
        includeDiscontinued: Boolean = true,
        limit: Int = 60,
    ): List<CatalogFilament> = dbQuery {
        val tokens = q.lowercase().split(Regex("\\s+")).filter { it.isNotBlank() }
        var where: Op<Boolean> = Op.TRUE
        if (brand != null) where = where and (FilamentCatalogTable.brand eq brand)
        if (material != null) where = where and (FilamentCatalogTable.material eq material)
        if (!includeDiscontinued) where = where and (FilamentCatalogTable.discontinued eq false)
        for (t in tokens) {
            val pat = "%${t.replace("%", "\\%").replace("_", "\\_")}%"
            where = where and (
                (FilamentCatalogTable.brand.lowerCase() like pat) or
                    (FilamentCatalogTable.line.lowerCase() like pat) or
                    (FilamentCatalogTable.material.lowerCase() like pat) or
                    (FilamentCatalogTable.colorName.lowerCase() like pat)
                )
        }
        FilamentCatalogTable.selectAll().where { where }
            .orderBy(
                FilamentCatalogTable.discontinued to org.jetbrains.exposed.sql.SortOrder.ASC,
                FilamentCatalogTable.brand to org.jetbrains.exposed.sql.SortOrder.ASC,
                FilamentCatalogTable.line to org.jetbrains.exposed.sql.SortOrder.ASC,
                FilamentCatalogTable.colorName to org.jetbrains.exposed.sql.SortOrder.ASC,
            )
            .limit(limit)
            .map { row ->
                CatalogFilament(
                    variantId = row[FilamentCatalogTable.variantId],
                    brand = row[FilamentCatalogTable.brand],
                    line = row[FilamentCatalogTable.line],
                    material = row[FilamentCatalogTable.material],
                    colorName = row[FilamentCatalogTable.colorName],
                    colorHex = row[FilamentCatalogTable.colorHex],
                    density = row[FilamentCatalogTable.density]?.toDouble(),
                    dataSheetUrl = row[FilamentCatalogTable.dataSheetUrl],
                    discontinued = row[FilamentCatalogTable.discontinued],
                    sizes = row[FilamentCatalogTable.sizes],
                    links = row[FilamentCatalogTable.links],
                )
            }
    }

    suspend fun facets(brand: String?, material: String?): CatalogFacets = dbQuery {
        val count = FilamentCatalogTable.variantId.count()
        val brands = FilamentCatalogTable
            .select(FilamentCatalogTable.brand, count)
            .let { if (material != null) it.where { FilamentCatalogTable.material eq material } else it }
            .groupBy(FilamentCatalogTable.brand)
            .orderBy(FilamentCatalogTable.brand)
            .map { CatalogFacet(it[FilamentCatalogTable.brand], it[count]) }
        val materials = FilamentCatalogTable
            .select(FilamentCatalogTable.material, count)
            .let { if (brand != null) it.where { FilamentCatalogTable.brand eq brand } else it }
            .groupBy(FilamentCatalogTable.material)
            .orderBy(count to org.jetbrains.exposed.sql.SortOrder.DESC, FilamentCatalogTable.material to org.jetbrains.exposed.sql.SortOrder.ASC)
            .map { CatalogFacet(it[FilamentCatalogTable.material], it[count]) }
        CatalogFacets(brands, materials)
    }

    private fun setting(key: String): String? =
        SettingsTable.selectAll().where { SettingsTable.key eq key }.singleOrNull()?.get(SettingsTable.value)
}

fun Route.filamentCatalogRoutes(catalog: FilamentCatalogRepository) {
    authenticate(SESSION_AUTH) {
        get("/inventory/filamentdb/status") { call.respond(catalog.status()) }
        get("/inventory/filamentdb/facets") {
            call.respond(
                catalog.facets(
                    brand = call.request.queryParameters["brand"]?.takeIf { it.isNotBlank() },
                    material = call.request.queryParameters["material"]?.takeIf { it.isNotBlank() },
                ),
            )
        }
        get("/inventory/filamentdb/search") {
            val q = call.request.queryParameters["q"] ?: ""
            val brand = call.request.queryParameters["brand"]?.takeIf { it.isNotBlank() }
            val material = call.request.queryParameters["material"]?.takeIf { it.isNotBlank() }
            val includeDiscontinued = call.request.queryParameters["discontinued"] != "false"
            val limit = call.request.queryParameters["limit"]?.toIntOrNull()?.coerceIn(1, 200) ?: 60
            call.respond(catalog.search(q, brand, material, includeDiscontinued, limit))
        }
        post("/inventory/filamentdb/refresh") { call.respond(catalog.refresh()) }
    }
}
