package app.shopkeep.auth

import io.ktor.http.HttpStatusCode
import io.ktor.server.application.install
import io.ktor.server.auth.authenticate
import io.ktor.server.auth.principal
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.application
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.sessions.clear
import io.ktor.server.sessions.get
import io.ktor.server.sessions.sessions
import io.ktor.server.sessions.set
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq

@Serializable
data class SetupStatus(val needsSetup: Boolean)

@Serializable
data class SetupRequest(val email: String, val displayName: String, val password: String)

@Serializable
data class LoginRequest(val email: String, val password: String)

@Serializable
data class ApiError(val message: String)

fun Route.authRoutes(users: UserRepository) {
    get("/setup/status") {
        call.respond(SetupStatus(needsSetup = users.count() == 0L))
    }

    // First-run setup wizard (vault: D7): only usable while zero users exist.
    post("/setup") {
        if (users.count() > 0L) {
            call.respond(HttpStatusCode.Conflict, ApiError("Setup has already been completed."))
            return@post
        }
        val req = call.receive<SetupRequest>()
        if (req.password.length < 10) {
            call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Password must be at least 10 characters."))
            return@post
        }
        val admin = users.createLocalUser(req.email, req.displayName, req.password, Role.ADMIN)
        call.sessions.set(UserSession(admin.id, admin.role))
        call.respond(HttpStatusCode.Created, admin)
    }

    post("/auth/login") {
        val req = call.receive<LoginRequest>()
        val user = users.authenticate(req.email, req.password)
        if (user == null) {
            call.respond(HttpStatusCode.Unauthorized, ApiError("Invalid email or password."))
        } else {
            call.sessions.set(UserSession(user.id, user.role))
            call.respond(user)
        }
    }

    authenticate(SESSION_AUTH) {
        post("/auth/logout") {
            call.sessions.clear<UserSession>()
            call.respond(HttpStatusCode.NoContent)
        }

        get("/auth/me") {
            val session = call.principal<UserSession>()!!
            val user = users.findById(session.userId)
            if (user == null) {
                call.sessions.clear<UserSession>()
                call.respond(HttpStatusCode.Unauthorized, ApiError("User no longer exists."))
            } else {
                call.respond(user)
            }
        }
    }
}

const val SESSION_AUTH = "session"

// Route-scoped RBAC plugin, per the Ktor custom-plugin pattern: runs after
// authentication and rejects non-admin sessions before the handler executes.
private val adminOnly = io.ktor.server.application.createRouteScopedPlugin("AdminOnly") {
    on(io.ktor.server.auth.AuthenticationChecked) { call ->
        val session = call.principal<UserSession>()
        if (session != null && session.role != Role.ADMIN) {
            call.respond(HttpStatusCode.Forbidden, ApiError("Admin access required."))
        }
    }
}

/** Route wrapper for role-gated areas, e.g. storefront config is admin-only (vault: Users & Auth). */
fun Route.requireAdmin(build: Route.() -> Unit) {
    authenticate(SESSION_AUTH) {
        install(adminOnly)
        build()
    }
}

/* ---------- user management (Users & Auth: admin-only) ---------- */

@Serializable
data class CreateUserRequest(val email: String, val displayName: String, val password: String, val role: Role)

@Serializable
data class SetRoleRequest(val role: Role)

@Serializable
data class SetPasswordRequest(val password: String)

@Serializable
data class SetDisabledRequest(val disabled: Boolean)

fun Route.userAdminRoutes(users: UserRepository) {
    requireAdmin {
        get("/users") { call.respond(users.list()) }

        post("/users") {
            val req = call.receive<CreateUserRequest>()
            if (req.email.isBlank() || req.displayName.isBlank() || req.password.length < 8) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Email, name, and a password of 8+ characters are required."))
                return@post
            }
            if (users.list().any { it.email == req.email.trim().lowercase() }) {
                call.respond(HttpStatusCode.Conflict, ApiError("A user with that email already exists."))
                return@post
            }
            call.respond(HttpStatusCode.Created, users.createLocalUser(req.email, req.displayName, req.password, req.role))
        }

        post("/users/{id}/role") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<SetRoleRequest>()
            val self = call.sessions.get<UserSession>()
            when {
                id == null -> call.respond(HttpStatusCode.NotFound, ApiError("User not found."))
                id == self?.userId -> call.respond(HttpStatusCode.UnprocessableEntity, ApiError("You can't change your own role — ask another admin."))
                req.role == Role.MANAGER && users.findById(id)?.role == Role.ADMIN && users.adminCount() <= 1 ->
                    call.respond(HttpStatusCode.UnprocessableEntity, ApiError("That's the last active admin."))
                else -> { users.setRole(id, req.role); call.respond(users.findById(id)!!) }
            }
        }

        post("/users/{id}/password") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<SetPasswordRequest>()
            when {
                id == null || users.findById(id) == null -> call.respond(HttpStatusCode.NotFound, ApiError("User not found."))
                req.password.length < 8 -> call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Password needs 8+ characters."))
                else -> { users.setPassword(id, req.password); call.respond(mapOf("ok" to true)) }
            }
        }

        post("/users/{id}/disabled") {
            val id = call.parameters["id"]?.toLongOrNull()
            val req = call.receive<SetDisabledRequest>()
            val self = call.sessions.get<UserSession>()
            val target = id?.let { users.findById(it) }
            when {
                id == null || target == null -> call.respond(HttpStatusCode.NotFound, ApiError("User not found."))
                id == self?.userId -> call.respond(HttpStatusCode.UnprocessableEntity, ApiError("You can't disable yourself."))
                req.disabled && target.role == Role.ADMIN && users.adminCount() <= 1 ->
                    call.respond(HttpStatusCode.UnprocessableEntity, ApiError("That's the last active admin."))
                else -> {
                    users.setDisabled(id, req.disabled)
                    if (req.disabled) revokeSessionsFor(id)
                    call.respond(users.findById(id)!!)
                }
            }
        }
    }
}

/** Disabling someone must end their live sessions immediately. */
private suspend fun revokeSessionsFor(userId: Long) = app.shopkeep.db.dbQuery {
    SessionsTable.deleteWhere { SessionsTable.userId eq userId }
}
