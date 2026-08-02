package app.shopkeep

import app.shopkeep.auth.SESSION_AUTH
import app.shopkeep.auth.UserSession
import app.shopkeep.auth.authRoutes
import app.shopkeep.auth.oidcRoutes
import app.shopkeep.catalog.catalogRoutes
import app.shopkeep.documents.documentRoutes
import app.shopkeep.listings.listingRoutes
import app.shopkeep.inventory.inventoryRoutes
import app.shopkeep.config.AppConfig
import app.shopkeep.db.connectExposed
import app.shopkeep.db.createDataSource
import app.shopkeep.db.migrate
import app.shopkeep.system.systemRoutes
import dev.zacsweers.metro.createGraphFactory
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.application.log
import io.ktor.server.auth.Authentication
import io.ktor.server.auth.session
import io.ktor.server.engine.embeddedServer
import io.ktor.server.http.content.singlePageApplication
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.sessions.SessionStorage
import io.ktor.server.sessions.Sessions
import io.ktor.server.sessions.cookie
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import java.io.File

const val VERSION = "0.1.0"

fun main() {
    val log = LoggerFactory.getLogger("app.shopkeep.Main")
    val config = AppConfig.fromEnv()

    val dataSource = createDataSource(config)
    log.info("Running database migrations…")
    migrate(dataSource)
    connectExposed(dataSource)

    val graph = createGraphFactory<AppGraph.Factory>().create(config)

    log.info("Starting Shopkeep $VERSION on port ${config.port} (devMode=${config.devMode})")
    embeddedServer(Netty, port = config.port) {
        shopkeepModule(config, graph)
    }.start(wait = true)
}

@Serializable
private data class ErrorBody(val message: String)

fun Application.shopkeepModule(config: AppConfig, graph: AppGraph) {
    install(CallLogging)
    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true })
    }
    install(StatusPages) {
        exception<Throwable> { call, cause ->
            this@shopkeepModule.log.error("Unhandled error on ${call.request.local.uri}", cause)
            call.respond(HttpStatusCode.InternalServerError, ErrorBody("Something went wrong."))
        }
    }
    install(Sessions) {
        cookie<UserSession>("shopkeep_session", graph.sessionStorage as SessionStorage) {
            cookie.path = "/"
            cookie.httpOnly = true
            cookie.extensions["SameSite"] = "Lax"
            cookie.secure = !config.devMode
        }
    }
    install(Authentication) {
        session<UserSession>(SESSION_AUTH) {
            validate { session -> session }
            challenge { call.respond(HttpStatusCode.Unauthorized, ErrorBody("Not signed in.")) }
        }
    }

    routing {
        route("/api/v1") {
            systemRoutes(VERSION)
            authRoutes(graph.userRepository)
            oidcRoutes(graph.oidcService, graph.userRepository)
            inventoryRoutes(graph.materialRepository)
            catalogRoutes(graph.productRepository)
            documentRoutes(graph.documentRepository)
            listingRoutes(graph.listingRepository)
        }

        // Serve the built SPA when present (vault: D4 — one container serves API + web).
        val dist = config.webDistPath?.let(::File)
        if (dist != null && dist.isDirectory) {
            singlePageApplication {
                filesPath = dist.absolutePath
                defaultPage = "index.html"
            }
        }
    }
}
