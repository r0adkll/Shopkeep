-- Phase 2: products (recipes) per the locked concept (vault: Products.md).

create table settings (
    key   text primary key,
    value text not null
);

create table products (
    id            bigint generated always as identity primary key,
    name          text        not null,
    description   text        not null default '',
    sku_prefix    text        not null,
    labor_minutes int         not null default 0,
    archived_at   timestamptz,
    created_at    timestamptz not null default now()
);

-- kind: fixed = always one material · choice = buyer-facing palette · rule = resolved by rules
create table product_slots (
    id                  bigint generated always as identity primary key,
    product_id          bigint not null references products (id) on delete cascade,
    position            int    not null,
    name                text   not null,
    kind                text   not null check (kind in ('fixed', 'choice', 'rule')),
    quantity            numeric(12, 2) not null,
    fixed_material_id   bigint references materials (id),
    -- OTHERWISE fallback for rule slots; null = uncovered combos are unresolved (loud)
    default_material_id bigint references materials (id)
);

-- Allowed palette for choice slots; candidate materials for rule slots.
create table product_slot_options (
    slot_id     bigint not null references product_slots (id) on delete cascade,
    material_id bigint not null references materials (id),
    primary key (slot_id, material_id)
);

-- Ordered, first-match-wins: WHEN when_slot is one of (product_rule_when) THEN then_slot = then_material.
create table product_rules (
    id               bigint generated always as identity primary key,
    product_id       bigint not null references products (id) on delete cascade,
    position         int    not null,
    when_slot_id     bigint not null references product_slots (id) on delete cascade,
    then_slot_id     bigint not null references product_slots (id) on delete cascade,
    then_material_id bigint not null references materials (id)
);

create table product_rule_when (
    rule_id     bigint not null references product_rules (id) on delete cascade,
    material_id bigint not null references materials (id),
    primary key (rule_id, material_id)
);
