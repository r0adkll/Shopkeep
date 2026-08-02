-- Phase 3: order ingestion (vault: Data Model, Order Management).
-- Queue workflow arrives in Phase 4; ingestion + matching + reservation now.

create table orders (
    id                bigint generated always as identity primary key,
    connection_id     bigint      not null references storefront_connections (id),
    platform_order_id text        not null,
    category          text        not null default 'new',
    buyer_name        text        not null default '',
    buyer_message     text,
    total_minor       bigint      not null default 0,
    currency          text        not null default 'USD',
    placed_at         timestamptz,
    ingested_at       timestamptz not null default now(),
    unique (connection_id, platform_order_id)
);

create table order_lines (
    id                       bigint generated always as identity primary key,
    order_id                 bigint not null references orders (id) on delete cascade,
    platform_ref             text   not null default '',
    raw_sku                  text,
    title                    text   not null default '',
    quantity                 int    not null default 1,
    price_minor              bigint not null default 0,
    variations               jsonb  not null default '[]'::jsonb,
    personalization          jsonb  not null default '[]'::jsonb,
    listing_configuration_id bigint references listing_configurations (id)
);

-- Queue transitions (powers Phase 4 board + Stats time-in-stage).
create table order_events (
    id            bigint generated always as identity primary key,
    order_id      bigint      not null references orders (id) on delete cascade,
    from_category text,
    to_category   text        not null,
    user_id       bigint references users (id),
    created_at    timestamptz not null default now()
);
