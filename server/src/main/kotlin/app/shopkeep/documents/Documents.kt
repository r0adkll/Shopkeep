package app.shopkeep.documents

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.db.dbQuery
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.contentType
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.selectAll

/** Binary storage in Postgres — deliberately, so pg_dump is a complete backup (vault: D12). */

object DocumentsTable : Table("documents") {
    val id = long("id").autoIncrement()
    val kind = text("kind")
    val contentType = text("content_type")
    val filename = text("filename").nullable()
    val bytes = binary("bytes")
    val createdAt = timestampWithTimeZone("created_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class DocumentRef(val id: Long)

private const val MAX_BYTES = 5 * 1024 * 1024
private val ALLOWED_IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")

@SingleIn(AppScope::class)
@Inject
class DocumentRepository {
    suspend fun save(kind: String, contentType: String, filename: String?, bytes: ByteArray): Long = dbQuery {
        DocumentsTable.insert {
            it[DocumentsTable.kind] = kind
            it[DocumentsTable.contentType] = contentType
            it[DocumentsTable.filename] = filename
            it[DocumentsTable.bytes] = bytes
        } get DocumentsTable.id
    }

    suspend fun get(id: Long): Triple<String, String, ByteArray>? = dbQuery {
        DocumentsTable.selectAll().where { DocumentsTable.id eq id }.singleOrNull()?.let {
            Triple(it[DocumentsTable.kind], it[DocumentsTable.contentType], it[DocumentsTable.bytes])
        }
    }
}

fun Route.documentRoutes(documents: DocumentRepository) {
    authenticate(SESSION_AUTH) {
        // Raw-body upload; content type from the request, filename via query param.
        post("/documents") {
            val kind = call.request.queryParameters["kind"] ?: "unspecified"
            val contentType = call.request.contentType().let { "${it.contentType}/${it.contentSubtype}" }
            if (contentType !in ALLOWED_IMAGE_TYPES) {
                call.respond(HttpStatusCode.UnsupportedMediaType, ApiError("Only PNG, JPEG, WebP, or GIF images."))
                return@post
            }
            val bytes = call.receive<ByteArray>()
            if (bytes.size > MAX_BYTES) {
                call.respond(HttpStatusCode.PayloadTooLarge, ApiError("Images are limited to 5 MB."))
                return@post
            }
            if (bytes.isEmpty()) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Empty upload."))
                return@post
            }
            val id = documents.save(kind, contentType, call.request.queryParameters["filename"], bytes)
            call.respond(HttpStatusCode.Created, DocumentRef(id))
        }

        get("/documents/{id}") {
            val doc = call.parameters["id"]?.toLongOrNull()?.let { documents.get(it) }
            if (doc == null) {
                call.respond(HttpStatusCode.NotFound, ApiError("Document not found."))
            } else {
                call.respondBytes(doc.third, ContentType.parse(doc.second))
            }
        }
    }
}
