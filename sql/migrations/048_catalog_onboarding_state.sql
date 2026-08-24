-- Track when seller SKUs first enter our catalog and when Catalog Items has
-- actually been attempted/enriched. Listing discovery and Catalog enrichment
-- run on different cadences, so a newly created Amazon offer may legitimately
-- exist in a partial state for a short propagation window.
ALTER TABLE core.seller_listing
    ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;

UPDATE core.seller_listing
SET first_seen_at = COALESCE(open_date::timestamptz, fetched_at, CURRENT_TIMESTAMP)
WHERE first_seen_at IS NULL;

ALTER TABLE core.seller_listing
    ALTER COLUMN first_seen_at SET DEFAULT CURRENT_TIMESTAMP,
    ALTER COLUMN first_seen_at SET NOT NULL;

ALTER TABLE core.catalog_item
    ADD COLUMN IF NOT EXISTS catalog_last_attempt_at timestamptz,
    ADD COLUMN IF NOT EXISTS catalog_enriched_at timestamptz;

-- Existing rows that already carry Catalog-only metadata are known to have
-- completed an enrichment pass before this lifecycle tracking existed.
UPDATE core.catalog_item
SET catalog_enriched_at = COALESCE(catalog_enriched_at, updated_at),
    catalog_last_attempt_at = COALESCE(catalog_last_attempt_at, updated_at)
WHERE catalog_enriched_at IS NULL
  AND (attributes IS NOT NULL OR relationships IS NOT NULL OR product_types IS NOT NULL);

CREATE OR REPLACE VIEW mart.catalog_onboarding_state AS
SELECT
    l.marketplace_id,
    l.seller_sku,
    l.asin,
    l.status,
    l.first_seen_at,
    l.fetched_at AS listing_fetched_at,
    ci.catalog_last_attempt_at,
    ci.catalog_enriched_at,
    CASE
      WHEN lower(COALESCE(l.status,'')) = 'inactive' THEN 'INACTIVE'
      WHEN NULLIF(btrim(l.asin),'') IS NULL THEN 'AWAITING_ASIN'
      WHEN ci.asin IS NULL OR ci.catalog_enriched_at IS NULL THEN 'AWAITING_CATALOG'
      WHEN ci.attributes IS NULL AND ci.relationships IS NULL AND ci.product_types IS NULL THEN 'CATALOG_PROPAGATING'
      ELSE 'SOURCE_READY'
    END AS source_state,
    extract(epoch FROM (CURRENT_TIMESTAMP - l.first_seen_at))::bigint AS age_seconds,
    (l.first_seen_at >= CURRENT_TIMESTAMP - interval '48 hours') AS is_onboarding,
    (
      lower(COALESCE(l.status,'')) <> 'inactive'
      AND l.first_seen_at < CURRENT_TIMESTAMP - interval '48 hours'
      AND (
        NULLIF(btrim(l.asin),'') IS NULL
        OR ci.asin IS NULL
        OR ci.catalog_enriched_at IS NULL
        OR (ci.attributes IS NULL AND ci.relationships IS NULL AND ci.product_types IS NULL)
      )
    ) AS source_attention
FROM core.seller_listing l
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=l.marketplace_id AND ci.asin=l.asin;

COMMENT ON VIEW mart.catalog_onboarding_state IS
'Catalog ingestion lifecycle. New seller SKUs may temporarily be AWAITING_ASIN, AWAITING_CATALOG, or CATALOG_PROPAGATING while Amazon surfaces complete listing/catalog data. source_attention begins only after a 48-hour grace window.';
