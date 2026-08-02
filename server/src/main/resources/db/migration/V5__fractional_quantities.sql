-- Fractional consumption (0.05 bottle of glue per unit) needs finer scale
-- than 2 decimals; 3 covers realistic per-unit dabs without float drift.
alter table product_slots
    alter column quantity type numeric(12, 3);
alter table inventory_transactions
    alter column delta type numeric(12, 3);
