-- Purchase links from the OFD stores dataset, per variant.
alter table filament_catalog add column links jsonb not null default '[]';

-- Existing mirrors were built before links were parsed: dropping the
-- refresh stamp makes the poll loop re-download on its next cycle.
delete from settings where key = 'filamentdb_refreshed_at';
