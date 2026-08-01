package app.shopkeep.db

import app.shopkeep.config.AppConfig
import com.zaxxer.hikari.HikariConfig
import com.zaxxer.hikari.HikariDataSource
import kotlinx.coroutines.Dispatchers
import org.flywaydb.core.Flyway
import org.jetbrains.exposed.sql.Database
import org.jetbrains.exposed.sql.transactions.experimental.newSuspendedTransaction
import javax.sql.DataSource

fun createDataSource(config: AppConfig): DataSource =
    HikariDataSource(
        HikariConfig().apply {
            jdbcUrl = config.databaseUrl
            username = config.databaseUser
            password = config.databasePassword
            maximumPoolSize = 10
            isAutoCommit = false
        },
    )

/** Flyway migrations run automatically at boot — self-hosters upgrade by pulling a new image (vault: D2). */
fun migrate(dataSource: DataSource) {
    Flyway.configure()
        .dataSource(dataSource)
        .locations("classpath:db/migration")
        .load()
        .migrate()
}

fun connectExposed(dataSource: DataSource): Database = Database.connect(dataSource)

/** All repository DB work goes through this: IO dispatcher + transaction. */
suspend fun <T> dbQuery(block: () -> T): T =
    newSuspendedTransaction(Dispatchers.IO) { block() }
