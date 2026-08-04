-- V7's platform check predates the USPS connection (D22) — the same
-- constraint-drift trap as the sku_mode saga. Widen it.
alter table storefront_connections drop constraint storefront_connections_platform_check;
alter table storefront_connections add constraint storefront_connections_platform_check
    check (platform in ('etsy', 'shopify', 'usps'));
