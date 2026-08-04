-- The unified diff engine persists 'pending' (changes to push) but the
-- original check predates it - constraint-drift instance #4. Widen.
alter table listings drop constraint listings_sync_state_check;
alter table listings add constraint listings_sync_state_check
    check (sync_state in ('not_published', 'imported', 'in_sync', 'drifted', 'pending'));
