package app.shopkeep.config

/**
 * All configuration comes from environment variables (vault: Architecture).
 * `deploy/.env.example` is the canonical, documented list.
 */
data class AppConfig(
    val port: Int,
    val databaseUrl: String,
    val databaseUser: String,
    val databasePassword: String,
    val sessionSecret: String,
    val webDistPath: String?,
    val devMode: Boolean,
) {
    companion object {
        fun fromEnv(env: Map<String, String> = System.getenv()): AppConfig {
            val devMode = env["SHOPKEEP_DEV"] == "true"
            return AppConfig(
                port = env["PORT"]?.toIntOrNull() ?: 8080,
                databaseUrl = env["DATABASE_URL"]
                    ?: if (devMode) "jdbc:postgresql://localhost:5432/shopkeep" else missing("DATABASE_URL"),
                databaseUser = env["DATABASE_USER"] ?: if (devMode) "shopkeep" else missing("DATABASE_USER"),
                databasePassword = env["DATABASE_PASSWORD"]
                    ?: if (devMode) "shopkeep-dev" else missing("DATABASE_PASSWORD"),
                sessionSecret = env["SESSION_SECRET"]
                    ?: if (devMode) "dev-only-session-secret" else missing("SESSION_SECRET"),
                webDistPath = env["WEB_DIST"],
                devMode = devMode,
            )
        }

        private fun missing(name: String): Nothing =
            error("Required environment variable $name is not set (see deploy/.env.example)")
    }
}
