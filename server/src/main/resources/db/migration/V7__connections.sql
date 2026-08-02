-- Phase 3: storefront connections (vault: Architecture, Etsy Integration).
-- Tokens are encrypted at rest with TOKEN_ENCRYPTION_KEY (vault: D12 caveat).

create table storefront_connections (
    id                bigint generated always as identity primary key,
    platform          text        not null check (platform in ('etsy')),
    label             text        not null default '',
    api_keystring     text        not null,
    shop_id           text,
    shop_name         text,
    user_ref          text,
    access_token_enc  text,
    refresh_token_enc text,
    token_expires_at  timestamptz,
    scopes            text        not null default '',
    status            text        not null default 'pending'
        check (status in ('pending', 'connected', 'error', 'disconnected')),
    last_verified_at  timestamptz,
    error_message     text,
    sync_cursor       timestamptz,
    created_at        timestamptz not null default now()
);

-- In-flight OAuth handshakes (state -> PKCE verifier); short-lived, restart-safe.
create table oauth_pending (
    state         text primary key,
    platform      text        not null,
    api_keystring text        not null,
    label         text        not null default '',
    verifier      text        not null,
    created_at    timestamptz not null default now()
);
