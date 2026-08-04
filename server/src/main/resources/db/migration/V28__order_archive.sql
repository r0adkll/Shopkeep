-- Q8: completed orders leave the active board after a configurable window
-- (ORDER_ARCHIVE_DAYS, default 30). Never deleted.
alter table orders add column archived_at timestamptz;
