package app.shopkeep

import app.shopkeep.auth.PostgresSessionStorage
import app.shopkeep.auth.UserRepository
import app.shopkeep.config.AppConfig
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.DependencyGraph
import dev.zacsweers.metro.Provides

/**
 * Metro dependency graph (vault: Tech Stack). Modules grow here as phases land:
 * inventory, catalog, orders, integrations, stats (vault: Architecture).
 */
@DependencyGraph(AppScope::class)
interface AppGraph {
    val userRepository: UserRepository
    val sessionStorage: PostgresSessionStorage

    @DependencyGraph.Factory
    fun interface Factory {
        fun create(@Provides config: AppConfig): AppGraph
    }
}
