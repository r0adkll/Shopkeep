package app.shopkeep.documents

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.config.AppConfig
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
import io.ktor.server.response.respondFile
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.Table
import org.jetbrains.exposed.sql.insert
import org.jetbrains.exposed.sql.javatime.timestampWithTimeZone
import org.jetbrains.exposed.sql.selectAll
import java.io.File
import java.security.MessageDigest

/** Small binaries live in Postgres so pg_dump stays a complete backup of
 *  irreplaceable state (vault: D12). Large media (listing videos) lives on
 *  the MEDIA_DIR volume — mirror-tier, re-pullable from Etsy — with hash +
 *  size indexed here so a media-less restore can tell what's missing
 *  (vault: D21). */

object DocumentsTable : Table("documents") {
    val id = long("id").autoIncrement()
    val kind = text("kind")
    val contentType = text("content_type")
    val filename = text("filename").nullable()
    val bytes = binary("bytes").nullable()
    val storage = text("storage") // inline | file
    val filePath = text("file_path").nullable() // relative to MEDIA_DIR
    val sha256 = text("sha256").nullable()
    val sizeBytes = long("size_bytes").nullable()
    val createdAt = timestampWithTimeZone("created_at").nullable()
    override val primaryKey = PrimaryKey(id)
}

@Serializable
data class DocumentRef(val id: Long)

private const val MAX_IMAGE_BYTES = 5 * 1024 * 1024
private const val MAX_VIDEO_BYTES = 100 * 1024 * 1024 // Etsy's listing-video cap
private val ALLOWED_IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
private val ALLOWED_VIDEO_TYPES = setOf("video/mp4", "video/quicktime")

@SingleIn(AppScope::class)
@Inject
class DocumentRepository(private val config: AppConfig) {
    suspend fun save(kind: String, contentType: String, filename: String?, bytes: ByteArray): Long = dbQuery {
        DocumentsTable.insert {
            it[DocumentsTable.kind] = kind
            it[DocumentsTable.contentType] = contentType
            it[DocumentsTable.filename] = filename
            it[DocumentsTable.bytes] = bytes
            it[storage] = "inline"
        } get DocumentsTable.id
    }

    /** File-backed save: content-hash path under MEDIA_DIR, dedup by hash. */
    suspend fun saveFile(kind: String, contentType: String, filename: String?, bytes: ByteArray): Long {
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val ext = when (contentType) {
            "video/quicktime" -> "mov"
            "video/mp4" -> "mp4"
            else -> contentType.substringAfterLast("/")
        }
        val rel = "$sha.$ext"
        val f = File(config.mediaDir, rel)
        f.parentFile?.mkdirs()
        if (!f.exists()) f.writeBytes(bytes)
        return dbQuery {
            DocumentsTable.insert {
                it[DocumentsTable.kind] = kind
                it[DocumentsTable.contentType] = contentType
                it[DocumentsTable.filename] = filename
                it[storage] = "file"
                it[filePath] = rel
                it[sha256] = sha
                it[sizeBytes] = bytes.size.toLong()
            } get DocumentsTable.id
        }
    }

    data class Doc(val kind: String, val contentType: String, val storage: String, val file: File?, val inline: ByteArray?)

    suspend fun getDoc(id: Long): Doc? = dbQuery {
        DocumentsTable.selectAll().where { DocumentsTable.id eq id }.singleOrNull()?.let { row ->
            Doc(
                row[DocumentsTable.kind],
                row[DocumentsTable.contentType],
                row[DocumentsTable.storage],
                row[DocumentsTable.filePath]?.let { File(config.mediaDir, it) },
                row[DocumentsTable.bytes],
            )
        }
    }

    /** Bytes regardless of backend; null when a file-backed doc's media is
     *  missing from the volume (media-less restore — see D21). */
    suspend fun get(id: Long): Triple<String, String, ByteArray>? {
        val d = getDoc(id) ?: return null
        val bytes = when (d.storage) {
            "file" -> d.file?.takeIf { it.exists() }?.readBytes() ?: return null
            else -> d.inline ?: return null
        }
        return Triple(d.kind, d.contentType, bytes)
    }
}

fun Route.documentRoutes(documents: DocumentRepository) {
    authenticate(SESSION_AUTH) {
        // Raw-body upload; content type from the request, filename via query param.
        // Images -> Postgres (inline); videos -> MEDIA_DIR volume (D21).
        post("/documents") {
            val kind = call.request.queryParameters["kind"] ?: "unspecified"
            val contentType = call.request.contentType().let { "${it.contentType}/${it.contentSubtype}" }
            val isVideo = contentType in ALLOWED_VIDEO_TYPES
            if (contentType !in ALLOWED_IMAGE_TYPES && !isVideo) {
                call.respond(HttpStatusCode.UnsupportedMediaType, ApiError("Only PNG, JPEG, WebP, GIF images or MP4/MOV videos."))
                return@post
            }
            val bytes = call.receive<ByteArray>()
            val cap = if (isVideo) MAX_VIDEO_BYTES else MAX_IMAGE_BYTES
            if (bytes.size > cap) {
                call.respond(HttpStatusCode.PayloadTooLarge, ApiError(if (isVideo) "Videos are limited to 100 MB (Etsy's cap)." else "Images are limited to 5 MB."))
                return@post
            }
            if (bytes.isEmpty()) {
                call.respond(HttpStatusCode.UnprocessableEntity, ApiError("Empty upload."))
                return@post
            }
            val filename = call.request.queryParameters["filename"]
            val id = if (isVideo) documents.saveFile(kind, contentType, filename, bytes)
            else documents.save(kind, contentType, filename, bytes)
            call.respond(HttpStatusCode.Created, DocumentRef(id))
        }

        get("/documents/{id}") {
            val doc = call.parameters["id"]?.toLongOrNull()?.let { documents.getDoc(it) }
            when {
                doc == null -> call.respond(HttpStatusCode.NotFound, ApiError("Document not found."))
                doc.storage == "file" -> {
                    val f = doc.file
                    if (f == null || !f.exists()) {
                        call.respond(HttpStatusCode.Gone, ApiError("Media file missing from the volume — restore it or re-pull from Etsy (D21)."))
                    } else call.respondFile(f)
                }
                else -> {
                    val b = doc.inline
                    if (b == null) call.respond(HttpStatusCode.NotFound, ApiError("Document not found."))
                    else call.respondBytes(b, ContentType.parse(doc.contentType))
                }
            }
        }
    }
}
