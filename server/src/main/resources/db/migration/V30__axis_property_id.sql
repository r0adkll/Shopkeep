-- Etsy's standard properties display differently on transactions than on
-- listings (property 200 = "Primary color" on the listing, "Color" on the
-- order). Matching by property id bridges it; names stay a fallback.
alter table listing_axes add column etsy_property_id bigint;
