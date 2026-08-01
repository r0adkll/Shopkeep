# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## The Vault Is the Source of Truth

Shopkeep's full product spec, architecture, data model, decision log, and roadmap live in an Obsidian vault at:

```
~/Library/Mobile Documents/iCloud~md~obsidian/Documents/craft-management-suite/
```

**Before designing or implementing any feature, read the relevant vault notes.** The vault's own `CLAUDE.md` is the index; the key documents:

| Vault note | Governs |
|---|---|
| `Roadmap.md` | Phase order and exit criteria — build in phase order; don't pull later-phase work forward without asking |
| `Decisions.md` | D1–D16, all accepted. Binding. New non-obvious technical choices get a new entry there, not silent code |
| `Data Model.md` | Schema and lifecycle invariants (inventory ledger semantics, packaging bands, SKU matching) |
| `Architecture.md` | Two-container shape, module boundaries, `StorefrontAdapter` seam, IPP printing, backup design |
| `Design Process.md` + `Inventory UX.md` | UI surfaces need a **locked concept** before implementation; locked concepts bind at the information-design level |
| `Etsy Integration.md` | Sync, matching chain, fulfillment flow + its API feasibility gate |

If implementation reveals a vault spec is wrong or incomplete, update the vault (or raise it in `Open Questions.md`) as part of the change — the two must not drift.

## What This Repo Is

Self-hosted suite for managing a crafted-products business (inventory → products → listings → orders → fulfillment), Etsy-first. Named for the shopkeeper archetype of games.

- **Server:** Kotlin, Ktor, Metro DI, Exposed + Flyway + HikariCP, PostgreSQL (vault D1/D2)
- **Web:** React + TypeScript + Vite + Tailwind + shadcn/ui + TanStack Query/Router, in `web/`, built to static files served by Ktor (D3/D4)
- **Layout:** `server/` (Ktor app), `web/` (SPA), `deploy/` (self-hoster compose + backup service), `.devcontainer/` (D15)
- **Deploy:** two containers (app + postgres), images on ghcr.io, Flyway migrates on boot

## Hard Rules (from accepted decisions)

- Inventory quantities are **never** stored as mutable integers — always `inventory_transaction` ledger rows; available = on-hand − open reservations (D5).
- All persistent state lives in Postgres — including generated PDFs — so `pg_dump` is a complete backup (D12). No app-container volumes.
- Money = integer minor units + ISO 4217 code; no FX conversion (D9).
- The app speaks only IPP for printing; USB support = documented CUPS sidecar, never in-app drivers (D13).
- Storefront code goes behind `StorefrontAdapter`; nothing outside `integrations` may know it's talking to Etsy (D6).
- Inventory health UI shows **buildable units**, not days; status never rides on color alone (`Inventory UX.md`).
- Keep the self-hoster ops story sacred: no new required containers, no required external services (D4).

## Development

- **Never run `docker compose up` against `.devcontainer/compose.yaml` from the host while a devcontainer is in use.** Compose will "reconcile" the workspace service back to the raw base image — destroying the feature-built container (Java, Node vanish) and forcing a rebuild. The devcontainer lifecycle belongs to VS Code exclusively; auxiliary services (db, dex) are plain compose services VS Code brings up itself.

- Dev containers are the paved road (`.devcontainer/`), but the repo must stay fully usable without them: plain Gradle + `docker compose up postgres` (D15 — JetBrains support caveat).
- Config via env vars only; `.env.example` is the canonical list. Never commit real secrets or tokens.
- Phase 0 exit criteria (vault `Roadmap.md`) define "done" for the current work: compose up → setup wizard → login (local + test OIDC) → empty dashboard; devcontainer opens to a hot-reload loop; backup service produces a restorable dump.
