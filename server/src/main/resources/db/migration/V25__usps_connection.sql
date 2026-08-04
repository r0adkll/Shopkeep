-- D22: USPS as a first-class connection. Platform-specific settings
-- (origin ZIP, mail class) ride a config jsonb; products may override the
-- derived ship weight.
alter table storefront_connections add column config jsonb;
alter table products add column ship_weight_grams bigint;
