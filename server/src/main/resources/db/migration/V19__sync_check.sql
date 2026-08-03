-- Background listing-sync check (one shop-listings fetch per poll cycle).
alter table listings add column sync_checked_at timestamptz;
