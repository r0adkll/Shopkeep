-- Why a matched line needs review (human-readable, from the resolver), and
-- the exact BOM reserved for the line so a re-resolve can release precisely.
alter table order_lines add column review_reasons jsonb not null default '[]';
alter table order_lines add column reserved_bom jsonb;
