# Shopkeep

Self-hosted management suite for crafted-product businesses — material inventory, product recipes, storefront listings, order queue, and fulfillment, with Etsy integration first (Shopify planned). Named for the shopkeeper archetype found throughout game worlds.

> **Status: Phase 0 — foundations.** See the roadmap in the design vault.

## Design Vault

All product specs, architecture, the data model, the decision log (D1–D16), and the phased roadmap live in an Obsidian vault (`craft-management-suite`), which is the source of truth for this implementation. Code and vault must not drift: schema follows `Data Model.md`, module boundaries follow `Architecture.md`, and UI surfaces follow their locked concepts per `Design Process.md`.

## Stack

- **Server** — Kotlin · Ktor · Metro DI · Exposed · Flyway · PostgreSQL
- **Web** — React · TypeScript · Vite · Tailwind · shadcn/ui · TanStack Query/Router (static bundle served by Ktor)
- **Deploy** — two containers (`app` + `postgres`) via docker compose; images on ghcr.io; migrations run at boot
- **Dev** — Dev Containers (JDK + Node workspace, Postgres sidecar); also works container-less with local Gradle + `docker compose up postgres`

## Layout

```
server/          Ktor application (modules: inventory, catalog, orders, integrations, stats, auth)
web/             React SPA
deploy/          Self-hoster compose file, backup service, .env reference
.devcontainer/   Dev container definition
```

## License

TBD
