-- Listing↔product seam (locked 2026-08-02): axes declare a value source;
-- values can point at designs/variants/override-set binds, carry a
-- buyer-facing label, and listing-level SKU is editable.
alter table listing_axes add column value_source text not null default 'materials';
alter table listing_axis_values alter column material_id drop not null;
alter table listing_axis_values add column design_id bigint references product_designs (id);
alter table listing_axis_values add column variant_id bigint references product_variants (id);
alter table listing_axis_values add column override_key text; -- 'base' or a design override-set key (explicit bind)
alter table listing_axis_values add column display_label text; -- buyer-facing; defaults to source name
alter table listings add column listing_sku text; -- listing-level SKU (sku_mode=listing_level)
