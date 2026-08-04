-- Etsy payment-account ledger mirror: actual money events (shipping labels,
-- fees, ads...) for order fee attribution now and Stats later. Entries are
-- immutable on Etsy's side; entry_id pk makes ingestion idempotent.
create table platform_ledger_entries (
    entry_id bigint primary key,
    connection_id bigint not null,
    ledger_type text not null,
    reference_type text,
    reference_id text,
    amount_minor bigint not null,
    currency text not null default 'USD',
    created_at timestamptz
);
create index idx_ledger_type_ref on platform_ledger_entries (ledger_type, reference_id);

-- Seller's expected postage for a box size — feeds the order cost
-- breakdown as "Shipping (est.)" until real per-order label costs exist.
alter table packaging_profiles add column ship_cost_estimate_minor bigint;
