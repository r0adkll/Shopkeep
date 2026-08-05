-- Mirror of the Open Filament Database (openfilamentdatabase.org): one row
-- per color variant, denormalized for search. Rebuilt wholesale on refresh —
-- nothing else references these rows by id; materials keep only the stable
-- OFD variant id in their attributes.
create table filament_catalog (
    variant_id text primary key,
    brand text not null,
    line text not null,
    material text not null,
    color_name text not null,
    color_hex text,
    density numeric(8, 4),
    data_sheet_url text,
    discontinued boolean not null default false,
    sizes jsonb not null default '[]'
);

create index filament_catalog_brand_idx on filament_catalog (brand);
