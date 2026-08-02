-- Phase 3 (D17): import Etsy listings with a mapping phase (locked concept).
-- Imported listings are sku_mode='listing_level'; orders match by the Etsy
-- listing id carried on each transaction, then variation values resolve to
-- materials through platform_value on the axis values.

create table etsy_imports (
    id              bigint generated always as identity primary key,
    connection_id   bigint not null references storefront_connections (id),
    etsy_listing_id text   not null unique,
    payload         jsonb  not null, -- listing + inventory snapshot at import time
    mapping         jsonb  not null default '{}',
    listing_id      bigint references listings (id), -- set on activation
    created_at      timestamptz not null default now()
);

alter table order_lines add column platform_listing_id text;
alter table order_lines add column matched_listing_id bigint references listings (id);
alter table order_lines add column resolved_selections jsonb;
alter table order_lines add column needs_review boolean not null default false;

alter table listing_axis_values add column platform_value text;
