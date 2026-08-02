-- D20: Designs (colorway compositions) & Variants (build modifiers) on products.
alter table product_slots add column optional boolean not null default false;

create table product_designs (
    id          bigint generated always as identity primary key,
    product_id  bigint not null references products (id) on delete cascade,
    name        text   not null,
    position    int    not null default 0,
    -- [{slotPosition, materialId, qtyOverride|null}]
    assignments jsonb  not null default '[]',
    -- [{key: "<axis value>", assignments: [...]}] — composition modifier sets
    override_sets jsonb not null default '[]'
);

create table product_variants (
    id          bigint generated always as identity primary key,
    product_id  bigint not null references products (id) on delete cascade,
    name        text   not null,
    position    int    not null default 0,
    -- {slotDeltas: [{slotPosition, deltaQty|null, removed}], extras: [{materialId, quantity}], laborDeltaMinutes}
    adjustments jsonb  not null default '{}'
);

-- listing-level value resolutions beyond single materials:
-- [{axis, value, kind: design|variant|review|ignore, refId|null}]
alter table listings add column value_resolutions jsonb not null default '[]';
