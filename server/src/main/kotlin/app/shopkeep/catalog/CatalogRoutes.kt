package app.shopkeep.catalog

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import kotlinx.serialization.Serializable

@Serializable
data class LaborRate(val rateMinor: Long)

@Serializable
data class ArchiveProductRequest(val archived: Boolean)

fun Route.catalogRoutes(products: ProductRepository) {
    authenticate(SESSION_AUTH) {
        get("/catalog/labor-rate") { call.respond(LaborRate(products.laborRateMinor())) }
        put("/catalog/labor-rate") {
            val req = call.receive<LaborRate>()
            products.setLaborRateMinor(req.rateMinor.coerceAtLeast(0))
            call.respond(LaborRate(products.laborRateMinor()))
        }

        get("/catalog/products") { call.respond(products.list()) }

        post("/catalog/products") {
            val input = call.receive<ProductInput>()
            val error = validate(input)
            if (error != null) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError(error))
                return@post
            }
            val id = products.create(input)
            call.respond(HttpStatusCode.Created, products.get(id)!!)
        }

        get("/catalog/products/{id}") {
            val p = call.parameters["id"]?.toLongOrNull()?.let { products.get(it) }
            if (p == null) call.respond(HttpStatusCode.NotFound, ApiError("Product not found."))
            else call.respond(p)
        }

        put("/catalog/products/{id}") {
            val id = call.parameters["id"]?.toLongOrNull()
            val input = call.receive<ProductInput>()
            val error = validate(input)
            when {
                error != null -> call.respond(HttpStatusCode.UnprocessableEntity, ApiError(error))
                id == null || !products.update(id, input) ->
                    call.respond(HttpStatusCode.NotFound, ApiError("Product not found."))
                else -> call.respond(products.get(id)!!)
            }
        }

        post("/catalog/products/{id}/archive") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<ArchiveProductRequest>()
            if (id == null || !products.setArchived(id, req.archived)) {
                call.respond(HttpStatusCode.NotFound, ApiError("Product not found."))
            } else {
                call.respond(products.get(id)!!)
            }
        }

        get("/catalog/products/{id}/configurations") {
            val configs = call.parameters["id"]?.toLongOrNull()?.let { products.configurations(it) }
            if (configs == null) call.respond(HttpStatusCode.NotFound, ApiError("Product not found."))
            else call.respond(configs)
        }
    }
}

private fun validate(input: ProductInput): String? {
    if (input.name.isBlank()) return "Product name is required."
    if (input.skuPrefix.isBlank()) return "SKU prefix is required."
    input.slots.forEachIndexed { i, s ->
        if (s.name.isBlank()) return "Slot ${i + 1} needs a name."
        if (s.quantity <= 0) return "Slot \"${s.name}\" needs a quantity above zero."
        when (s.kind) {
            SlotKind.FIXED -> if (s.fixedMaterialId == null) return "Slot \"${s.name}\" needs a material."
            SlotKind.CHOICE -> if (s.optionMaterialIds.isEmpty()) return "Slot \"${s.name}\" needs at least one allowed material."
            SlotKind.RULE -> if (s.optionMaterialIds.isEmpty()) return "Slot \"${s.name}\" needs candidate materials."
        }
    }
    input.rules.forEach { r ->
        if (r.whenSlot !in input.slots.indices || r.thenSlot !in input.slots.indices) return "Rule references a missing slot."
        if (input.slots[r.thenSlot].kind != SlotKind.RULE) return "Rules can only target rule-resolved slots."
        if (input.slots[r.whenSlot].kind != SlotKind.CHOICE) return "Rule conditions must reference a choice slot."
        if (r.whenMaterialIds.isEmpty()) return "A rule needs at least one condition material."
    }
    return null
}
