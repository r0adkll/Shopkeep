-- listing_level joined the sku modes (imported + design-axis listings)
-- but the original check constraint never learned about it.
alter table listings drop constraint listings_sku_mode_check;
alter table listings add constraint listings_sku_mode_check
    check (sku_mode in ('per_combination', 'per_primary', 'listing_level'));
