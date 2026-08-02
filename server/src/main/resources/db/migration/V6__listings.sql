-- Phase 2b: listings per the locked concept (vault: Listings.md) + packaging profiles (D14).

create table packaging_profiles (
    id   bigint generated always as identity primary key,
    name text not null
);

create table packaging_bands (
    id         bigint generated always as identity primary key,
    profile_id bigint not null references packaging_profiles (id) on delete cascade,
    position   int    not null,
    min_qty    int    not null,
    max_qty    int, -- null = open-ended
    kind       text   not null check (kind in ('stocked', 'adhoc'))
);

create table packaging_band_materials (
    band_id     bigint not null references packaging_bands (id) on delete cascade,
    material_id bigint not null references materials (id),
    quantity    numeric(12, 3) not null,
    primary key (band_id, material_id)
);

create table listings (
    id                   bigint generated always as identity primary key,
    product_id           bigint not null references products (id),
    title                text        not null,
    description          text        not null default '',
    -- Shopkeep-side desired state; platform-imposed states (sold_out/expired) live in sync fields
    state                text        not null default 'draft' check (state in ('draft', 'active', 'inactive')),
    base_price_minor     bigint      not null default 0,
    currency             text        not null default 'USD',
    quantity             int         not null default 0,
    sku_mode             text        not null default 'per_combination' check (sku_mode in ('per_combination', 'per_primary')),
    packaging_profile_id bigint references packaging_profiles (id),
    tags                 jsonb       not null default '[]'::jsonb,
    materials_list       jsonb       not null default '[]'::jsonb,
    shop_section         text,
    personalization      jsonb, -- {questions:[...], feeMinor?, extraLaborMinutes?}
    image_document_ids   jsonb       not null default '[]'::jsonb,
    -- platform sync (Etsy first); push/pull mechanics land in Phase 3
    etsy_listing_id      text,
    sync_state           text        not null default 'not_published'
        check (sync_state in ('not_published', 'imported', 'in_sync', 'drifted')),
    platform_state       text, -- as last observed on the platform (active/draft/sold_out/expired/…)
    last_pushed_at       timestamptz,
    last_pushed_snapshot jsonb,
    archived_at          timestamptz,
    created_at           timestamptz not null default now()
);

-- Platform-facing variation axes (≤3 on Etsy), mapped from product choice slots.
create table listing_axes (
    id                    bigint generated always as identity primary key,
    listing_id            bigint not null references listings (id) on delete cascade,
    position              int    not null, -- 0 = primary (carries sku/price in per_primary mode)
    display_name          text   not null,
    product_slot_position int    not null
);

create table listing_axis_values (
    id                   bigint generated always as identity primary key,
    axis_id              bigint not null references listing_axes (id) on delete cascade,
    material_id          bigint not null references materials (id),
    position             int    not null,
    offered              boolean not null default true,
    platform_sku         text,   -- per_primary mode, primary axis only
    price_override_minor bigint  -- primary axis only
);

-- Durable internal configuration matrix: SKUs never change once created (safe to publish).
create table listing_configurations (
    id            bigint generated always as identity primary key,
    listing_id    bigint not null references listings (id) on delete cascade,
    sku           text   not null unique,
    selections    jsonb  not null, -- [{slotIndex, slotName, materialId, materialName}]
    enabled       boolean not null default true, -- pushed as offerings.is_enabled in per_combination mode
    platform_refs jsonb  not null default '{}'::jsonb
);

create table listing_extra_materials (
    listing_id  bigint not null references listings (id) on delete cascade,
    material_id bigint not null references materials (id),
    quantity    numeric(12, 3) not null,
    basis       text   not null check (basis in ('per_order', 'per_unit')),
    primary key (listing_id, material_id)
);
