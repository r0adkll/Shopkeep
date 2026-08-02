package app.shopkeep

import app.shopkeep.auth.OidcService
import app.shopkeep.auth.PostgresSessionStorage
import app.shopkeep.auth.UserRepository
import app.shopkeep.config.AppConfig
import app.shopkeep.catalog.ProductRepository
import app.shopkeep.documents.DocumentRepository
import app.shopkeep.integrations.ConnectionRepository
import app.shopkeep.catalog.DesignRepository
import app.shopkeep.integrations.ImportRepository
import app.shopkeep.integrations.LaneRepository
import app.shopkeep.integrations.SyncService
import app.shopkeep.listings.ListingRepository
import app.shopkeep.inventory.MaterialRepository
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.DependencyGraph
import dev.zacsweers.metro.Provides
import dev.zacsweers.metro.SingleIn
import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json

/**
 * Metro dependency graph (vault: Tech Stack). Modules grow here as phases land:
 * inventory, catalog, orders, integrations, stats (vault: Architecture).
 */
@DependencyGraph(AppScope::class)
interface AppGraph {
    val userRepository: UserRepository
    val sessionStorage: PostgresSessionStorage
    val oidcService: OidcService
    val materialRepository: MaterialRepository
    val productRepository: ProductRepository
    val documentRepository: DocumentRepository
    val listingRepository: ListingRepository
    val connectionRepository: ConnectionRepository
    val syncService: SyncService
    val laneRepository: LaneRepository
    val importRepository: ImportRepository
    val designRepository: DesignRepository

    @Provides
    @SingleIn(AppScope::class)
    fun provideHttpClient(): HttpClient = HttpClient(CIO) {
        install(ContentNegotiation) {
            json(Json { ignoreUnknownKeys = true })
        }
    }

    @DependencyGraph.Factory
    fun interface Factory {
        fun create(@Provides config: AppConfig): AppGraph
    }
}
