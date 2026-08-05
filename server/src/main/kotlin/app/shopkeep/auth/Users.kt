package app.shopkeep.auth

import app.shopkeep.db.dbQuery
import com.password4j.Password
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.update

enum class Role { ADMIN, MANAGER }

@Serializable
data class User(
    val id: Long,
    val email: String,
    val displayName: String,
    val role: Role,
    val disabled: Boolean = false,
    /** local (password), oidc, or both — admins see how someone signs in. */
    val authVia: String = "local",
)

object UsersTable : Table("users") {
    val id = long("id").autoIncrement()
    val email = text("email").uniqueIndex()
    val displayName = text("display_name")
    val passwordHash = text("password_hash").nullable()
    val oidcSubject = text("oidc_subject").nullable().uniqueIndex()
    val role = text("role")
    val disabled = bool("disabled").default(false)
    override val primaryKey = PrimaryKey(id)
}

@SingleIn(AppScope::class)
@Inject
class PasswordHasher {
    fun hash(plain: String): String = Password.hash(plain).addRandomSalt().withArgon2().result

    fun verify(plain: String, hash: String): Boolean = Password.check(plain, hash).withArgon2()
}

@SingleIn(AppScope::class)
@Inject
class UserRepository(private val hasher: PasswordHasher) {

    suspend fun count(): Long = dbQuery { UsersTable.selectAll().count() }

    suspend fun createLocalUser(email: String, displayName: String, password: String, role: Role): User = dbQuery {
        val normalized = email.trim().lowercase()
        val id = UsersTable.insert {
            it[UsersTable.email] = normalized
            it[UsersTable.displayName] = displayName.trim()
            it[passwordHash] = hasher.hash(password)
            it[UsersTable.role] = role.name.lowercase()
        } get UsersTable.id
        User(id, normalized, displayName.trim(), role)
    }

    suspend fun authenticate(email: String, password: String): User? = dbQuery {
        val row = UsersTable.selectAll()
            .where { UsersTable.email eq email.trim().lowercase() }
            .singleOrNull() ?: return@dbQuery null
        if (row[UsersTable.disabled]) return@dbQuery null
        val hash = row[UsersTable.passwordHash] ?: return@dbQuery null
        if (hasher.verify(password, hash)) row.toUser() else null
    }

    suspend fun list(): List<User> = dbQuery {
        UsersTable.selectAll().orderBy(UsersTable.id).map { it.toUser() }
    }

    suspend fun adminCount(): Long = dbQuery {
        UsersTable.selectAll().count { it[UsersTable.role] == "admin" && !it[UsersTable.disabled] }.toLong()
    }

    suspend fun setRole(id: Long, role: Role): Boolean = dbQuery {
        UsersTable.update({ UsersTable.id eq id }) { it[UsersTable.role] = role.name.lowercase() } > 0
    }

    suspend fun setPassword(id: Long, plain: String): Boolean = dbQuery {
        UsersTable.update({ UsersTable.id eq id }) { it[passwordHash] = hasher.hash(plain) } > 0
    }

    /** Soft-disable; sessions are revoked by the caller. Never delete —
     *  notes/events keep their author provenance. */
    suspend fun setDisabled(id: Long, disabled: Boolean): Boolean = dbQuery {
        UsersTable.update({ UsersTable.id eq id }) { it[UsersTable.disabled] = disabled } > 0
    }

    suspend fun findById(id: Long): User? = dbQuery {
        UsersTable.selectAll().where { UsersTable.id eq id }.singleOrNull()?.toUser()
    }

    /**
     * OIDC login (vault: D10): match by subject first; otherwise link to an existing
     * account with the same (provider-verified) email; otherwise provision a new
     * `manager` — an admin promotes from there.
     */
    suspend fun findOrCreateOidcUser(subject: String, email: String, displayName: String): User = dbQuery {
        val normalized = email.trim().lowercase()

        UsersTable.selectAll().where { UsersTable.oidcSubject eq subject }.singleOrNull()?.let {
            return@dbQuery it.toUser()
        }

        val byEmail = UsersTable.selectAll().where { UsersTable.email eq normalized }.singleOrNull()
        if (byEmail != null) {
            UsersTable.update({ UsersTable.id eq byEmail[UsersTable.id] }) {
                it[oidcSubject] = subject
            }
            return@dbQuery byEmail.toUser()
        }

        val id = UsersTable.insert {
            it[UsersTable.email] = normalized
            it[UsersTable.displayName] = displayName.trim()
            it[passwordHash] = null
            it[oidcSubject] = subject
            it[role] = Role.MANAGER.name.lowercase()
        } get UsersTable.id
        User(id, normalized, displayName.trim(), Role.MANAGER)
    }

    private fun ResultRow.toUser() = User(
        id = this[UsersTable.id],
        email = this[UsersTable.email],
        displayName = this[UsersTable.displayName],
        role = Role.valueOf(this[UsersTable.role].uppercase()),
        disabled = this[UsersTable.disabled],
        authVia = when {
            this[UsersTable.passwordHash] != null && this[UsersTable.oidcSubject] != null -> "both"
            this[UsersTable.oidcSubject] != null -> "oidc"
            else -> "local"
        },
    )
}
