-- Phase 4: order detail panel (locked concept) — ship-to/status/gift/totals
-- straight off the Etsy receipt, real fees from the payments API, and
-- Shopkeep-native private notes (Etsy exposes no note or messaging API).

alter table orders
    add column ship_name       text,
    add column ship_line1      text,
    add column ship_line2      text,
    add column ship_city       text,
    add column ship_state      text,
    add column ship_zip        text,
    add column ship_country    text,
    add column payment_method  text,
    add column is_gift         boolean not null default false,
    add column gift_message    text,
    add column gift_sender     text,
    add column subtotal_minor  bigint,
    add column shipping_minor  bigint,
    add column tax_minor       bigint,
    add column discount_minor  bigint,
    add column fees_minor      bigint, -- Etsy payments API amount_fees; null until synced
    add column platform_paid    boolean not null default true,
    add column platform_shipped boolean not null default false;

create table order_notes (
    id           bigint generated always as identity primary key,
    order_id     bigint not null references orders (id) on delete cascade,
    user_id      bigint references users (id),
    body         text   not null default '',
    document_ids jsonb  not null default '[]', -- photo attachments (documents table, D12)
    created_at   timestamptz not null default now()
);
