-- D20 extension: designs can add net-new materials (not just fill slots) —
-- e.g. a colorway that includes an extra insert or decal only it uses.
alter table product_designs add column extras jsonb not null default '[]';
