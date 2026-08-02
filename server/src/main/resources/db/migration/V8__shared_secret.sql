-- Etsy enforces x-api-key: keystring:shared_secret since 2026-02-09
-- (open-api #1521). Secret is a credential -> encrypted at rest like tokens.
alter table storefront_connections
    add column api_shared_secret_enc text;
alter table oauth_pending
    add column shared_secret text not null default '';
