package app.shopkeep.listings

import app.shopkeep.catalog.Configuration
import app.shopkeep.catalog.ProductRepository
import app.shopkeep.db.dbQuery
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.json.jsonb
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update
import java.math.BigDecimal
import java.time.OffsetDateTime

/* Vault: Listings.md (locked concept). Listings pin a product's derived
 * configurations into DURABLE rows — SKUs never change once created. Platform
 * push/pull mechanics land with Phase 3 OAuth; sync fields are ready now. */

object PackagingProfilesTable : Table("packaging_profiles") {
    val id = long("id").autoIncrement()
    val name = text("name")
    override val primaryKey = PrimaryKey(id)
}

object PackagingBandsTable : Table("packaging_bands") {
    val id = long("id").autoIncrement()
    val profileId = long("profile_id")
    val position = integer("position")
    val minQty = integer("min_qty")
    val maxQty = integer("max_qty").nullable()
    val kind = text("kind")
    override val primaryKey = PrimaryKey(id)
}

object PackagingBandMaterialsTable : Table("packaging_band_materials") {
    val bandId = long("band_id")
    val materialId = long("material_id")
    val quantity = decimal("quantity", 12, 3)
    override val primaryKey = PrimaryKey(bandId, materialId)
}

object ListingsTable : Table("listings") {
    val id = long("id").autoIncrement()
    val productId = long("product_id")
    val title = text("title")
    val description = text("description")
    val state = text("state")
    val basePriceMinor = long("base_price_minor")
    val currency = text("currency")
    val quantity = integer("quantity")
    val skuMode = text("sku_mode")
    val packagingProfileId = long("packaging_profile_id").nullable()
    val tags = jsonb<List<String>>("tags", Json.Default)
    val materialsList = jsonb<List<String>>("materials_list", Json.Default)
    val shopSection = text("shop_section").nullable()
    val personalization = jsonb<Personalization>("personalization", Json.Default).nullable()
    val imageDocumentIds = jsonb<List<Long>>("image_document_ids", Json.Default)
    val etsyListingId = text("etsy_listing_id").nullable()
    val syncState = text("sync_state")
    val platformState = text("platform_state").nullable()
    val lastPushedAt = timestampWithTimeZone("last_pushed_at").nullable()
    val archivedAt = timestampWithTimeZone("archived_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

object ListingAxesTable : Table("listing_axes") {
    val id = long("id").autoIncrement()
    val listingId = long("listing_id")
    val position = integer("position")
    val displayName = text("display_name")
    val productSlotPosition = integer("product_slot_position")
    override val primaryKey = PrimaryKey(id)
}

object ListingAxisValuesTable : Table("listing_axis_values") {
    val id = long("id").autoIncrement()
    val axisId = long("axis_id")
    val materialId = long("material_id")
    val position = integer("position")
    val offered = bool("offered")
    val platformSku = text("platform_sku").nullable()
    val priceOverrideMinor = long("price_override_minor").nullable()
    override val primaryKey = PrimaryKey(id)
}

object ListingConfigurationsTable : Table("listing_configurations") {
    val id = long("id").autoIncrement()
    val listingId = long("listing_id")
    val sku = text("sku").uniqueIndex()
    val selections = jsonb<List<app.shopkeep.catalog.ConfigSelection>>("selections", Json.Default)
    val enabled = bool("enabled")
    override val primaryKey = PrimaryKey(id)
}

object ListingExtraMaterialsTable : Table("listing_extra_materials") {
    val listingId = long("listing_id")
    val materialId = long("material_id")
    val quantity = decimal("quantity", 12, 3)
    val basis = text("basis")
    override val primaryKey = PrimaryKey(listingId, materialId)
}

/* ---------- DTOs ---------- */

@Serializable
data class PersonalizationQuestion(
    val type: String, // text | dropdown | file
    val questionText: String,
    val instructions: String? = null,
    val required: Boolean = false,
    val maxChars: Int? = null,
    val options: List<String> = emptyList(),
)

@Serializable
data class Personalization(
    val questions: List<PersonalizationQuestion> = emptyList(),
    val feeMinor: Long? = null,
    val extraLaborMinutes: Int? = null,
)

@Serializable
data class AxisValueInput(
    val materialId: Long,
    val offered: Boolean = true,
    val platformSku: String? = null,
    val priceOverrideMinor: Long? = null,
)

@Serializable
data class AxisInput(val displayName: String, val productSlotPosition: Int, val values: List<AxisValueInput>)

@Serializable
data class ExtraInput(val materialId: Long, val quantity: Double, val basis: String)

@Serializable
data class ListingInput(
    val productId: Long,
    val title: String,
    val description: String = "",
    val state: String = "draft",
    val basePriceMinor: Long = 0,
    val currency: String = "USD",
    val quantity: Int = 0,
    val skuMode: String = "per_combination",
    val packagingProfileId: Long? = null,
    val tags: List<String> = emptyList(),
    val materialsList: List<String> = emptyList(),
    val shopSection: String? = null,
    val personalization: Personalization? = null,
    val imageDocumentIds: List<Long> = emptyList(),
    val axes: List<AxisInput> = emptyList(),
    val extras: List<ExtraInput> = emptyList(),
    val disabledSkus: List<String> = emptyList(),
)

@Serializable
data class ListingConfigurationRow(
    val sku: String,
    val selections: List<app.shopkeep.catalog.ConfigSelection>,
    val enabled: Boolean,
)

@Serializable
data class Listing(
    val id: Long,
    val input: ListingInput,
    val syncState: String,
    val platformState: String?,
    val etsyListingId: String?,
    val archived: Boolean,
    val configurations: List<ListingConfigurationRow>,
)

@Serializable
data class BandInput(val minQty: Int, val maxQty: Int? = null, val kind: String, val materials: List<ExtraInput> = emptyList())

@Serializable
data class PackagingProfileInput(val name: String, val bands: List<BandInput>)

@Serializable
data class PackagingProfile(val id: Long, val name: String, val bands: List<BandInput>, val listingCount: Int)

@Serializable
data class PackagingResolution(
    val band: BandInput?,
    val adhoc: Boolean,
    val unresolved: Boolean,
)

@SingleIn(AppScope::class)
@Inject
class ListingRepository(private val products: ProductRepository) {

    /* ---------- packaging profiles (D14) ---------- */

    suspend fun listProfiles(): List<PackagingProfile> = dbQuery {
        PackagingProfilesTable.selectAll().map { row -> readProfile(row[PackagingProfilesTable.id], row[PackagingProfilesTable.name]) }
    }

    private fun readProfile(id: Long, name: String): PackagingProfile {
        val bands = PackagingBandsTable.selectAll().where { PackagingBandsTable.profileId eq id }
            .orderBy(PackagingBandsTable.position).map { b ->
                val mats = PackagingBandMaterialsTable.selectAll()
                    .where { PackagingBandMaterialsTable.bandId eq b[PackagingBandsTable.id] }
                    .map { ExtraInput(it[PackagingBandMaterialsTable.materialId], it[PackagingBandMaterialsTable.quantity].toDouble(), "per_order") }
                BandInput(b[PackagingBandsTable.minQty], b[PackagingBandsTable.maxQty], b[PackagingBandsTable.kind], mats)
            }
        val count = ListingsTable.selectAll().where { ListingsTable.packagingProfileId eq id }.count().toInt()
        return PackagingProfile(id, name, bands, count)
    }

    suspend fun saveProfile(id: Long?, input: PackagingProfileInput): Long = dbQuery {
        val profileId = if (id == null) {
            PackagingProfilesTable.insert { it[name] = input.name } get PackagingProfilesTable.id
        } else {
            PackagingProfilesTable.update({ PackagingProfilesTable.id eq id }) { it[name] = input.name }
            PackagingBandsTable.deleteWhere { profileId eq id }
            id
        }
        input.bands.forEachIndexed { idx, band ->
            val bandId = PackagingBandsTable.insert {
                it[PackagingBandsTable.profileId] = profileId
                it[position] = idx
                it[minQty] = band.minQty
                it[maxQty] = band.maxQty
                it[kind] = band.kind
            } get PackagingBandsTable.id
            band.materials.forEach { m ->
                PackagingBandMaterialsTable.insert {
                    it[PackagingBandMaterialsTable.bandId] = bandId
                    it[materialId] = m.materialId
                    it[quantity] = BigDecimal.valueOf(m.quantity)
                }
            }
        }
        profileId
    }

    /** Resolve the packaging band for an order's unit count (vault D14). */
    suspend fun resolvePackaging(profileId: Long, units: Int): PackagingResolution = dbQuery {
        val name = PackagingProfilesTable.selectAll().where { PackagingProfilesTable.id eq profileId }
            .singleOrNull()?.get(PackagingProfilesTable.name)
        if (name == null) return@dbQuery PackagingResolution(null, adhoc = false, unresolved = true)
        val band = readProfile(profileId, name).bands.firstOrNull { b ->
            units >= b.minQty && (b.maxQty == null || units <= b.maxQty)
        }
        PackagingResolution(band, adhoc = band?.kind == "adhoc", unresolved = band == null)
    }

    /* ---------- listings ---------- */

    suspend fun create(input: ListingInput): Long {
        val configs = generateConfigurations(input)
        return dbQuery {
            val id = ListingsTable.insert { write(it, input) } get ListingsTable.id
            writeChildren(id, input, configs)
            id
        }
    }

    suspend fun update(id: Long, input: ListingInput): Boolean {
        val configs = generateConfigurations(input)
        return dbQuery {
            val hit = ListingsTable.update({ ListingsTable.id eq id }) { write(it, input) } > 0
            if (hit) {
                ListingAxesTable.deleteWhere { listingId eq id }
                ListingExtraMaterialsTable.deleteWhere { listingId eq id }
                // Durable SKUs: existing configuration rows are kept (their SKUs are
                // published); we only add new combinations and update enabled flags.
                val existing = ListingConfigurationsTable.selectAll()
                    .where { ListingConfigurationsTable.listingId eq id }
                    .associate { it[ListingConfigurationsTable.sku] to it[ListingConfigurationsTable.id] }
                configs.forEach { c ->
                    val enabled = c.sku !in input.disabledSkus
                    val existingId = existing[c.sku]
                    if (existingId == null) {
                        ListingConfigurationsTable.insert {
                            it[listingId] = id
                            it[sku] = c.sku!!
                            it[selections] = c.selections
                            it[ListingConfigurationsTable.enabled] = enabled
                        }
                    } else {
                        ListingConfigurationsTable.update({ ListingConfigurationsTable.id eq existingId }) {
                            it[ListingConfigurationsTable.enabled] = enabled
                        }
                    }
                }
                writeAxesAndExtras(id, input)
            }
            hit
        }
    }

    private fun writeChildren(id: Long, input: ListingInput, configs: List<Configuration>) {
        configs.forEach { c ->
            ListingConfigurationsTable.insert {
                it[listingId] = id
                it[sku] = c.sku!!
                it[selections] = c.selections
                it[enabled] = c.sku !in input.disabledSkus
            }
        }
        writeAxesAndExtras(id, input)
    }

    private fun writeAxesAndExtras(id: Long, input: ListingInput) {
        input.axes.forEachIndexed { pos, axis ->
            val axisId = ListingAxesTable.insert {
                it[listingId] = id
                it[position] = pos
                it[displayName] = axis.displayName.trim()
                it[productSlotPosition] = axis.productSlotPosition
            } get ListingAxesTable.id
            axis.values.forEachIndexed { vpos, v ->
                ListingAxisValuesTable.insert {
                    it[ListingAxisValuesTable.axisId] = axisId
                    it[materialId] = v.materialId
                    it[position] = vpos
                    it[offered] = v.offered
                    it[platformSku] = v.platformSku
                    it[priceOverrideMinor] = v.priceOverrideMinor
                }
            }
        }
        input.extras.forEach { e ->
            ListingExtraMaterialsTable.insert {
                it[listingId] = id
                it[materialId] = e.materialId
                it[quantity] = BigDecimal.valueOf(e.quantity)
                it[basis] = e.basis
            }
        }
    }

    /** The product derives; the listing pins: enumerate the recipe's resolved
     *  configurations and keep those whose choice-slot selections are offered
     *  on every axis. */
    private suspend fun generateConfigurations(input: ListingInput): List<Configuration> {
        val all = products.configurations(input.productId) ?: emptyList()
        val offeredBySlot = input.axes.associate { axis ->
            axis.productSlotPosition to axis.values.filter { it.offered }.map { it.materialId }.toSet()
        }
        return all.filter { c ->
            c.resolved && c.sku != null && c.selections.all { sel ->
                offeredBySlot[sel.slotIndex]?.contains(sel.materialId) ?: true
            }
        }
    }

    private fun ListingsTable.write(it: org.jetbrains.exposed.sql.statements.UpdateBuilder<*>, input: ListingInput) {
        it[productId] = input.productId
        it[title] = input.title.trim()
        it[description] = input.description
        it[state] = input.state
        it[basePriceMinor] = input.basePriceMinor
        it[currency] = input.currency
        it[quantity] = input.quantity
        it[skuMode] = input.skuMode
        it[packagingProfileId] = input.packagingProfileId
        it[tags] = input.tags
        it[materialsList] = input.materialsList
        it[shopSection] = input.shopSection
        it[personalization] = input.personalization
        it[imageDocumentIds] = input.imageDocumentIds
    }

    suspend fun get(id: Long): Listing? = dbQuery {
        val row = ListingsTable.selectAll().where { ListingsTable.id eq id }.singleOrNull() ?: return@dbQuery null
        val axes = ListingAxesTable.selectAll().where { ListingAxesTable.listingId eq id }
            .orderBy(ListingAxesTable.position).map { a ->
                AxisInput(
                    displayName = a[ListingAxesTable.displayName],
                    productSlotPosition = a[ListingAxesTable.productSlotPosition],
                    values = ListingAxisValuesTable.selectAll()
                        .where { ListingAxisValuesTable.axisId eq a[ListingAxesTable.id] }
                        .orderBy(ListingAxisValuesTable.position)
                        .map { v ->
                            AxisValueInput(
                                v[ListingAxisValuesTable.materialId],
                                v[ListingAxisValuesTable.offered],
                                v[ListingAxisValuesTable.platformSku],
                                v[ListingAxisValuesTable.priceOverrideMinor],
                            )
                        },
                )
            }
        val extras = ListingExtraMaterialsTable.selectAll().where { ListingExtraMaterialsTable.listingId eq id }
            .map { ExtraInput(it[ListingExtraMaterialsTable.materialId], it[ListingExtraMaterialsTable.quantity].toDouble(), it[ListingExtraMaterialsTable.basis]) }
        val configs = ListingConfigurationsTable.selectAll().where { ListingConfigurationsTable.listingId eq id }
            .orderBy(ListingConfigurationsTable.id)
            .map { ListingConfigurationRow(it[ListingConfigurationsTable.sku], it[ListingConfigurationsTable.selections], it[ListingConfigurationsTable.enabled]) }
        Listing(
            id = row[ListingsTable.id],
            input = ListingInput(
                productId = row[ListingsTable.productId],
                title = row[ListingsTable.title],
                description = row[ListingsTable.description],
                state = row[ListingsTable.state],
                basePriceMinor = row[ListingsTable.basePriceMinor],
                currency = row[ListingsTable.currency],
                quantity = row[ListingsTable.quantity],
                skuMode = row[ListingsTable.skuMode],
                packagingProfileId = row[ListingsTable.packagingProfileId],
                tags = row[ListingsTable.tags],
                materialsList = row[ListingsTable.materialsList],
                shopSection = row[ListingsTable.shopSection],
                personalization = row[ListingsTable.personalization],
                imageDocumentIds = row[ListingsTable.imageDocumentIds],
                axes = axes,
                extras = extras,
                disabledSkus = configs.filter { !it.enabled }.map { it.sku },
            ),
            syncState = row[ListingsTable.syncState],
            platformState = row[ListingsTable.platformState],
            etsyListingId = row[ListingsTable.etsyListingId],
            archived = row[ListingsTable.archivedAt] != null,
            configurations = configs,
        )
    }

    suspend fun list(): List<Listing> {
        val ids = dbQuery {
            ListingsTable.selectAll().where { ListingsTable.archivedAt.isNull() }
                .orderBy(ListingsTable.id).map { it[ListingsTable.id] }
        }
        return ids.mapNotNull { get(it) }
    }

    suspend fun setArchived(id: Long, archived: Boolean): Boolean = dbQuery {
        ListingsTable.update({ ListingsTable.id eq id }) {
            it[archivedAt] = if (archived) OffsetDateTime.now() else null
        } > 0
    }
}
