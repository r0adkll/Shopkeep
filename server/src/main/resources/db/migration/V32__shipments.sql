-- Locked ship-flow concept (Order Management § Fulfillment): one row per
-- physical shipment. Etsy-sourced rows arrive via receipt.shipments; the
-- label cost attaches heuristically from the payment ledger (nearest
-- unclaimed shipping_labels entry near the notification time). USPS-sourced
-- rows (Path B) will carry exact data.
create table shipments (
    id bigint generated always as identity primary key,
    order_id bigint not null references orders(id),
    etsy_shipping_id text unique,
    source text not null default 'etsy',
    carrier_name text,
    tracking_code text,
    mail_class text,
    weight_grams double precision,
    length_in double precision, width_in double precision, height_in double precision,
    ship_date timestamptz,
    label_cost_minor bigint,
    label_ledger_entry_id bigint unique,
    created_at timestamptz not null default now()
);
