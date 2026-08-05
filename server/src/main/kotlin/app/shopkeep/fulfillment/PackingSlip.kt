package app.shopkeep.fulfillment

import app.shopkeep.auth.ApiError
import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.auth.requireAdmin
import app.shopkeep.catalog.SettingsTable
import app.shopkeep.db.dbQuery
import app.shopkeep.documents.DocumentRepository
import app.shopkeep.integrations.ConnectionRepository
import app.shopkeep.integrations.OrderDetail
import app.shopkeep.integrations.OrdersTable
import app.shopkeep.integrations.SyncService
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import io.ktor.http.ContentType
import io.ktor.http.HttpStatusCode
import io.ktor.server.auth.authenticate
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.response.respondBytes
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.put
import kotlinx.serialization.Serializable
import org.jetbrains.exposed.sql.SqlExpressionBuilder.eq
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.upsert
import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.PDPage
import org.apache.pdfbox.pdmodel.PDPageContentStream
import org.apache.pdfbox.pdmodel.common.PDRectangle
import org.apache.pdfbox.pdmodel.font.PDFont
import org.apache.pdfbox.pdmodel.font.PDType1Font
import org.apache.pdfbox.pdmodel.font.Standard14Fonts
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject
import java.io.ByteArrayOutputStream
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

/* Packing slip per the locked concept (Order Management § Fulfillment):
 * Etsy-default content + shop logo (auto-pulled shop icon), plain Discount,
 * tax, opt-in private note (suppressed on gifts), gift = ZERO pricing,
 * settings-editable footer. Rendered fresh per request — it's a pure
 * function of order data. */

private val HELV = PDType1Font(Standard14Fonts.FontName.HELVETICA)
private val HELV_BOLD = PDType1Font(Standard14Fonts.FontName.HELVETICA_BOLD)
private val HELV_OBL = PDType1Font(Standard14Fonts.FontName.HELVETICA_OBLIQUE)

/** WinAnsi can't encode emoji/CJK — replace rather than crash. */
private fun clean(s: String): String = s.map { if (it.code in 32..255 && it != '') it else '?' }.joinToString("")

@SingleIn(AppScope::class)
@Inject
class PackingSlipService(
    private val sync: SyncService,
    private val connections: ConnectionRepository,
    private val documents: DocumentRepository,
) {
    suspend fun footer(): String = dbQuery {
        SettingsTable.selectAll().where { SettingsTable.key eq "slip_footer" }
            .singleOrNull()?.get(SettingsTable.value)
    } ?: "Thank you for supporting a small maker!"

    suspend fun setFooter(text: String): Unit = dbQuery {
        SettingsTable.upsert { it[key] = "slip_footer"; it[value] = text }
    }

    suspend fun render(orderId: Long, includeNote: Boolean): ByteArray? {
        val d = sync.orderDetail(orderId) ?: return null
        val connId = dbQuery {
            OrdersTable.selectAll().where { OrdersTable.id eq orderId }.singleOrNull()?.get(OrdersTable.connectionId)
        } ?: return null
        val conn = connections.list().firstOrNull { it.id == connId }
        val shopName = conn?.shopName ?: "Shop"
        val iconBytes = runCatching {
            connections.shopIconDocId(connId)?.let { documents.get(it)?.third }
        }.getOrNull()
        val footerText = footer()
        val gift = d.isGift
        val showNote = includeNote && !gift && d.notes.isNotEmpty()

        val money = { minor: Long -> "$" + "%.2f".format(minor / 100.0) }
        PDDocument().use { doc ->
            val page = PDPage(PDRectangle.LETTER)
            doc.addPage(page)
            val w = page.mediaBox.width
            val left = 54f
            val right = w - 54f
            var y = page.mediaBox.height - 60f

            PDPageContentStream(doc, page).use { cs ->
                fun text(x: Float, yy: Float, font: PDFont, size: Float, s: String, gray: Float = 0f) {
                    cs.setNonStrokingColor(gray, gray, gray)
                    cs.beginText(); cs.setFont(font, size); cs.newLineAtOffset(x, yy); cs.showText(clean(s)); cs.endText()
                    cs.setNonStrokingColor(0f, 0f, 0f)
                }
                fun textRight(x: Float, yy: Float, font: PDFont, size: Float, s: String, gray: Float = 0f) {
                    val tw = font.getStringWidth(clean(s)) / 1000f * size
                    text(x - tw, yy, font, size, s, gray)
                }
                fun hr(yy: Float) {
                    cs.setStrokingColor(0.85f, 0.85f, 0.85f)
                    cs.moveTo(left, yy); cs.lineTo(right, yy); cs.stroke()
                }
                fun wrap(s: String, font: PDFont, size: Float, maxW: Float): List<String> {
                    val words = clean(s).split(" ")
                    val lines = mutableListOf<String>()
                    var cur = ""
                    for (word in words) {
                        val cand = if (cur.isEmpty()) word else "$cur $word"
                        if (font.getStringWidth(cand) / 1000f * size > maxW && cur.isNotEmpty()) { lines += cur; cur = word }
                        else cur = cand
                    }
                    if (cur.isNotEmpty()) lines += cur
                    return lines
                }

                // header: logo + shop + order
                var headX = left
                if (iconBytes != null) {
                    runCatching {
                        val img = PDImageXObject.createFromByteArray(doc, iconBytes, "icon")
                        cs.drawImage(img, left, y - 26f, 34f, 34f)
                        headX = left + 44f
                    }
                }
                text(headX, y - 6f, HELV_BOLD, 15f, shopName)
                text(headX, y - 20f, HELV, 9f, "etsy.com/shop/$shopName", 0.45f)
                textRight(right, y - 6f, HELV, 10f, "Order #${d.order.platformOrderId}", 0.35f)
                val placed = d.order.placedAt?.let { OffsetDateTime.parse(it).format(DateTimeFormatter.ofPattern("MMM d, yyyy")) } ?: ""
                textRight(right, y - 20f, HELV, 10f, placed, 0.45f)
                y -= 44f; hr(y); y -= 18f

                // ship-to / shipping
                text(left, y, HELV_BOLD, 7.5f, "SHIP TO", 0.5f)
                textRight(right, y, HELV_BOLD, 7.5f, "SHIPPING", 0.5f)
                y -= 13f
                val addr = listOfNotNull(
                    d.shipName, d.shipLine1, d.shipLine2,
                    listOfNotNull(d.shipCity, d.shipState, d.shipZip).joinToString(" ").ifBlank { null },
                    d.shipCountry,
                )
                var ay = y
                addr.forEachIndexed { i, line ->
                    text(left, ay, if (i == 0) HELV_BOLD else HELV, 10.5f, line); ay -= 13f
                }
                val ship = d.shipments.firstOrNull()
                textRight(right, y, HELV, 10.5f, ship?.carrierName?.let { "$it — see Etsy receipt for tracking" } ?: "tracking on your Etsy receipt", 0.35f)
                y = ay - 6f; hr(y); y -= 16f

                // items
                text(left, y, HELV_BOLD, 7.5f, "ITEM", 0.5f)
                if (!gift) textRight(right, y, HELV_BOLD, 7.5f, "QTY   PRICE", 0.5f)
                else textRight(right, y, HELV_BOLD, 7.5f, "QTY", 0.5f)
                y -= 15f
                for (l in d.order.lines) {
                    text(left, y, HELV_BOLD, 10.5f, l.listingTitle ?: l.productName ?: l.title)
                    if (!gift) textRight(right, y, HELV, 10.5f, "${l.quantity}   ${money(l.priceMinor * l.quantity)}")
                    else textRight(right, y, HELV, 10.5f, "${l.quantity}")
                    y -= 12.5f
                    val vars = l.variations.joinToString(" · ") { "${it.name}: ${it.value}" }
                    if (vars.isNotBlank()) { text(left, y, HELV, 9.5f, vars, 0.35f); y -= 12f }
                    for (p in l.personalization) {
                        text(left, y, HELV_BOLD, 9.5f, "Personalization — ${p.name}: “${p.value}”", 0.2f)
                        y -= 12f
                    }
                    y -= 5f
                }
                y -= 2f; hr(y); y -= 16f

                // totals (never on gift slips)
                if (!gift) {
                    fun total(label: String, amt: String, bold: Boolean = false) {
                        text(left, y, if (bold) HELV_BOLD else HELV, 10.5f, label, if (bold) 0f else 0.4f)
                        textRight(right, y, if (bold) HELV_BOLD else HELV, 10.5f, amt)
                        y -= 14f
                    }
                    d.subtotalMinor?.let { total("Item total", money(it)) }
                    d.discountMinor?.takeIf { it > 0 }?.let { total("Discount", "-" + money(it)) }
                    d.shippingMinor?.let { total("Shipping", if (it == 0L) "FREE" else money(it)) }
                    d.taxMinor?.takeIf { it > 0 }?.let { total("Tax", money(it)) }
                    total("Order total", money(d.order.totalMinor), bold = true)
                    y -= 4f
                }

                // buyer's checkout note
                d.order.buyerMessage?.takeIf { it.isNotBlank() }?.let { msg ->
                    text(left, y, HELV_BOLD, 7.5f, "NOTE FROM BUYER", 0.5f); y -= 12f
                    for (line in wrap(msg, HELV_OBL, 9.5f, right - left)) { text(left, y, HELV_OBL, 9.5f, line, 0.3f); y -= 12f }
                    y -= 4f
                }

                // gift block
                if (gift) {
                    text(left, y, HELV_BOLD, 10.5f, "A gift" + (d.giftSender?.let { " from $it" } ?: ""))
                    y -= 13f
                    d.giftMessage?.takeIf { it.isNotBlank() }?.let { msg ->
                        for (line in wrap("“$msg”", HELV_OBL, 10.5f, right - left)) { text(left, y, HELV_OBL, 10.5f, line, 0.2f); y -= 13f }
                    }
                    y -= 4f
                }

                // private note (opt-in, never on gifts)
                if (showNote) {
                    text(left, y, HELV_BOLD, 7.5f, "PRIVATE NOTE", 0.5f); y -= 12f
                    for (n in d.notes) for (line in wrap(n.body, HELV, 9.5f, right - left)) {
                        text(left, y, HELV, 9.5f, line, 0.3f); y -= 12f
                    }
                    y -= 4f
                }

                hr(y); y -= 16f
                for (line in wrap(footerText, HELV, 10f, right - left)) { text(left, y, HELV, 10f, line, 0.3f); y -= 13f }
            }
            val out = ByteArrayOutputStream()
            doc.save(out)
            return out.toByteArray()
        }
    }
}

@Serializable
data class SlipFooterRequest(val text: String)

fun Route.packingSlipRoutes(slips: PackingSlipService) {
    authenticate(SESSION_AUTH) {
        get("/orders/{id}/packing-slip.pdf") {
            val id = call.parameters["id"]?.toLongOrNull()
            val includeNote = call.request.queryParameters["note"] == "1"
            val pdf = id?.let { slips.render(it, includeNote) }
            if (pdf == null) call.respond(HttpStatusCode.NotFound, ApiError("Order not found."))
            else call.respondBytes(pdf, ContentType.Application.Pdf)
        }
        get("/fulfillment/slip-footer") { call.respond(mapOf("text" to slips.footer())) }
    }
    requireAdmin {
        put("/fulfillment/slip-footer") {
            slips.setFooter(call.receive<SlipFooterRequest>().text.take(500))
            call.respond(mapOf("ok" to true))
        }
    }
}
