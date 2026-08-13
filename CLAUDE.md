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
| `Decisions.md` | D1–D24, all accepted. Binding. New non-obvious technical choices get a new entry there, not silent code |
| `Data Model.md` | Schema and lifecycle invariants (inventory ledger semantics, packaging bands, SKU matching) |
| `Architecture.md` | Two-container shape, module boundaries, `StorefrontAdapter` seam, IPP printing, backup design |
| `Design Process.md` + `Inventory UX.md` | UI surfaces need a **locked concept** before implementation; locked concepts bind at the information-design level |
| `Etsy Integration.md` | Sync, matching chain, fulfillment flow + its API feasibility gate |

If implementation reveals a vault spec is wrong or incomplete, update the vault (or raise it in `Open Questions.md`) as part of the change — the two must not drift.

## What This Repo Is

Self-hosted suite for managing a crafted-products business (inventory → products → listings → orders → fulfillment), Etsy-first. Named for the shopkeeper archetype of games.

- **Server:** Kotlin, Ktor, Metro DI, Exposed + Flyway + HikariCP, PostgreSQL (vault D1/D2)
- **Web:** React + TypeScript + Vite + Tailwind + shadcn/ui + TanStack Query/Router, in `web/`, built to static files served by Ktor (D3/D4)
- **UI practices:** follow [shadcn/ui](https://ui.shadcn.com) conventions when building UI. In particular: loading states are layout-mirroring `Skeleton` blocks (`web/src/ui.tsx`), never a bare "Loading…" line for content-shaped regions; mark loading containers `aria-busy`.
- **Icons:** use `lucide-react` — never hand-generate vector icons or use emoji/text glyphs for UI chrome. Custom icons that Lucide can't cover (filament spool, material identities in `MaterialIcon.tsx`) are drawn to match Lucide's language: 24 grid, `stroke="currentColor"`, strokeWidth 2, round caps/joins.
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
- **Starting the dev loop:** in VS Code the `dev` task auto-runs server + web on folder open (or run it manually via Tasks). Any other terminal: `./scripts/dev.sh`. The scripts bake in dev env vars and auto-enable OIDC when Dex is reachable — never hand-type that env.
- Config via env vars only; `.env.example` is the canonical list. Never commit real secrets or tokens.
- **Status (2026-08-12):** Phases 0–4 and 6 are complete and running against the real shop. Phase 5 (fulfillment) is built-but-gated on the world: ship flow, shipment records, and packing slips are live; USPS label purchase (Path B, D22) is dormant pending the owner's portal enrollment; IPP printing awaits hardware on site. Phase 7 is the stretch backlog; Phase 8 (Print Workflow) is planned with open owner questions Q10–Q12. Vault `Roadmap.md` is authoritative — read it before starting new work.
- `scripts/seed-dev.sh` seeds a realistic ~50-material inventory for UI work at density (guard: refuses when >15 materials exist; cleanup SQL in its header).

## Verifying a Change

Run these before calling any change done — every change, every time:

- **Server:** `./gradlew :server:compileKotlin -q`, then `./gradlew :server:test -q` (quiet output + exit 0 = green).
- **Web:** `cd web && npx tsc --noEmit && npm run build` (the chunk-size warning is pre-existing noise; anything else is yours).
- **Schema:** new Flyway file at `server/src/main/resources/db/migration/V<next>__name.sql` — check the current highest version first; never edit an applied migration. Watch for check-constraint drift when adding enum-ish string values (`grep -r "check (" server/src/main/resources/db/migration/`).
- If the change touched spec-level behavior, update the vault in the same change (new `Decisions.md` entry for non-obvious choices; a marked extension in the owning spec note otherwise).

## Established Patterns (distilled from the build-out — reuse, don't reinvent)

**Frontend**
- **Material picking is always `MaterialPickerDialog`** (`web/src/inventory/MaterialPickerDialog.tsx`), never a bare `<select>` over materials. Pass `lockCategory` when the use site's world is fixed (e.g. color→color maps lock to `"filament"`). If a pick can land outside a slot's palette, fold it into the palette on save so cost ranges/coverage stay honest (see the rule-map save handler in `RecipeEditor.tsx`).
- **Quantities & weights:** grams are the primary unit; every gram-denominated input also accepts `oz`/`ounce` suffixes via `parseGrams`/`parseQtyAs` (`web/src/inventory/api.ts`). Inputs needing suffix or in-progress-decimal typing must be **string-buffered** (`QtyField.tsx`, `QtyInput`) — a controlled input whose value re-derives from the parsed number eats the suffix keystrokes.
- **TanStack Query:** `setQueryData` matches keys **exactly** — `["orders"]` does not hit `["orders", showArchived]`; this caused a real silent-no-op optimistic-update bug. `invalidateQueries` matches by prefix. After a mutation, invalidate every query family it affects (e.g. import activation → `imports` and `listings`).
- **Cross-page deep link:** `/listings?listing=<id>` opens the listing editor (navigated via `window.location.href`); order detail and the import screens use it. Reuse it before inventing a route.
- **Async buttons:** pending = `Loader2` + `animate-spin` beside the label; disable sibling buttons that share the code path (e.g. save-draft while activate runs). A success state becomes the *next* affordance ("Activated ✓ · Open listing →"), not a dead label.
- **Lifecycle-conditional chrome:** urgency indicators must know when they're noise — the ship-by pill hides for done-lane/archived/Etsy-`completed`/dead orders. Apply the same test to any new badge.

**Server**
- **Persist-at-resolve, don't re-derive:** anything displayed about an order that was computed during matching (design/variant identity → `order_lines.matched_components`, reserved BOM) is written to the row at resolve time, so display always mirrors what was actually reserved. Read-time re-derivation drifts once listings change.
- **One sync entry point:** `SyncService` serializes all storefront syncs behind a global mutex; the orders screen's freshness trigger (`POST /orders/sync`, D24) adds a last-*attempt* cooldown + `tryLock` so bursts are free. New freshness triggers call that same path — never add a parallel sync route.
- **`listOrders` stays bulk-shaped:** it prefetches lookup maps in one `dbQuery`; per-line data comes from columns, not per-line queries. Extend the prefetch block, don't add N+1s.
