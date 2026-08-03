package app.shopkeep.listings

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put

fun Route.listingRoutes(listings: ListingRepository) {
    authenticate(SESSION_AUTH) {
        /* packaging profiles (D14) */
        get("/packaging-profiles") { call.respond(listings.listProfiles()) }
        post("/packaging-profiles") {
            val input = call.receive<PackagingProfileInput>()
            val err = validateProfile(input)
            if (err != null) return@post call.respond(HttpStatusCode.UnprocessableEntity, ApiError(err))
            val id = listings.saveProfile(null, input)
            call.respond(HttpStatusCode.Created, listings.listProfiles().first { it.id == id })
        }
        put("/packaging-profiles/{id}") {
            val id = call.parameters["id"]?.toLongOrNull()
                ?: return@put call.respond(HttpStatusCode.NotFound, ApiError("Profile not found."))
            val input = call.receive<PackagingProfileInput>()
            val err = validateProfile(input)
            if (err != null) return@put call.respond(HttpStatusCode.UnprocessableEntity, ApiError(err))
            listings.saveProfile(id, input)
            call.respond(listings.listProfiles().first { it.id == id })
        }

        /* listings */
        get("/listings") {
            call.respond(listings.list(call.request.queryParameters["includeArchived"] == "true"))
        }

        delete("/listings/{id}") {
            val id = call.parameters["id"]?.toLongOrNull()
            when (id?.let { listings.delete(it) } ?: ListingRepository.DeleteResult.NOT_FOUND) {
                ListingRepository.DeleteResult.DELETED -> call.respond(HttpStatusCode.NoContent)
                ListingRepository.DeleteResult.NOT_FOUND -> call.respond(HttpStatusCode.NotFound, ApiError("Listing not found."))
                ListingRepository.DeleteResult.PUBLISHED -> call.respond(
                    HttpStatusCode.Conflict,
                    ApiError("This listing has been published to a platform — archive it instead. Platform-side removal (deactivate vs delete on Etsy) is chosen at archive time once Etsy is connected."),
                )
            }
        }
        post("/listings") {
            val input = call.receive<ListingInput>()
            val err = validateListing(input)
            if (err != null) return@post call.respond(HttpStatusCode.UnprocessableEntity, ApiError(err))
            try {
                call.respond(HttpStatusCode.Created, listings.get(listings.create(input))!!)
            } catch (e: org.jetbrains.exposed.exceptions.ExposedSQLException) {
                if (e.message?.contains("listing_configurations_sku_key") == true) {
                    call.respond(HttpStatusCode.Conflict, ApiError("A configuration SKU from this product is already pinned by another listing — SKUs must be globally unique for order matching."))
                } else throw e
            }
        }
        get("/listings/{id}") {
            val listing = call.parameters["id"]?.toLongOrNull()?.let { listings.get(it) }
            if (listing == null) call.respond(HttpStatusCode.NotFound, ApiError("Listing not found."))
            else call.respond(listing)
        }
        put("/listings/{id}") {
            val id = call.parameters["id"]?.toLongOrNull()
            val input = call.receive<ListingInput>()
            val err = validateListing(input)
            when {
                err != null -> call.respond(HttpStatusCode.UnprocessableEntity, ApiError(err))
                id == null || !listings.update(id, input) -> call.respond(HttpStatusCode.NotFound, ApiError("Listing not found."))
                else -> call.respond(listings.get(id)!!)
            }
        }
        post("/listings/{id}/archive") {
            val id = call.parameters["id"]?.toLongOrNull()
            val archived = call.receive<Map<String, Boolean>>()["archived"] ?: true
            if (id == null || !listings.setArchived(id, archived)) {
                call.respond(HttpStatusCode.NotFound, ApiError("Listing not found."))
            } else call.respond(listings.get(id)!!)
        }

        /** Packaging resolution for an order's unit count — used by Phase 4's queue. */
        get("/listings/{id}/packaging") {
            val id = call.parameters["id"]?.toLongOrNull()
            val units = call.request.queryParameters["units"]?.toIntOrNull()
            val listing = id?.let { listings.get(it) }
            when {
                listing == null -> call.respond(HttpStatusCode.NotFound, ApiError("Listing not found."))
                units == null || units < 1 -> call.respond(HttpStatusCode.UnprocessableEntity, ApiError("units must be >= 1"))
                listing.input.packagingProfileId == null ->
                    call.respond(PackagingResolution(null, adhoc = false, unresolved = true))
                else -> call.respond(listings.resolvePackaging(listing.input.packagingProfileId!!, units))
            }
        }
    }
}

private fun validateProfile(input: PackagingProfileInput): String? {
    if (input.name.isBlank()) return "Profile name is required."
    if (input.bands.isEmpty()) return "At least one band is required."
    var expected = 1
    input.bands.forEachIndexed { i, b ->
        if (b.kind !in setOf("stocked", "adhoc")) return "Band ${i + 1}: kind must be stocked or adhoc."
        if (b.minQty != expected) return "Bands must be contiguous: band ${i + 1} should start at $expected."
        if (b.maxQty != null && b.maxQty < b.minQty) return "Band ${i + 1}: max below min."
        if (b.maxQty == null && i != input.bands.lastIndex) return "Only the last band may be open-ended."
        expected = (b.maxQty ?: return null) + 1
    }
    return null
}

private fun validateListing(input: ListingInput): String? {
    if (input.title.isBlank()) return "Title is required."
    if (input.axes.size > 3) return "Platforms support at most 3 variation axes."
    if (input.state !in setOf("draft", "active", "inactive")) return "Invalid state."
    if (input.skuMode !in setOf("per_combination", "per_primary", "listing_level")) return "Invalid SKU mode."
    if (input.axes.any { a -> a.valueSource !in setOf("materials", "designs", "variants", "override_sets") }) return "Invalid axis value source."
    if (input.extras.any { it.basis !in setOf("per_order", "per_unit") }) return "Extra basis must be per_order or per_unit."
    return null
}
