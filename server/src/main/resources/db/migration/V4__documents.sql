-- Documents live in Postgres so pg_dump remains a complete backup (vault: D12).
-- First occupants: product images; fulfillment PDFs join in Phase 5.
create table documents (
    id           bigint generated always as identity primary key,
    kind         text        not null,
    content_type text        not null,
    filename     text,
    bytes        bytea       not null,
    created_at   timestamptz not null default now()
);

alter table products
    add column image_document_id bigint references documents (id) on delete set null;
