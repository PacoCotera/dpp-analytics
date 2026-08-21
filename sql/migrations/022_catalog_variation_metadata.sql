ALTER TABLE core.catalog_item
    ADD COLUMN IF NOT EXISTS attributes jsonb,
    ADD COLUMN IF NOT EXISTS relationships jsonb,
    ADD COLUMN IF NOT EXISTS product_types jsonb,
    ADD COLUMN IF NOT EXISTS variation_theme text,
    ADD COLUMN IF NOT EXISTS variation_attributes text[];

COMMENT ON COLUMN core.catalog_item.attributes IS
    'Raw Catalog Items attributes for seller/product taxonomy analysis; source grain is ASIN + marketplace.';
COMMENT ON COLUMN core.catalog_item.relationships IS
    'Raw Catalog Items relationships including parent/child variation relationships.';
COMMENT ON COLUMN core.catalog_item.variation_theme IS
    'Amazon variation theme, when present, e.g. COLOR_NAME/STYLE_NAME.';
COMMENT ON COLUMN core.catalog_item.variation_attributes IS
    'Amazon attribute names participating in the variation theme. These describe dimensions, not seller-defined display values.';
