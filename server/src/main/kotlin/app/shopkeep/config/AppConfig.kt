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
                oidcIssuer = env["OIDC_ISSUER"]?.takeIf { it.isNotBlank() },
                oidcClientId = env["OIDC_CLIENT_ID"]?.takeIf { it.isNotBlank() },
                oidcClientSecret = env["OIDC_CLIENT_SECRET"]?.takeIf { it.isNotBlank() },
            )
        }

        private fun missing(name: String): Nothing =
            error("Required environment variable $name is not set (see deploy/.env.example)")
    }
}
