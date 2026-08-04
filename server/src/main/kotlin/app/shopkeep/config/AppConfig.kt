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
    /** External base URL for OAuth redirects; defaults to localhost for dev. */
    val baseUrl: String,
    /** Encrypts storefront OAuth tokens at rest (vault D12: back this up with the DB). */
    val tokenEncryptionKey: String,
    /** Mock Etsy test double (dev only): reroutes all Etsy endpoints to /api/v1/mock-etsy. */
    val etsyMock: Boolean,
    /** Filesystem root for large media (listing videos) — mirror-tier state,
     *  backed up as a tar alongside pg_dump (vault: D21). */
    val mediaDir: String,
    val syncIntervalMinutes: Long,
    val etsyAuthBase: String,
    val etsyTokenBase: String,
    val etsyApiBase: String,
    // OIDC is optional and env-configured; unset = feature invisible (vault: D10).
    val oidcIssuer: String?,
    val oidcClientId: String?,
    val oidcClientSecret: String?,
) {
    val oidcEnabled: Boolean
        get() = oidcIssuer != null && oidcClientId != null && oidcClientSecret != null

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
                baseUrl = env["BASE_URL"] ?: "http://localhost:${env["PORT"]?.toIntOrNull() ?: 8080}",
                tokenEncryptionKey = env["TOKEN_ENCRYPTION_KEY"]
                    ?: if (devMode) "dev-only-token-key" else missing("TOKEN_ENCRYPTION_KEY"),
                etsyMock = devMode && env["ETSY_MOCK"] == "true",
                mediaDir = env["MEDIA_DIR"] ?: "data/media",
                syncIntervalMinutes = env["SYNC_INTERVAL_MINUTES"]?.toLongOrNull() ?: 5,
                etsyAuthBase = env["ETSY_AUTH_BASE"] ?: "https://www.etsy.com/oauth/connect",
                etsyTokenBase = env["ETSY_TOKEN_BASE"] ?: "https://api.etsy.com/v3/public/oauth/token",
                etsyApiBase = env["ETSY_API_BASE"] ?: "https://openapi.etsy.com/v3/application",
                oidcIssuer = env["OIDC_ISSUER"]?.takeIf { it.isNotBlank() },
                oidcClientId = env["OIDC_CLIENT_ID"]?.takeIf { it.isNotBlank() },
                oidcClientSecret = env["OIDC_CLIENT_SECRET"]?.takeIf { it.isNotBlank() },
            )
        }

        private fun missing(name: String): Nothing =
            error("Required environment variable $name is not set (see deploy/.env.example)")
    }
}
