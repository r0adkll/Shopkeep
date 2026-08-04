package app.shopkeep.catalog

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.requireAdmin
import app.shopkeep.db.dbQuery
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.http.HttpStatusCode
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
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

/* D20 — Designs (colorway compositions) & Variants (build modifiers).
 * Both live on the product, referenced by listing value resolutions. */

object ProductDesignsTable : Table("product_designs") {
    val id = long("id").autoIncrement()
    val productId = long("product_id")
    val name = text("name")
    val position = integer("position")
    val assignments = jsonb<List<DesignAssignment>>("assignments", Json.Default)
    val overrideSets = jsonb<List<DesignOverrideSet>>("override_sets", Json.Default)
    val extras = jsonb<List<ExtraMaterial>>("extras", Json.Default)
    override val primaryKey = PrimaryKey(id)
}

object ProductVariantsTable : Table("product_variants") {
    val id = long("id").autoIncrement()
    val productId = long("product_id")
    val name = text("name")
    val position = integer("position")
    val adjustments = jsonb<VariantAdjustments>("adjustments", Json.Default)
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class DesignAssignment(val slotPosition: Int, val materialId: Long, val qtyOverride: Double? = null)

@Serializable
data class DesignOverrideSet(val key: String, val assignments: List<DesignAssignment>)

@Serializable
data class ProductDesign(
    val id: Long? = null,
    val name: String,
    val assignments: List<DesignAssignment> = emptyList(),
    val overrideSets: List<DesignOverrideSet> = emptyList(),
    /** Net-new materials this colorway includes beyond its slot fills. */
    val extras: List<ExtraMaterial> = emptyList(),
)

@Serializable
data class SlotDelta(val slotPosition: Int, val deltaQty: Double? = null, val removed: Boolean = false)

@Serializable
data class VariantAdjustments(
    val slotDeltas: List<SlotDelta> = emptyList(),
    val extras: List<ExtraMaterial> = emptyList(),
    val laborDeltaMinutes: Int = 0,
)

@Serializable
data class ExtraMaterial(val materialId: Long, val quantity: Double)

@Serializable
data class ProductVariant(
    val id: Long? = null,
    val name: String,
    val adjustments: VariantAdjustments = VariantAdjustments(),
)

@SingleIn(AppScope::class)
@Inject
class DesignRepository {
    suspend fun designs(productId: Long): List<ProductDesign> = dbQuery {
        ProductDesignsTable.selectAll().where { ProductDesignsTable.productId eq productId }
            .orderBy(ProductDesignsTable.position).map {
                ProductDesign(
                    it[ProductDesignsTable.id], it[ProductDesignsTable.name],
                    it[ProductDesignsTable.assignments], it[ProductDesignsTable.overrideSets],
                    it[ProductDesignsTable.extras],
                )
            }
    }

    suspend fun variants(productId: Long): List<ProductVariant> = dbQuery {
        ProductVariantsTable.selectAll().where { ProductVariantsTable.productId eq productId }
            .orderBy(ProductVariantsTable.position).map {
                ProductVariant(it[ProductVariantsTable.id], it[ProductVariantsTable.name], it[ProductVariantsTable.adjustments])
            }
    }

    suspend fun design(id: Long): ProductDesign? = dbQuery {
        ProductDesignsTable.selectAll().where { ProductDesignsTable.id eq id }.singleOrNull()?.let {
            ProductDesign(it[ProductDesignsTable.id], it[ProductDesignsTable.name], it[ProductDesignsTable.assignments], it[ProductDesignsTable.overrideSets], it[ProductDesignsTable.extras])
        }
    }

    suspend fun variant(id: Long): ProductVariant? = dbQuery {
        ProductVariantsTable.selectAll().where { ProductVariantsTable.id eq id }.singleOrNull()?.let {
            ProductVariant(it[ProductVariantsTable.id], it[ProductVariantsTable.name], it[ProductVariantsTable.adjustments])
        }
    }

    /** Full-replace, keeping ids stable for referenced rows. */
    suspend fun saveDesigns(productId: Long, list: List<ProductDesign>): List<ProductDesign> {
        dbQuery {
            val kept = list.mapNotNull { it.id }.toSet()
            ProductDesignsTable.selectAll().where { ProductDesignsTable.productId eq productId }
                .map { it[ProductDesignsTable.id] }.filter { it !in kept }
                .forEach { dead -> ProductDesignsTable.deleteWhere { ProductDesignsTable.id eq dead } }
            list.forEachIndexed { pos, d ->
                if (d.id != null) {
                    ProductDesignsTable.update({ ProductDesignsTable.id eq d.id }) {
                        it[name] = d.name.trim(); it[position] = pos
                        it[assignments] = d.assignments; it[overrideSets] = d.overrideSets
                        it[extras] = d.extras
                    }
                } else {
                    ProductDesignsTable.insert {
                        it[ProductDesignsTable.productId] = productId
                        it[name] = d.name.trim(); it[position] = pos
                        it[assignments] = d.assignments; it[overrideSets] = d.overrideSets
                        it[extras] = d.extras
                    }
                }
            }
        }
        return designs(productId)
    }

    suspend fun saveVariants(productId: Long, list: List<ProductVariant>): List<ProductVariant> {
        dbQuery {
            val kept = list.mapNotNull { it.id }.toSet()
            ProductVariantsTable.selectAll().where { ProductVariantsTable.productId eq productId }
                .map { it[ProductVariantsTable.id] }.filter { it !in kept }
                .forEach { dead -> ProductVariantsTable.deleteWhere { ProductVariantsTable.id eq dead } }
            list.forEachIndexed { pos, v ->
                if (v.id != null) {
                    ProductVariantsTable.update({ ProductVariantsTable.id eq v.id }) {
                        it[name] = v.name.trim(); it[position] = pos; it[adjustments] = v.adjustments
                    }
                } else {
                    ProductVariantsTable.insert {
                        it[ProductVariantsTable.productId] = productId
                        it[name] = v.name.trim(); it[position] = pos; it[adjustments] = v.adjustments
                    }
                }
            }
        }
        return variants(productId)
    }
}

fun Route.designRoutes(designs: DesignRepository) {
    requireAdmin {
        get("/catalog/products/{id}/designs") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null) call.respond(HttpStatusCode.NotFound, ApiError("Product not found."))
            else call.respond(designs.designs(id))
        }
        put("/catalog/products/{id}/designs") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null) call.respond(HttpStatusCode.NotFound, ApiError("Product not found."))
            else call.respond(designs.saveDesigns(id, call.receive()))
        }
        get("/catalog/products/{id}/variants") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null) call.respond(HttpStatusCode.NotFound, ApiError("Product not found."))
            else call.respond(designs.variants(id))
        }
        put("/catalog/products/{id}/variants") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null) call.respond(HttpStatusCode.NotFound, ApiError("Product not found."))
            else call.respond(designs.saveVariants(id, call.receive()))
        }
    }
}
