-- Remembered manual matches: a platform listing id that resolves to a
-- canonical listing it doesn't share an etsy_listing_id with (e.g. a
-- "seconds sale" listing selling the same product). Ingest and retro-match
-- consult this after the direct etsy_listing_id lookup.
create table listing_matches (
    platform_listing_id text primary key,
    listing_id bigint not null references listings(id) on delete cascade,
    created_at timestamptz not null default now()
);
