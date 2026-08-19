-- A seller may legitimately have more than one SKU associated with the same ASIN.
-- ASIN is therefore a lookup attribute, not a uniqueness key for core.sku.
DROP INDEX IF EXISTS core.sku_marketplace_asin_idx;

CREATE INDEX IF NOT EXISTS sku_marketplace_asin_idx
    ON core.sku (marketplace_id, asin)
    WHERE asin IS NOT NULL;
