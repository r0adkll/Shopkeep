package app.shopkeep.catalog

import app.shopkeep.db.dbQuery
import app.shopkeep.inventory.Material
import app.shopkeep.inventory.MaterialRepository
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update
import org.jetbrains.exposed.sql.upsert
import java.math.BigDecimal
import java.time.OffsetDateTime
import kotlin.math.floor
import kotlin.math.roundToLong

/* Vault: Products.md (locked concept) — slots define the possibility space,
 * ordered first-match-wins rules resolve dependent slots, and configurations
 * are DERIVED, never stored, until a listing pins them (Phase 2b). */

enum class SlotKind { FIXED, CHOICE, RULE }

object SettingsTable : Table("settings") {
    val key = text("key")
    val value = text("value")
    override val primaryKey = PrimaryKey(key)
}

object ProductsTable : Table("products") {
    val id = long("id").autoIncrement()
    val name = text("name")
    val description = text("description")
    val skuPrefix = text("sku_prefix")
    val laborMinutes = integer("labor_minutes")
    val imageDocumentId = long("image_document_id").nullable()
    val archivedAt = timestampWithTimeZone("archived_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

object ProductSlotsTable : Table("product_slots") {
    val id = long("id").autoIncrement()
    val productId = long("product_id")
    val position = integer("position")
    val name = text("name")
    val kind = text("kind")
    val quantity = decimal("quantity", 12, 3)
    val fixedMaterialId = long("fixed_material_id").nullable()
    val defaultMaterialId = long("default_material_id").nullable()
    override val primaryKey = PrimaryKey(id)
}

object ProductSlotOptionsTable : Table("product_slot_options") {
    val slotId = long("slot_id")
    val materialId = long("material_id")
    override val primaryKey = PrimaryKey(slotId, materialId)
}

object ProductRulesTable : Table("product_rules") {
    val id = long("id").autoIncrement()
    val productId = long("product_id")
    val position = integer("position")
    val whenSlotId = long("when_slot_id")
    val thenSlotId = long("then_slot_id")
    val thenMaterialId = long("then_material_id")
    override val primaryKey = PrimaryKey(id)
}

object ProductRuleWhenTable : Table("product_rule_when") {
    val ruleId = long("rule_id")
    val materialId = long("material_id")
    override val primaryKey = PrimaryKey(ruleId, materialId)
}

/* ---------- DTOs: the recipe travels as one nested document ---------- */

@Serializable
data class SlotInput(
    val name: String,
    val kind: SlotKind,
    val quantity: Double,
    val fixedMaterialId: Long? = null,
    val defaultMaterialId: Long? = null,
    val optionMaterialIds: List<Long> = emptyList(),
)

@Serializable
data class RuleInput(
    /** Slot positions (index into the slots array), stable across saves. */
    val whenSlot: Int,
    val thenSlot: Int,
    val thenMaterialId: Long,
    val whenMaterialIds: List<Long>,
)

@Serializable
data class ProductInput(
    val name: String,
    val description: String = "",
    val skuPrefix: String,
    val laborMinutes: Int = 0,
    val imageDocumentId: Long? = null,
    val slots: List<SlotInput> = emptyList(),
    val rules: List<RuleInput> = emptyList(),
)

@Serializable
data class Product(
    val id: Long,
    val name: String,
    val description: String,
    val skuPrefix: String,
    val laborMinutes: Int,
    val imageDocumentId: Long?,
    val archived: Boolean,
    val slots: List<SlotInput>,
    val rules: List<RuleInput>,
)

@Serializable
data class ProductSummary(
    val id: Long,
    val name: String,
    val skuPrefix: String,
    val laborMinutes: Int,
    val imageDocumentId: Long?,
    val archived: Boolean,
    val slotCount: Int,
    val configurationCount: Int,
    val unresolvedCount: Int,
    val materialCostMinor: Long?,
)

@Serializable
data class ConfigSelection(val slotName: String, val materialId: Long, val materialName: String, val color: String?)

@Serializable
data class Configuration(
    val sku: String?,
    val selections: List<ConfigSelection>,
    val resolved: Boolean,
    val materialCostMinor: Long,
    val buildableUnits: Int?,
    val cappedBy: String?,
)

@SingleIn(AppScope::class)
@Inject
class ProductRepository(private val materials: MaterialRepository) {

    /* ---------- settings ---------- */

    suspend fun laborRateMinor(): Long = dbQuery {
        SettingsTable.selectAll().where { SettingsTable.key eq "labor_rate_minor" }
            .singleOrNull()?.get(SettingsTable.value)?.toLongOrNull() ?: 0L
    }

    suspend fun setLaborRateMinor(minor: Long): Unit = dbQuery {
        SettingsTable.upsert {
            it[key] = "labor_rate_minor"
            it[value] = minor.toString()
        }
    }

    /* ---------- CRUD (recipe saved atomically; slots/rules replaced wholesale) ---------- */

    suspend fun create(input: ProductInput): Long = dbQuery {
        val id = ProductsTable.insert {
            it[name] = input.name.trim()
            it[description] = input.description
            it[skuPrefix] = input.skuPrefix.trim().uppercase()
            it[laborMinutes] = input.laborMinutes
            it[imageDocumentId] = input.imageDocumentId
        } get ProductsTable.id
        writeRecipe(id, input)
        id
    }

    suspend fun update(id: Long, input: ProductInput): Boolean = dbQuery {
        val hit = ProductsTable.update({ ProductsTable.id eq id }) {
            it[name] = input.name.trim()
            it[description] = input.description
            it[skuPrefix] = input.skuPrefix.trim().uppercase()
            it[laborMinutes] = input.laborMinutes
            it[imageDocumentId] = input.imageDocumentId
        } > 0
        if (hit) {
            ProductSlotsTable.deleteWhere { productId eq id }
            ProductRulesTable.deleteWhere { productId eq id }
            writeRecipe(id, input)
        }
        hit
    }

    suspend fun setArchived(id: Long, archived: Boolean): Boolean = dbQuery {
        ProductsTable.update({ ProductsTable.id eq id }) {
            it[archivedAt] = if (archived) OffsetDateTime.now() else null
        } > 0
    }

    private fun writeRecipe(productId: Long, input: ProductInput) {
        val slotIds = input.slots.mapIndexed { idx, slot ->
            val slotId = ProductSlotsTable.insert {
                it[ProductSlotsTable.productId] = productId
                it[position] = idx
                it[name] = slot.name.trim()
                it[kind] = slot.kind.name.lowercase()
                it[quantity] = BigDecimal.valueOf(slot.quantity)
                it[fixedMaterialId] = slot.fixedMaterialId
                it[defaultMaterialId] = slot.defaultMaterialId
            } get ProductSlotsTable.id
            slot.optionMaterialIds.forEach { mat ->
                ProductSlotOptionsTable.insert {
                    it[ProductSlotOptionsTable.slotId] = slotId
                    it[materialId] = mat
                }
            }
            slotId
        }
        input.rules.forEachIndexed { idx, rule ->
            val ruleId = ProductRulesTable.insert {
                it[ProductRulesTable.productId] = productId
                it[position] = idx
                it[whenSlotId] = slotIds[rule.whenSlot]
                it[thenSlotId] = slotIds[rule.thenSlot]
                it[thenMaterialId] = rule.thenMaterialId
            } get ProductRulesTable.id
            rule.whenMaterialIds.forEach { mat ->
                ProductRuleWhenTable.insert {
                    it[ProductRuleWhenTable.ruleId] = ruleId
                    it[materialId] = mat
                }
            }
        }
    }

    suspend fun get(id: Long): Product? = dbQuery { readProduct(id) }

    private fun readProduct(id: Long): Product? {
        val row = ProductsTable.selectAll().where { ProductsTable.id eq id }.singleOrNull() ?: return null
        val slotRows = ProductSlotsTable.selectAll().where { ProductSlotsTable.productId eq id }
            .orderBy(ProductSlotsTable.position).toList()
        val slotIdToPos = slotRows.mapIndexed { idx, r -> r[ProductSlotsTable.id] to idx }.toMap()
        val options = ProductSlotOptionsTable.selectAll()
            .where { ProductSlotOptionsTable.slotId inList slotRows.map { it[ProductSlotsTable.id] } }
            .groupBy({ it[ProductSlotOptionsTable.slotId] }, { it[ProductSlotOptionsTable.materialId] })
        val ruleRows = ProductRulesTable.selectAll().where { ProductRulesTable.productId eq id }
            .orderBy(ProductRulesTable.position).toList()
        val whens = ProductRuleWhenTable.selectAll()
            .where { ProductRuleWhenTable.ruleId inList ruleRows.map { it[ProductRulesTable.id] } }
            .groupBy({ it[ProductRuleWhenTable.ruleId] }, { it[ProductRuleWhenTable.materialId] })
        return Product(
            id = row[ProductsTable.id],
            name = row[ProductsTable.name],
            description = row[ProductsTable.description],
            skuPrefix = row[ProductsTable.skuPrefix],
            laborMinutes = row[ProductsTable.laborMinutes],
            imageDocumentId = row[ProductsTable.imageDocumentId],
            archived = row[ProductsTable.archivedAt] != null,
            slots = slotRows.map { s ->
                SlotInput(
                    name = s[ProductSlotsTable.name],
                    kind = SlotKind.valueOf(s[ProductSlotsTable.kind].uppercase()),
                    quantity = s[ProductSlotsTable.quantity].toDouble(),
                    fixedMaterialId = s[ProductSlotsTable.fixedMaterialId],
                    defaultMaterialId = s[ProductSlotsTable.defaultMaterialId],
                    optionMaterialIds = options[s[ProductSlotsTable.id]] ?: emptyList(),
                )
            },
            rules = ruleRows.map { r ->
                RuleInput(
                    whenSlot = slotIdToPos.getValue(r[ProductRulesTable.whenSlotId]),
                    thenSlot = slotIdToPos.getValue(r[ProductRulesTable.thenSlotId]),
                    thenMaterialId = r[ProductRulesTable.thenMaterialId],
                    whenMaterialIds = whens[r[ProductRulesTable.id]] ?: emptyList(),
                )
            },
        )
    }

    suspend fun list(): List<ProductSummary> {
        val ids = dbQuery {
            ProductsTable.selectAll().where { ProductsTable.archivedAt.isNull() }
                .orderBy(ProductsTable.id).map { it[ProductsTable.id] }
        }
        val stock = materials.list(includeArchived = true).associateBy { it.id }
        return ids.mapNotNull { id ->
            val p = get(id) ?: return@mapNotNull null
            val configs = enumerate(p, stock)
            ProductSummary(
                id = p.id,
                name = p.name,
                skuPrefix = p.skuPrefix,
                laborMinutes = p.laborMinutes,
                imageDocumentId = p.imageDocumentId,
                archived = p.archived,
                slotCount = p.slots.size,
                configurationCount = configs.count { it.resolved },
                unresolvedCount = configs.count { !it.resolved },
                materialCostMinor = configs.firstOrNull { it.resolved }?.materialCostMinor,
            )
        }
    }

    suspend fun configurations(id: Long): List<Configuration>? {
        val p = get(id) ?: return null
        val stock = materials.list(includeArchived = true).associateBy { it.id }
        return enumerate(p, stock)
    }

    /* ---------- enumeration: the concept's live preview, server-side ---------- */

    private fun enumerate(p: Product, stock: Map<Long, Material>): List<Configuration> {
        val choiceSlots = p.slots.withIndex().filter { it.value.kind == SlotKind.CHOICE }
        // Cartesian product of choice palettes, capped defensively.
        var combos = listOf(emptyMap<Int, Long>())
        for ((idx, slot) in choiceSlots) {
            combos = combos.flatMap { base -> slot.optionMaterialIds.map { base + (idx to it) } }
            if (combos.size > 2000) return emptyList()
        }
        val codes = skuCodes(p, stock)
        return combos.map { combo -> buildConfig(p, combo, stock, codes) }
    }

    /**
     * Per-slot SKU codes from each material's DISTINCTIVE tokens: words shared by
     * every option in the slot are stripped ("PLA Matte Charcoal" → CHAR), so
     * codes stay unique even when a whole palette shares a type prefix.
     */
    private fun skuCodes(p: Product, stock: Map<Long, Material>): Map<Int, Map<Long, String>> =
        p.slots.withIndex().filter { it.value.kind != SlotKind.FIXED }.associate { (idx, slot) ->
            val names = slot.optionMaterialIds.associateWith { stock[it]?.name ?: "?" }
            val tokenized = names.mapValues { (_, n) -> n.split(Regex("[^A-Za-z0-9]+")).filter { it.isNotBlank() } }
            val shared = tokenized.values
                .map { it.map(String::lowercase).toSet() }
                .reduceOrNull { a, b -> a intersect b } ?: emptySet()
            idx to tokenized.mapValues { (_, tokens) ->
                val distinctive = tokens.filter { it.lowercase() !in shared }
                (distinctive.ifEmpty { tokens }).joinToString("").filter { it.isLetterOrDigit() }
                    .take(4).uppercase().ifBlank { "X" }
            }
        }

    private fun buildConfig(
        p: Product,
        combo: Map<Int, Long>,
        stock: Map<Long, Material>,
        codes: Map<Int, Map<Long, String>>,
    ): Configuration {
        val selections = mutableListOf<ConfigSelection>()
        val skuParts = mutableListOf(p.skuPrefix)
        val bom = mutableListOf<Triple<String, Double, Material?>>() // name, qty, material
        var resolved = true

        p.slots.forEachIndexed { idx, slot ->
            val materialId: Long? = when (slot.kind) {
                SlotKind.FIXED -> slot.fixedMaterialId
                SlotKind.CHOICE -> combo[idx]
                SlotKind.RULE -> {
                    val match = p.rules.firstOrNull { r ->
                        r.thenSlot == idx && combo[r.whenSlot]?.let { it in r.whenMaterialIds } == true
                    }
                    match?.thenMaterialId ?: slot.defaultMaterialId
                }
            }
            if (materialId == null) {
                resolved = false
                return@forEachIndexed
            }
            val mat = stock[materialId]
            bom += Triple(slot.name, slot.quantity, mat)
            if (slot.kind != SlotKind.FIXED) {
                selections += ConfigSelection(slot.name, materialId, mat?.name ?: "?", mat?.attributes?.get("color"))
                skuParts += codes[idx]?.get(materialId) ?: "X"
            }
        }

        val costMinor = bom.sumOf { (_, qty, mat) ->
            if (mat == null || mat.costQuantity <= 0) 0.0 else qty * mat.costMinor / mat.costQuantity
        }.roundToLong()

        var units: Int? = null
        var cappedBy: String? = null
        if (resolved) {
            for ((slotName, qty, mat) in bom) {
                if (mat == null || qty <= 0.0) continue
                val u = floor(mat.stock.available / qty).toInt()
                if (units == null || u < units) {
                    units = u
                    cappedBy = "${mat.name} ($slotName)"
                }
            }
        }

        val sku = if (resolved) skuParts.joinToString("-") else null

        return Configuration(sku, selections, resolved, costMinor, units, cappedBy)
    }
}
