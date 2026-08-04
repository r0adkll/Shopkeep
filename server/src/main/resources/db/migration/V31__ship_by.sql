-- Etsy's expected_ship_date (per transaction; order-level = earliest) —
-- the real deadline the queue works against.
alter table orders add column ship_by timestamptz;
