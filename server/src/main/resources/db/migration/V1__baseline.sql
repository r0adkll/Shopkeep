-- Shopkeep baseline schema: Phase 0 scope only (auth + system).
-- Domain tables (materials, products, listings, orders) arrive with their
-- phases, following the vault's Data Model.md.

create table users (
    id            bigint generated always as identity primary key,
    email         text        not null unique,
    display_name  text        not null,
    -- null for OIDC-only accounts (vault: D10)
    password_hash text,
    oidc_subject  text unique,
    role          text        not null check (role in ('admin', 'manager')),
    created_at    timestamptz not null default now()
);

create table sessions (
    id         text primary key,
    user_id    bigint      not null references users (id) on delete cascade,
    payload    text        not null,
    expires_at timestamptz not null
);

create index sessions_expires_at_idx on sessions (expires_at);

-- Single-row table: the deploy/compose.yaml backup service POSTs a marker
-- after each successful pg_dump; the dashboard warns when it goes stale (vault: D12).
create table backup_marker (
    id             boolean primary key default true check (id),
    last_backup_at timestamptz not null
);
