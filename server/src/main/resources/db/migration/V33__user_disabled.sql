-- User management (Users & Auth): soft-disable only — deleting users would
-- orphan note/event provenance.
alter table users add column disabled boolean not null default false;
