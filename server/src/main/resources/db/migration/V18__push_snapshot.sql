-- Drift baseline: what we last pushed (or imported) — Etsy differing from
-- this is drift; Shopkeep differing from it is a pending change.
alter table listings add column pushed_snapshot jsonb;
alter table listings add column last_push_error text;
