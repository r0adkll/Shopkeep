-- Per-combination SKUs for listings whose axes aren't material-sourced
-- (no configuration rows exist there): [{values: [label per axis], sku}].
alter table listings add column combo_skus jsonb not null default '[]';
