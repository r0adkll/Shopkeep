package app.shopkeep.integrations

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.requireAdmin
import app.shopkeep.db.dbQuery
import app.shopkeep.listings.AxisInput
import app.shopkeep.listings.AxisValueInput
import app.shopkeep.listings.ListingInput
import app.shopkeep.listings.ListingRepository
import app.shopkeep.listings.ListingsTable
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.http.HttpStatusCode
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.json.jsonb
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update

/* D17 import-with-mapping (locked concept 2026-08-02): imports are staged in
 * their own table until the mapping resolves every variation value; activation
 * materializes a canonical listing (sku_mode=listing_level, no generated
 * configurations) and retro-matches waiting order lines by Etsy listing id. */

object EtsyImportsTable : Table("etsy_imports") {
    val id = long("id").autoIncrement()
    val connectionId = long("connection_id")
    val etsyListingId = text("etsy_listing_id")
    val payload = jsonb<EtsyShopListing>("payload", Json.Default)
    val mapping = jsonb<ImportMapping>("mapping", Json.Default)
    val listingId = long("listing_id").nullable()
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class ImportValueMapping(
    val value: String,
    val resolution: String = "unmapped", // material | design | variant | review | ignore | unmapped
    val materialId: Long? = null,
    val designId: Long? = null,
    val variantId: Long? = null,
)

@Serializable
data class ImportAxisMapping(
    val name: String,
    val slotPosition: Int? = null, // set when mode=materials: which slot the values fill
    val mode: String? = null, // materials | designs | variants | modifier (override matching / no materials)
    val values: List<ImportValueMapping> = emptyList(),
)

@Serializable
data class ImportMapping(
    val productId: Long? = null,
    val axes: List<ImportAxisMapping> = emptyList(),
)

@Serializable
data class EtsyImport(
    val id: Long,
    val connectionId: Long,
    val etsyListingId: String,
    val payload: EtsyShopListing,
    val mapping: ImportMapping,
    val listingId: Long?,
)

@Serializable
data class CreateImportRequest(val connectionId: Long, val etsyListingId: Long)

@Serializable
data class ActivateResult(val listingId: Long, val retroMatchedLines: Int)

@SingleIn(AppScope::class)
@Inject
class ImportRepository(
    private val connections: ConnectionRepository,
    private val listings: ListingRepository,
    private val sync: SyncService,
    private val designs: app.shopkeep.catalog.DesignRepository,
) {
    suspend fun list(): List<EtsyImport> = dbQuery {
        EtsyImportsTable.selectAll().orderBy(EtsyImportsTable.id).map { it.toDto() }
    }

    /** Snapshot the Etsy listing and stage it for mapping. Idempotent per listing. */
    suspend fun create(connectionId: Long, etsyListingId: Long): EtsyImport? {
        dbQuery {
            EtsyImportsTable.selectAll().where { EtsyImportsTable.etsyListingId eq etsyListingId.toString() }
                .singleOrNull()
        }?.let { return it.toDto() }
        val listing = connections.fetchShopListings(connectionId)
            ?.firstOrNull { it.listingId == etsyListingId } ?: return null
        // Prefill mapping skeleton from the inventory's axes/values.
        val axes = mutableMapOf<String, MutableSet<String>>()
        listing.inventory?.products?.forEach { p ->
            p.propertyValues.forEach { pv -> axes.getOrPut(pv.propertyName) { mutableSetOf() }.addAll(pv.values) }
        }
        val mapping = ImportMapping(
            axes = axes.map { (name, vals) -> ImportAxisMapping(name = name, values = vals.sorted().map { ImportValueMapping(it) }) },
        )
        val id = dbQuery {
            EtsyImportsTable.insert {
                it[EtsyImportsTable.connectionId] = connectionId
                it[EtsyImportsTable.etsyListingId] = etsyListingId.toString()
                it[payload] = listing
                it[EtsyImportsTable.mapping] = mapping
            } get EtsyImportsTable.id
        }
        return EtsyImport(id, connectionId, etsyListingId.toString(), listing, mapping, null)
    }

    /** Abandon a draft. Activated imports stay — they're provenance for a live listing. */
    suspend fun delete(id: Long): String? = dbQuery {
        val row = EtsyImportsTable.selectAll().where { EtsyImportsTable.id eq id }.singleOrNull()
            ?: return@dbQuery "Import not found."
        if (row[EtsyImportsTable.listingId] != null) return@dbQuery "Already activated — the listing owns this import now."
        EtsyImportsTable.deleteWhere { EtsyImportsTable.id eq id }
        null
    }

    suspend fun saveMapping(id: Long, mapping: ImportMapping): Boolean = dbQuery {
        EtsyImportsTable.update({ EtsyImportsTable.id eq id }) { it[EtsyImportsTable.mapping] = mapping } > 0
    }

    /** Every value resolved -> materialize the canonical listing + retro-match. */
    suspend fun activate(id: Long): ActivateResult {
        val imp = dbQuery {
            EtsyImportsTable.selectAll().where { EtsyImportsTable.id eq id }.singleOrNull()
        }?.toDto() ?: error("Import not found.")
        require(imp.listingId == null) { "Already activated." }
        val m = imp.mapping
        val productId = m.productId ?: error("Link a product first.")
        val unresolved = m.axes.filter { it.slotPosition != null }
            .flatMap { it.values }.count {
                it.resolution == "unmapped" ||
                    (it.resolution == "material" && it.materialId == null) ||
                    (it.resolution == "design" && it.designId == null) ||
                    (it.resolution == "variant" && it.variantId == null)
            }
        require(unresolved == 0) { "$unresolved value(s) still unresolved." }

        val payload = imp.payload
        val priceMinor = payload.inventory?.products?.firstOrNull()?.offerings?.firstOrNull()?.price?.minor ?: 0
        val listingId = listings.create(
            ListingInput(
                productId = productId,
                title = payload.title,
                description = payload.description,
                state = if (payload.state == "active") "active" else "draft",
                basePriceMinor = priceMinor,
                quantity = payload.quantity,
                skuMode = "listing_level",
                tags = payload.tags,
                // Etsy's single personalization field lands as one text question
                // so the compiled push shape round-trips without a diff.
                personalization = if (!payload.isPersonalizable) null else app.shopkeep.listings.Personalization(
                    questions = listOf(app.shopkeep.listings.PersonalizationQuestion(
                        type = "text",
                        questionText = payload.personalizationInstructions ?: "",
                        required = payload.personalizationIsRequired,
                        maxChars = payload.personalizationCharCountMax,
                    )),
                ),
                axes = m.axes.mapNotNull { ax ->
                    val mode = ax.mode ?: if (ax.slotPosition != null) "materials" else "modifier"
                    when (mode) {
                        "materials" -> AxisInput(
                            displayName = ax.name,
                            productSlotPosition = ax.slotPosition ?: 0,
                            valueSource = "materials",
                            values = ax.values.filter { it.resolution == "material" }.map { v ->
                                AxisValueInput(materialId = v.materialId!!, platformValue = v.value, displayLabel = v.value)
                            },
                        )
                        "designs" -> AxisInput(
                            displayName = ax.name,
                            productSlotPosition = 0,
                            valueSource = "designs",
                            values = ax.values.filter { it.resolution == "design" && it.designId != null }.map { v ->
                                AxisValueInput(designId = v.designId, platformValue = v.value, displayLabel = v.value)
                            },
                        )
                        "variants" -> AxisInput(
                            displayName = ax.name,
                            productSlotPosition = 0,
                            valueSource = "variants",
                            values = ax.values.filter { it.resolution == "variant" && it.variantId != null }.map { v ->
                                AxisValueInput(variantId = v.variantId, platformValue = v.value, displayLabel = v.value)
                            },
                        )
                        // Modifier axes materialize as explicit override binds:
                        // values matching a set key bind to it, the rest to base —
                        // imported listings become rename-safe like authored ones.
                        else -> {
                            val setKeys = designs.designs(productId).flatMap { d -> d.overrideSets.map { it.key } }
                            AxisInput(
                                displayName = ax.name,
                                productSlotPosition = 0,
                                valueSource = "override_sets",
                                values = ax.values.map { v ->
                                    val key = setKeys.firstOrNull { it.equals(v.value, ignoreCase = true) }
                                    AxisValueInput(overrideKey = key ?: "base", platformValue = v.value, displayLabel = v.value)
                                },
                            )
                        }
                    }
                },
                valueResolutions = m.axes.flatMap { ax ->
                    ax.values.filter { it.resolution in setOf("design", "variant", "review", "ignore") }.map { v ->
                        app.shopkeep.listings.ValueResolution(
                            axis = ax.name, value = v.value, kind = v.resolution,
                            refId = v.designId ?: v.variantId,
                        )
                    }
                },
            ),
        )
        dbQuery {
            ListingsTable.update({ ListingsTable.id eq listingId }) {
                it[etsyListingId] = imp.etsyListingId
                it[syncState] = "in_sync"
                it[platformState] = imp.payload.state
            }
            EtsyImportsTable.update({ EtsyImportsTable.id eq id }) { it[EtsyImportsTable.listingId] = listingId }
        }
        val retro = sync.retroMatch(listingId, imp.etsyListingId)
        return ActivateResult(listingId, retro)
    }

    private fun org.jetbrains.exposed.sql.ResultRow.toDto() = EtsyImport(
        id = this[EtsyImportsTable.id],
        connectionId = this[EtsyImportsTable.connectionId],
        etsyListingId = this[EtsyImportsTable.etsyListingId],
        payload = this[EtsyImportsTable.payload],
        mapping = this[EtsyImportsTable.mapping],
        listingId = this[EtsyImportsTable.listingId],
    )
}

fun Route.importRoutes(imports: ImportRepository, connections: ConnectionRepository) {
    requireAdmin {
        get("/integrations/connections/{id}/etsy-listings") {
            val id = call.parameters["id"]?.toLongOrNull()
            val ls = id?.let { connections.fetchShopListings(it) }
            if (ls == null) call.respond(HttpStatusCode.NotFound, ApiError("Connection not found or not connected."))
            else call.respond(ls)
        }
        get("/integrations/imports") { call.respond(imports.list()) }
        post("/integrations/imports") {
            val req = call.receive<CreateImportRequest>()
            val imp = imports.create(req.connectionId, req.etsyListingId)
            if (imp == null) call.respond(HttpStatusCode.NotFound, ApiError("Etsy listing not found."))
            else call.respond(HttpStatusCode.Created, imp)
        }
        delete("/integrations/imports/{id}") {
            val err = call.parameters["id"]?.toLongOrNull()?.let { imports.delete(it) } ?: "Import not found."
            if (err == null) call.respond(HttpStatusCode.NoContent)
            else call.respond(HttpStatusCode.UnprocessableEntity, ApiError(err))
        }

        put("/integrations/imports/{id}/mapping") {
            val id = call.parameters["id"]?.toLongOrNull()
            val mapping = call.receive<ImportMapping>()
            if (id == null || !imports.saveMapping(id, mapping)) {
                call.respond(HttpStatusCode.NotFound, ApiError("Import not found."))
            } else call.respond(mapping)
        }
        post("/integrations/imports/{id}/activate") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null) { call.respond(HttpStatusCode.NotFound, ApiError("Import not found.")); return@post }
            try {
                call.respond(imports.activate(id))
            } catch (e: IllegalArgumentException) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError(e.message ?: "Cannot activate."))
            } catch (e: IllegalStateException) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError(e.message ?: "Cannot activate."))
            }
        }
    }
}
