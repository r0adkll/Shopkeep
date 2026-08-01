-- Phase 1: materials + the append-only inventory ledger (vault: Data Model, D5).

create table materials (
    id                  bigint generated always as identity primary key,
    name                text        not null,
    category            text        not null,
    type                text        not null,
    unit                text        not null,
    -- Money per D9: integer minor units + currency; entered as "cost for N units"
    cost_minor          bigint      not null default 0,
    cost_quantity       numeric(12, 2) not null default 1,
    currency            text        not null default 'USD',
    low_stock_threshold numeric(12, 2),
    reorder_quantity    numeric(12, 2),
    -- Reference capacity for gauges (e.g. 1000 g spool, 50-box case)
    full_quantity       numeric(12, 2),
    vendor_url          text,
    attributes          jsonb       not null default '{}'::jsonb,
    archived_at         timestamptz,
    created_at          timestamptz not null default now()
);

create index materials_category_idx on materials (category) where archived_at is null;

-- Quantities are NEVER stored on materials — stock derives from this ledger (D5).
create table inventory_transactions (
    id          bigint generated always as identity primary key,
    material_id bigint      not null references materials (id) on delete cascade,
    delta       numeric(12, 2) not null,
    kind        text        not null check (kind in ('purchase', 'reservation', 'release', 'consumption', 'adjustment')),
    note        text,
    created_by  bigint references users (id) on delete set null,
    created_at  timestamptz not null default now()
);

create index inventory_transactions_material_idx on inventory_transactions (material_id, created_at);
