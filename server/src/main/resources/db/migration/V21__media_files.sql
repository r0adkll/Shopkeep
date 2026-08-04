-- D21: large media (listing videos) lives on a filesystem volume, not in
-- Postgres. documents stays the single index for all binaries; `storage`
-- discriminates inline bytea from on-disk files (content-hash path, sha256
-- + size recorded so a media-less restore can detect what's missing).
alter table documents alter column bytes drop not null;
alter table documents add column storage text not null default 'inline';
alter table documents add column file_path text;
alter table documents add column sha256 text;
alter table documents add column size_bytes bigint;

-- one video per listing (Etsy's cap)
alter table listings add column video_document_id bigint references documents(id);
