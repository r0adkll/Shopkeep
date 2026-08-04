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
    val photoDocumentIds: List<Long> = emptyList(), // legacy: uploaded, ids unknown
    val photoMap: List<PhotoLink> = emptyList(), // local doc <-> etsy image (ordered)
    // legacy single-field projection — kept only so stored snapshots deserialize
    val personalizable: Boolean = false,
    val persRequired: Boolean = false,
    val persCharMax: Int? = null,
    val persInstructions: String = "",
    val persQuestions: List<PersQ> = emptyList(), // native questions normal form
)

/** Comparable normal form of one Etsy personalization question. */
@Serializable
data class PersQ(
    val text: String = "",
    val type: String = "text_input", // text_input | dropdown | unlabeled_upload | labeled_upload
    val instructions: String? = null,
    val required: Boolean = false,
    val maxChars: Int? = null,
    val maxFiles: Int? = null,
    val options: List<String> = emptyList(),
    val addOnMinor: Long? = null,
)

/** Etsy returns text HTML-entity-escaped; decode so round-trips diff clean. */
fun htmlDecode(s: String): String = s
    .replace("&quot;", "\"").replace("&#39;", "'")
    .replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&")

fun EtsyPersonalization?.toCanonicalPersonalization(): app.shopkeep.listings.Personalization? {
    val qs = this?.personalizationQuestions?.takeIf { it.isNotEmpty() } ?: return null
    return app.shopkeep.listings.Personalization(questions = qs.map { q ->
        app.shopkeep.listings.PersonalizationQuestion(
            type = when (q.questionType) {
                "dropdown" -> "dropdown"
                "unlabeled_upload", "labeled_upload" -> "file"
                else -> "text"
            },
            questionText = htmlDecode(q.questionText),
            instructions = q.instructions?.takeIf { it.isNotBlank() }?.let(::htmlDecode),
            required = q.required,
            maxChars = q.maxAllowedCharacters,
            maxFiles = q.maxAllowedFiles,
            options = q.options.orEmpty().map { htmlDecode(it.label) },
            addOnPriceMinor = q.addOnPrice?.minor?.takeIf { it > 0 },
        )
    })
}

@Serializable
data class PhotoLink(val docId: Long, val etsyImageId: Long)

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
        val ids = dbQuery {
            ListingsTable.selectAll().where { ListingsTable.etsyListingId.isNotNull() }
                .map { it[ListingsTable.id] to it[ListingsTable.etsyListingId]!! }
        }
        val archived = archivedIds()
        for ((id, etsyId) in ids) {
            val current = byId[etsyId] ?: continue
            val l = listings.get(id) ?: continue
            val changes = buildChanges(l, l.input.pushShapeActive(archived), current, baselineFor(id, etsyId))
            persistState(id, changes)
            dbQuery { ListingsTable.update({ ListingsTable.id eq id }) { it[platformState] = current.state } }
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
        return PushSnapshot(
            e.title, e.description, e.tags, price, e.quantity, e.state, axes,
            persQuestions = e.personalization?.personalizationQuestions.orEmpty().map { q ->
                PersQ(
                    text = htmlDecode(q.questionText),
                    type = q.questionType,
                    instructions = q.instructions?.takeIf { it.isNotBlank() }?.let(::htmlDecode),
                    required = q.required,
                    maxChars = q.maxAllowedCharacters,
                    maxFiles = q.maxAllowedFiles,
                    options = q.options.orEmpty().map { htmlDecode(it.label) },
                    addOnMinor = q.addOnPrice?.minor?.takeIf { it > 0 },
                )
            },
        )
    }

    private fun qSummary(q: PersQ): String {
        val bits = mutableListOf("“${q.text}”", q.type.removeSuffix("_input").replace("_", " "),
            if (q.required) "required" else "optional")
        q.maxChars?.let { bits += "max $it chars" }
        q.maxFiles?.let { bits += "max $it files" }
        if (q.options.isNotEmpty()) bits += "[${q.options.joinToString(" / ")}]"
        q.addOnMinor?.let { bits += "+$" + "%.2f".format(it / 100.0) }
        q.instructions?.let { bits += "— $it" }
        return bits.joinToString(" · ")
    }

    /** THE diff — single source of truth for every sync-state surface. */
    private fun buildChanges(
        l: app.shopkeep.listings.Listing,
        want: PushSnapshot,
        current: EtsyShopListing,
        baseline: PushSnapshot?,
    ): MutableList<PushChange> {
        val have = etsyShape(current)
        val changes = mutableListOf<PushChange>()
        fun field(section: String, name: String, old: String?, new: String?, base: String?) {
            if (old == new) return
            val drift = base != null && old != base
            changes += PushChange(section, name, old, new, if (drift) "drift" else "changed")
        }
        field("details", "Title", have.title, want.title, baseline?.title)
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
        // Personalization: one row per question slot (Etsy caps these low, so
        // index-wise comparison reads naturally in the review dialog).
        val nQ = maxOf(want.persQuestions.size, have.persQuestions.size)
        for (qi in 0 until nQ) {
            val oldS = have.persQuestions.getOrNull(qi)?.let(::qSummary)
            val newS = want.persQuestions.getOrNull(qi)?.let(::qSummary)
            if (oldS == newS) continue
            val baseS = baseline?.persQuestions?.getOrNull(qi)?.let(::qSummary)
            val drift = baseline != null && oldS != baseS
            val label = if (nQ > 1) "Personalization Q${qi + 1}" else "Personalization"
            val kind = if (drift) "drift" else if (oldS == null) "added" else if (newS == null) "removed" else "changed"
            changes += PushChange("details", label, oldS, newS, kind,
                if (kind == "removed") "buyers will no longer see this question" else null)
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
        val photoMap = baseline?.photoMap ?: emptyList()
        val legacy = (baseline?.photoDocumentIds ?: emptyList()).filter { d -> photoMap.none { it.docId == d } }
        val tracked = photoMap.map { it.docId } + legacy
        val localIds = l.input.imageDocumentIds
        val newPhotos = localIds.filter { it !in tracked }
        val removed = photoMap.filter { it.docId !in localIds }
        val removedLegacy = legacy.filter { it !in localIds }
        val keptMapped = localIds.filter { d -> photoMap.any { it.docId == d } }
        val reordered = keptMapped != photoMap.map { it.docId }.filter { it in localIds }
        if (newPhotos.isNotEmpty()) {
            val over = (current.images?.size ?: 0) - removed.size + newPhotos.size > 20
            changes += PushChange("photos", "Photos", null, "+${newPhotos.size} to upload", "added",
                if (over) "would exceed Etsy's 20-photo cap" else null)
        }
        if (removed.isNotEmpty()) {
            changes += PushChange("photos", "Photos", "${removed.size} removed locally", null, "removed", "will be deleted on Etsy")
        }
        if (removedLegacy.isNotEmpty()) {
            changes += PushChange("photos", "Photos", "${removedLegacy.size} removed locally", null, "removed",
                "no Etsy link for these (uploaded before tracking) — pull photos to relink, else they stay on Etsy")
        }
        if (reordered && removed.isEmpty() && newPhotos.isEmpty()) {
            changes += PushChange("photos", "Photos", "order on Etsy", "local order", "changed", "re-ranks on push")
        }
        return changes
    }

    /** Persist the outcome so list cards mirror whatever the diff last said. */
    private suspend fun persistState(listingId: Long, changes: List<PushChange>) {
        val state = when {
            changes.any { it.kind == "drift" } -> "drifted"
            changes.isNotEmpty() -> "pending"
            else -> "in_sync"
        }
        dbQuery {
            ListingsTable.update({ ListingsTable.id eq listingId }) {
                it[syncState] = state
                it[syncCheckedAt] = OffsetDateTime.now()
            }
        }
    }

    private suspend fun baselineFor(listingId: Long, etsyId: String): PushSnapshot? = dbQuery {
        ListingsTable.selectAll().where { ListingsTable.id eq listingId }.singleOrNull()
            ?.get(ListingsTable.pushedSnapshot)
    } ?: dbQuery {
        EtsyImportsTable.selectAll().where { EtsyImportsTable.etsyListingId eq etsyId }.singleOrNull()
            ?.get(EtsyImportsTable.payload)?.let { etsyShape(it) }
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
        val baseline = baselineFor(listingId, etsyId)
        val changes = buildChanges(l, want, current, baseline)
        persistState(listingId, changes)


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
        val current0 = connections.fetchListing(connId, etsyId)
        val readinessStateId = current0
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

        // 2b) personalization via the native questions API. POST replaces the
        // whole set; carry question/option ids by index so Etsy updates rather
        // than recreates. Empty desired set -> DELETE turns it off.
        val haveQs = current0?.let { etsyShape(it).persQuestions } ?: emptyList()
        if (want.persQuestions != haveQs) {
            if (want.persQuestions.isEmpty()) {
                connections.etsyWrite(connId, "DELETE", "/shops/$shopId/listings/$etsyId/personalization", "")?.let {
                    return fail(listingId, "personalization: $it")
                }
            } else {
                val rawQs = current0?.personalization?.personalizationQuestions ?: emptyList()
                val body = buildJsonObject {
                    putJsonArray("personalization_questions") {
                        want.persQuestions.forEachIndexed { qi, q ->
                            add(buildJsonObject {
                                rawQs.getOrNull(qi)?.questionId?.let { put("question_id", it) }
                                put("question_text", q.text)
                                q.instructions?.let { put("instructions", it) }
                                put("question_type", q.type)
                                put("required", q.required)
                                q.maxChars?.let { put("max_allowed_characters", it) }
                                q.maxFiles?.let { put("max_allowed_files", it) }
                                q.addOnMinor?.let { put("add_on_price", it / 100.0) }
                                if (q.options.isNotEmpty()) putJsonArray("options") {
                                    q.options.forEachIndexed { oi, label ->
                                        add(buildJsonObject {
                                            rawQs.getOrNull(qi)?.options?.getOrNull(oi)?.optionId?.let { put("option_id", it) }
                                            put("label", label)
                                        })
                                    }
                                }
                            })
                        }
                    }
                }
                // capability flag: without it Etsy limits writes to a single
                // text_input question and may drop the rest of the set
                connections.etsyWrite(connId, "POST", "/shops/$shopId/listings/$etsyId/personalization?supports_multiple_personalization_questions=true", body.toString())?.let {
                    return fail(listingId, "personalization: $it")
                }
            }
        }

        // 3) photos: full sync — delete removed, upload new at rank, re-rank moved
        val snap0 = dbQuery {
            ListingsTable.selectAll().where { ListingsTable.id eq listingId }.singleOrNull()
                ?.get(ListingsTable.pushedSnapshot)
        }
        val map0 = (snap0?.photoMap ?: emptyList()).toMutableList()
        val legacyIds = (snap0?.photoDocumentIds ?: emptyList()).filter { d -> map0.none { it.docId == d } }
        val localIds = l.input.imageDocumentIds
        for (link in map0.filter { it.docId !in localIds }) {
            connections.etsyDeleteImage(connId, etsyId, link.etsyImageId)?.let { return fail(listingId, "photos: $it") }
            map0.removeAll { it.docId == link.docId }
        }
        for ((pos, docId) in localIds.withIndex()) {
            if (map0.any { it.docId == docId } || docId in legacyIds) continue
            val doc = documents.get(docId) ?: continue
            val (err, imgId) = connections.etsyUploadImage(connId, etsyId, doc.third, "shopkeep-$docId.jpg", rank = pos + 1)
            if (err != null) return fail(listingId, "photos: $err")
            if (imgId != null) map0 += PhotoLink(docId, imgId)
        }
        for ((pos, docId) in localIds.withIndex()) {
            val link = map0.firstOrNull { it.docId == docId } ?: continue
            connections.etsyRankImage(connId, etsyId, link.etsyImageId, pos + 1)?.let { return fail(listingId, "photos: $it") }
        }
        val orderedMap = localIds.mapNotNull { d -> map0.firstOrNull { it.docId == d } }

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
                it[pushedSnapshot] = want.copy(
                    photoDocumentIds = legacyIds.filter { it in localIds },
                    photoMap = orderedMap,
                )
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
        val links = mutableListOf<PhotoLink>()
        for (img in current.images ?: emptyList()) {
            val url = img.urlFull ?: img.url570 ?: continue
            val bytes = connections.download(url) ?: continue
            links += PhotoLink(documents.save("listing-photo", "image/jpeg", "etsy-${img.listingImageId}.jpg", bytes), img.listingImageId)
        }
        if (links.isEmpty()) return 0
        listings.update(listingId, l.input.copy(imageDocumentIds = links.map { it.docId }))
        dbQuery {
            val snap = ListingsTable.selectAll().where { ListingsTable.id eq listingId }.singleOrNull()
                ?.get(ListingsTable.pushedSnapshot) ?: etsyShape(current)
            ListingsTable.update({ ListingsTable.id eq listingId }) {
                it[pushedSnapshot] = snap.copy(photoDocumentIds = emptyList(), photoMap = links)
            }
        }
        return links.size
    }

    /** Drift escape hatch: pull one Etsy field into the canonical listing. */
    suspend fun pullField(listingId: Long, fieldName: String): Boolean {
        val l = listings.get(listingId) ?: return false
        val etsyId = l.etsyListingId ?: return false
        val connId = connectionId() ?: return false
        val e = connections.fetchListing(connId, etsyId) ?: return false
        val cur = etsyShape(e)
        // "Personalization Q2"-style rows all pull the whole question set
        val input = when (fieldName.lowercase().let { if (it.startsWith("personalization")) "personalization" else it }) {
            "title" -> l.input.copy(title = cur.title)
            "description" -> l.input.copy(description = cur.description)
            "price" -> l.input.copy(basePriceMinor = cur.priceMinor)
            "quantity" -> l.input.copy(quantity = cur.quantity)
            "tags" -> l.input.copy(tags = cur.tags)
            "state" -> l.input.copy(state = if (cur.state in setOf("draft", "active", "inactive")) cur.state else "inactive") // sold_out/expired have no canonical twin
            // Etsy's questions land as canonical questions; compiling back
            // yields the same normal form, so the round-trip lands in_sync.
            "personalization" -> l.input.copy(personalization = e.personalization.toCanonicalPersonalization())
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
