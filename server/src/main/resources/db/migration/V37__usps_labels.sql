-- Path B (D22 extension): USPS label purchase. The bought label PDF lives in
-- documents (pg_dump-complete per D12); shipments reference it.
alter table shipments add column label_document_id bigint;
