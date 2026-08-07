-- Purchasing panel (Inventory UX, locked 2026-08-07): tracks the shopping
-- list's lifecycle. queued (manual add, ordered_at null) → on order
-- (ordered_at set) → received (received_at set; the receive step writes the
-- PURCHASE ledger entry). Rows are kept after receipt as purchase history.
create table purchases (
    id bigserial primary key,
    material_id bigint not null references materials (id),
    quantity numeric(12, 2) not null,
    est_cost_minor bigint,
    ordered_at timestamptz,
    received_at timestamptz,
    created_at timestamptz not null default now()
);

create index purchases_active_idx on purchases (material_id) where received_at is null;
