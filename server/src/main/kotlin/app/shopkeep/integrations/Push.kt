package app.shopkeep.integrations

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.requireAdmin
import app.shopkeep.db.dbQuery
import app.shopkeep.listings.ListingRepository
import app.shopkeep.listings.pushShape
import app.shopkeep.listings.pushShapeActive
import app.shopkeep.listings.ListingsTable
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.http.HttpStatusCode
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.add
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update
import java.time.OffsetDateTime

/* D17 review & push (locked 2026-08-03): nothing writes to Etsy without the
 * review screen; push order is inventory -> details -> state; drift baseline
 * is the last pushed snapshot (imported listings seed from import payload). */

@Serializable
data class PushSnapshot(
    val title: String = "",
    val description: String = "",
    val tags: List<String> = emptyList(),
    val priceMinor: Long = 0,
    val quantity: Int = 0,
    val state: String = "",
    val variations: Map<String, List<String>> = emptyMap(),
    val photoDocumentIds: List<Long> = emptyList(), // local photos already uploaded
)

@Serializable
data class PushChange(
    val section: String, // details | variations
    val field: String,
    val oldValue: String?,
    val newValue: String?,
    val kind: String, // added | changed | removed | drift
    val note: String? = null,
)

@Serializable
data class PushPreview(
    val listingId: Long,
    val etsyListingId: String?,
    val changes: List<PushChange>,
    val driftCount: Int,
    val renewal: Boolean,
    val comboCount: Int,
    val canPush: Boolean,
    val blockedReason: String? = null,
)

@Serializable
data class PushResult(val ok: Boolean, val error: String? = null)

@Serializable
data class PullFieldRequest(val field: String)

private const val CUSTOM_PROP_1 = 513L
private const val CUSTOM_PROP_2 = 514L

@SingleIn(AppScope::class)
@Inject
class PushService(
    private val connections: ConnectionRepository,
    private val listings: ListingRepository,
    private val documents: app.shopkeep.documents.DocumentRepository,
) {
    private suspend fun connectionId(): Long? = connections.connectedIds().firstOrNull()

    private suspend fun archivedIds(): Set<Long> = dbQuery {
        app.shopkeep.inventory.MaterialsTable.selectAll()
            .where { app.shopkeep.inventory.MaterialsTable.archivedAt.isNotNull() }
            .map { it[app.shopkeep.inventory.MaterialsTable.id] }.toSet()
    }

    /** The desired platform shape — archived-material values excluded. */
    private suspend fun desired(listingId: Long): Pair<PushSnapshot, app.shopkeep.listings.Listing>? {
        val l = listings.get(listingId) ?: return null
        return l.input.pushShapeActive(archivedIds()) to l
    }

    /** Background drift check: one shop-listings fetch covers every linked
     *  listing; drift = Etsy differing from the last-pushed baseline. Runs
     *  each poll cycle so list views read fresh state without ad-hoc fetches. */
    suspend fun refreshSyncStates(connectionId: Long) {
        val platform = connections.fetchShopListings(connectionId) ?: return
        val byId = platform.associateBy { it.listingId.toString() }
        val rows = dbQuery {
            ListingsTable.selectAll().where { ListingsTable.etsyListingId.isNotNull() }.map {
                Triple(it[ListingsTable.id], it[ListingsTable.etsyListingId]!!, it[ListingsTable.pushedSnapshot])
            }
        }
        val now = OffsetDateTime.now()
        for ((id, etsyId, snapshot) in rows) {
            val current = byId[etsyId] ?: continue
            val drifted = snapshot != null && etsyShape(current) != snapshot
            dbQuery {
                ListingsTable.update({ ListingsTable.id eq id }) {
                    it[syncState] = if (drifted) "drifted" else "in_sync"
                    it[platformState] = current.state
                    it[syncCheckedAt] = now
                }
            }
        }
    }

    private fun etsyShape(e: EtsyShopListing): PushSnapshot {
        val axes = linkedMapOf<String, MutableList<String>>()
        e.inventory?.products?.forEach { p ->
            p.propertyValues.forEach { pv ->
                val list = axes.getOrPut(pv.propertyName) { mutableListOf() }
                pv.values.forEach { v -> if (v !in list) list.add(v) }
            }
        }
        val price = e.inventory?.products?.firstOrNull()?.offerings?.firstOrNull()?.price?.minor ?: 0
        return PushSnapshot(e.title, e.description, e.tags, price, e.quantity, e.state, axes)
    }

    suspend fun preview(listingId: Long): PushPreview {
        val (want, l) = desired(listingId) ?: return PushPreview(listingId, null, emptyList(), 0, false, 0, false, "Listing not found.")
        val etsyId = l.etsyListingId
            ?: return PushPreview(listingId, null, emptyList(), 0, false, 0, false, "Not linked to Etsy yet — v1 pushes updates to linked listings (create the draft on Etsy or import first).")
        val connId = connectionId()
            ?: return PushPreview(listingId, etsyId, emptyList(), 0, false, 0, false, "No connected Etsy shop.")
        val current = connections.fetchListing(connId, etsyId)
            ?: return PushPreview(listingId, etsyId, emptyList(), 0, false, 0, false, "Couldn't fetch the listing from Etsy.")
        val have = etsyShape(current)
        val baseline: PushSnapshot? = dbQuery {
            ListingsTable.selectAll().where { ListingsTable.id eq listingId }.singleOrNull()
                ?.get(ListingsTable.pushedSnapshot)
        } ?: dbQuery {
            EtsyImportsTable.selectAll().where { EtsyImportsTable.etsyListingId eq etsyId }.singleOrNull()
                ?.get(EtsyImportsTable.payload)?.let { etsyShape(it) }
        }

        val changes = mutableListOf<PushChange>()
        fun field(section: String, name: String, old: String?, new: String?, base: String?) {
            if (old == new) return
            val drift = base != null && old != base
            changes += PushChange(section, name, old, new, if (drift) "drift" else "changed")
        }
        field("details", "Title", have.title, want.title, baseline?.title)
        // full text on the wire; the review UI truncates collapsed rows and
        // renders a word-level merged diff when expanded
        if (have.description != want.description) {
            val drift = baseline != null && have.description != baseline.description
            changes += PushChange("details", "Description", have.description, want.description, if (drift) "drift" else "changed")
        }
        field("details", "Price", "$" + "%.2f".format(have.priceMinor / 100.0), "$" + "%.2f".format(want.priceMinor / 100.0), baseline?.let { "$" + "%.2f".format(it.priceMinor / 100.0) })
        field("details", "Quantity", have.quantity.toString(), want.quantity.toString(), baseline?.quantity?.toString())
        field("details", "State", have.state, want.state, baseline?.state)
        if (have.tags.toSet() != want.tags.toSet()) {
            changes += PushChange("details", "Tags", have.tags.joinToString(", "), want.tags.joinToString(", "),
                if (baseline != null && have.tags.toSet() != baseline.tags.toSet()) "drift" else "changed")
        }
        for ((axis, wantVals) in want.variations) {
            val haveVals = have.variations.entries.firstOrNull { it.key.equals(axis, true) }?.value ?: emptyList()
            wantVals.filter { wv -> haveVals.none { it.equals(wv, true) } }.forEach {
                changes += PushChange("variations", axis, null, it, "added")
            }
            haveVals.filter { hv -> wantVals.none { it.equals(hv, true) } }.forEach {
                changes += PushChange("variations", axis, it, null, "removed", "buyers can no longer order this value")
            }
        }
        have.variations.keys.filter { hk -> want.variations.keys.none { it.equals(hk, true) } }.forEach {
            changes += PushChange("variations", it, "axis on Etsy", null, "removed", "whole axis removed")
        }

        // Photos: additive-only (locked concept). New = local photos not yet
        // recorded as uploaded in the snapshot.
        val uploaded = baseline?.photoDocumentIds ?: emptyList()
        val newPhotos = l.input.imageDocumentIds.filter { it !in uploaded }
        if (newPhotos.isNotEmpty()) {
            val etsyCount = current.images?.size ?: 0
            val over = etsyCount + newPhotos.size > 20
            changes += PushChange(
                "photos", "Photos", "$etsyCount on Etsy", "+${newPhotos.size} to upload", "added",
                if (over) "would exceed Etsy's 20-photo cap" else null,
            )
        }

        val comboCount = want.variations.values.fold(1) { a, v -> a * maxOf(v.size, 1) }
        val renewal = have.state == "sold_out" && want.quantity > 0 && want.state == "active"
        val blocked = if (comboCount > 400) "Over Etsy's 400-combination cap ($comboCount)." else null
        return PushPreview(listingId, etsyId, changes, changes.count { it.kind == "drift" }, renewal, comboCount, blocked == null && changes.isNotEmpty(), blocked)
    }

    suspend fun push(listingId: Long): PushResult {
        val pv = preview(listingId)
        if (!pv.canPush) return PushResult(false, pv.blockedReason ?: "Nothing to push.")
        val (want, l) = desired(listingId)!!
        val connId = connectionId()!!
        val shopId = connections.creds(connId)?.shopId ?: return PushResult(false, "No shop id.")
        val etsyId = pv.etsyListingId!!

        // 1) inventory: cartesian products matrix with SKUs per mode.
        // Etsy requires readiness_state_id on every offering — carry the
        // listing's current one (processing profile readiness state).
        val readinessStateId = connections.fetchListing(connId, etsyId)
            ?.inventory?.products?.firstOrNull()?.offerings?.firstOrNull()?.readinessStateId
        val dead = archivedIds()
        val axes = l.input.axes.map { ax -> ax to ax.values.filter { it.offered && (it.materialId == null || it.materialId !in dead) } }
        if (axes.isNotEmpty()) {
            var combos = listOf(listOf<Pair<Int, app.shopkeep.listings.AxisValueInput>>())
            axes.forEachIndexed { ai, (_, vals) ->
                combos = combos.flatMap { c -> vals.map { c + (ai to it) } }
            }
            val propIds = listOf(CUSTOM_PROP_1, CUSTOM_PROP_2)
            val skuMode = l.input.skuMode
            val body = buildJsonObject {
                putJsonArray("products") {
                    combos.forEach { combo ->
                        add(buildJsonObject {
                            val sku = when (skuMode) {
                                "listing_level" -> l.input.listingSku ?: ""
                                "per_primary" -> combo.firstOrNull()?.second?.platformSku ?: l.input.listingSku ?: ""
                                else -> {
                                    val labels = combo.map { (ai, v) -> v.displayLabel ?: v.platformValue ?: "?" }
                                    l.input.comboSkus.firstOrNull { it.values == labels }?.sku
                                        ?: labels.joinToString("-") { it.replace(Regex("[^A-Za-z0-9]"), "").take(4).uppercase() }
                                }
                            }
                            if (sku.isNotBlank()) put("sku", sku)
                            putJsonArray("property_values") {
                                combo.forEach { (ai, v) ->
                                    add(buildJsonObject {
                                        put("property_id", propIds.getOrElse(ai) { 515L })
                                        put("property_name", l.input.axes[ai].displayName)
                                        putJsonArray("values") { add(v.displayLabel ?: v.platformValue ?: "?") }
                                    })
                                }
                            }
                            putJsonArray("offerings") {
                                add(buildJsonObject {
                                    val minor = combo.firstOrNull()?.second?.priceOverrideMinor ?: want.priceMinor
                                    put("price", minor / 100.0)
                                    put("quantity", want.quantity)
                                    put("is_enabled", true)
                                    if (readinessStateId != null) put("readiness_state_id", readinessStateId)
                                })
                            }
                        })
                    }
                }
                if (skuMode == "per_primary") putJsonArray("sku_on_property") { add(CUSTOM_PROP_1) }
                if (skuMode == "per_combination") putJsonArray("sku_on_property") { propIds.take(axes.size).forEach { add(it) } }
                val hasPriceOverride = axes.firstOrNull()?.second?.any { it.priceOverrideMinor != null } == true
                if (hasPriceOverride) putJsonArray("price_on_property") { add(CUSTOM_PROP_1) }
            }
            connections.etsyWrite(connId, "PUT", "/listings/$etsyId/inventory", body.toString())?.let {
                return fail(listingId, "inventory: $it")
            }
        }

        // 2) details (form-encoded updateListing)
        val details = buildJsonObject {
            put("title", want.title)
            put("description", want.description)
            if (want.tags.isNotEmpty()) put("tags", want.tags.joinToString(","))
        }
        connections.etsyWriteForm(connId, "/shops/$shopId/listings/$etsyId", details)?.let {
            return fail(listingId, "details: $it")
        }

        // 3) photos: additive-only uploads for local photos not yet on Etsy
        val previouslyUploaded = dbQuery {
            ListingsTable.selectAll().where { ListingsTable.id eq listingId }.singleOrNull()
                ?.get(ListingsTable.pushedSnapshot)?.photoDocumentIds
        } ?: emptyList()
        val uploadedNow = mutableListOf<Long>()
        for (docId in l.input.imageDocumentIds.filter { it !in previouslyUploaded }) {
            val doc = documents.get(docId) ?: continue
            connections.etsyUploadImage(connId, etsyId, doc.third, "shopkeep-$docId.jpg")?.let {
                return fail(listingId, "photos: $it (uploaded ${uploadedNow.size} before failing)")
            }
            uploadedNow += docId
        }

        // 4) state last (renewal takes the fresh quantities)
        val currentState = connections.fetchListing(connId, etsyId)?.state
        if (currentState != null && currentState != want.state && want.state in setOf("active", "draft", "inactive")) {
            val stateBody = buildJsonObject { put("state", want.state) }
            connections.etsyWriteForm(connId, "/shops/$shopId/listings/$etsyId", stateBody)?.let {
                return fail(listingId, "state: $it")
            }
        }

        dbQuery {
            ListingsTable.update({ ListingsTable.id eq listingId }) {
                it[pushedSnapshot] = want.copy(photoDocumentIds = (previouslyUploaded + uploadedNow).distinct())
                it[syncState] = "in_sync"
                it[lastPushedAt] = OffsetDateTime.now()
                it[lastPushError] = null
                it[platformState] = want.state
            }
        }
        return PushResult(true)
    }

    private suspend fun fail(listingId: Long, msg: String): PushResult {
        dbQuery { ListingsTable.update({ ListingsTable.id eq listingId }) { it[lastPushError] = msg } }
        return PushResult(false, msg)
    }

    /** Photo pull: make local match Etsy — download its images into the
     *  document store, replace the listing's photo set, and record them as
     *  already-uploaded so nothing re-pushes. */
    suspend fun pullPhotos(listingId: Long): Int? {
        val l = listings.get(listingId) ?: return null
        val etsyId = l.etsyListingId ?: return null
        val connId = connectionId() ?: return null
        val current = connections.fetchListing(connId, etsyId) ?: return null
        val ids = mutableListOf<Long>()
        for (img in current.images ?: emptyList()) {
            val url = img.urlFull ?: img.url570 ?: continue
            val bytes = connections.download(url) ?: continue
            ids += documents.save("listing-photo", "image/jpeg", "etsy-${img.listingImageId}.jpg", bytes)
        }
        if (ids.isEmpty()) return 0
        listings.update(listingId, l.input.copy(imageDocumentIds = ids))
        dbQuery {
            val snap = ListingsTable.selectAll().where { ListingsTable.id eq listingId }.singleOrNull()
                ?.get(ListingsTable.pushedSnapshot) ?: etsyShape(current)
            ListingsTable.update({ ListingsTable.id eq listingId }) {
                it[pushedSnapshot] = snap.copy(photoDocumentIds = ids)
            }
        }
        return ids.size
    }

    /** Drift escape hatch: pull one Etsy field into the canonical listing. */
    suspend fun pullField(listingId: Long, fieldName: String): Boolean {
        val l = listings.get(listingId) ?: return false
        val etsyId = l.etsyListingId ?: return false
        val connId = connectionId() ?: return false
        val e = connections.fetchListing(connId, etsyId) ?: return false
        val cur = etsyShape(e)
        val input = when (fieldName.lowercase()) {
            "title" -> l.input.copy(title = cur.title)
            "description" -> l.input.copy(description = cur.description)
            "price" -> l.input.copy(basePriceMinor = cur.priceMinor)
            "quantity" -> l.input.copy(quantity = cur.quantity)
            "tags" -> l.input.copy(tags = cur.tags)
            "state" -> l.input.copy(state = if (cur.state in setOf("draft", "active", "inactive")) cur.state else "inactive") // sold_out/expired have no canonical twin
            else -> return false
        }
        return listings.update(listingId, input)
    }
}

fun Route.pushRoutes(push: PushService) {
    requireAdmin {
        get("/listings/{id}/push-preview") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null) call.respond(HttpStatusCode.NotFound, ApiError("Listing not found."))
            else call.respond(push.preview(id))
        }
        post("/listings/{id}/push") {
            val id = call.parameters["id"]?.toLongOrNull()
            if (id == null) { call.respond(HttpStatusCode.NotFound, ApiError("Listing not found.")); return@post }
            val r = push.push(id)
            if (r.ok) call.respond(r) else call.respond(HttpStatusCode.UnprocessableEntity, r)
        }
        post("/listings/{id}/pull-photos") {
            val n = call.parameters["id"]?.toLongOrNull()?.let { push.pullPhotos(it) }
            if (n == null) call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Couldn't pull photos from Etsy."))
            else call.respond(mapOf("pulled" to n))
        }

        post("/listings/{id}/pull-field") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<PullFieldRequest>()
            if (id == null || !push.pullField(id, req.field)) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Couldn't pull ${req.field} from Etsy."))
            } else call.respond(PushResult(true))
        }
    }
}
