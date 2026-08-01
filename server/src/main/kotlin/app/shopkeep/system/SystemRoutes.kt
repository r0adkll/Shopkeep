package app.shopkeep.system

import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.db.dbQuery
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.upsert
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

@Serializable
data class Health(val status: String, val version: String)

@Serializable
data class BackupStatus(val lastBackupAt: String?)

object BackupMarkerTable : Table("backup_marker") {
    val id = bool("id")
    val lastBackupAt = timestampWithTimeZone("last_backup_at")
    override val primaryKey = PrimaryKey(id)
}

fun Route.systemRoutes(version: String) {
    get("/health") {
        call.respond(Health(status = "ok", version = version))
    }

    // Pinged by the deploy/compose.yaml backup service after each successful pg_dump
    // (vault: D12). Unauthenticated by design — it can only ever set a timestamp, and
    // the backup container has no credentials.
    post("/system/backup-marker") {
        val now = OffsetDateTime.now()
        dbQuery {
            BackupMarkerTable.upsert {
                it[id] = true
                it[lastBackupAt] = now
            }
        }
        call.respond(BackupStatus(now.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)))
    }

    authenticate(SESSION_AUTH) {
        get("/system/backup-status") {
            val last = dbQuery {
                BackupMarkerTable.selectAll().singleOrNull()?.get(BackupMarkerTable.lastBackupAt)
            }
            call.respond(BackupStatus(last?.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)))
        }
    }
}
