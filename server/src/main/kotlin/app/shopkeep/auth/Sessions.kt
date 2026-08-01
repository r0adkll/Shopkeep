package app.shopkeep.auth

import app.shopkeep.db.dbQuery
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.server.sessions.SessionStorage
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.deleteWhere
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.upsert
import java.time.OffsetDateTime

/** What rides in the session cookie's server-side payload. */
@Serializable
data class UserSession(val userId: Long, val role: Role)

object SessionsTable : Table("sessions") {
    val id = text("id")
    val userId = long("user_id")
    val payload = text("payload")
    val expiresAt = timestampWithTimeZone("expires_at")
    override val primaryKey = PrimaryKey(id)
}

/**
 * Server-side session storage in Postgres (vault: D7 — no JWTs; revocation is a DELETE).
 * Ktor stores only an opaque id in the cookie.
 */
@SingleIn(AppScope::class)
@Inject
class PostgresSessionStorage : SessionStorage {
    private val ttlDays = 30L

    override suspend fun write(id: String, value: String) {
        val userId = Regex("\"userId\"\\s*:\\s*(\\d+)").find(value)?.groupValues?.get(1)?.toLongOrNull() ?: -1L
        dbQuery {
            SessionsTable.upsert {
                it[SessionsTable.id] = id
                it[SessionsTable.userId] = userId
                it[payload] = value
                it[expiresAt] = OffsetDateTime.now().plusDays(ttlDays)
            }
        }
    }

    override suspend fun read(id: String): String = dbQuery {
        SessionsTable.selectAll()
            .where { SessionsTable.id eq id }
            .singleOrNull()
            ?.takeIf { it[SessionsTable.expiresAt].isAfter(OffsetDateTime.now()) }
            ?.get(SessionsTable.payload)
    } ?: throw NoSuchElementException("Session $id not found")

    override suspend fun invalidate(id: String) {
        dbQuery { SessionsTable.deleteWhere { SessionsTable.id eq id } }
    }
}
