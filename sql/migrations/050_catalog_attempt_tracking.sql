BEGIN;

CREATE TABLE IF NOT EXISTS ops.catalog_item_attempt (
    marketplace_id text NOT NULL,
    asin text NOT NULL,
    last_attempt_at timestamptz NOT NULL,
    last_returned_at timestamptz,
    PRIMARY KEY (marketplace_id, asin)
);

COMMENT ON TABLE ops.catalog_item_attempt IS
'Operational Catalog Items request state for known ASINs. This is intentionally separate from core.catalog_item so an attempted-but-not-returned ASIN never masquerades as a canonical enriched catalog entity.';

-- Preserve any attempt/enrichment evidence recorded by migration 048 or an
-- intervening deployment before this dedicated operational relation existed.
INSERT INTO ops.catalog_item_attempt(marketplace_id, asin, last_attempt_at, last_returned_at)
SELECT marketplace_id,
       asin,
       COALESCE(catalog_last_attempt_at, updated_at),
       catalog_enriched_at
FROM core.catalog_item
WHERE catalog_last_attempt_at IS NOT NULL OR catalog_enriched_at IS NOT NULL
ON CONFLICT (marketplace_id, asin) DO UPDATE SET
    last_attempt_at=GREATEST(ops.catalog_item_attempt.last_attempt_at, EXCLUDED.last_attempt_at),
    last_returned_at=GREATEST(ops.catalog_item_attempt.last_returned_at, EXCLUDED.last_returned_at);

CREATE OR REPLACE VIEW mart.catalog_onboarding_state AS
SELECT
    l.marketplace_id,
    l.seller_sku,
    l.asin,
    l.status,
    l.first_seen_at,
    l.fetched_at AS listing_fetched_at,
    a.last_attempt_at AS catalog_last_attempt_at,
    COALESCE(a.last_returned_at, ci.catalog_enriched_at) AS catalog_enriched_at,
    CASE
      WHEN lower(COALESCE(l.status,'')) = 'inactive' THEN 'INACTIVE'
      WHEN NULLIF(btrim(l.asin),'') IS NULL THEN 'AWAITING_ASIN'
      WHEN a.last_attempt_at IS NULL THEN 'AWAITING_CATALOG'
      WHEN ci.asin IS NULL OR COALESCE(a.last_returned_at, ci.catalog_enriched_at) IS NULL
        THEN 'CATALOG_PROPAGATING'
      ELSE 'SOURCE_READY'
    END AS source_state,
    extract(epoch FROM (CURRENT_TIMESTAMP - l.first_seen_at))::bigint AS age_seconds,
    (l.first_seen_at >= CURRENT_TIMESTAMP - interval '48 hours') AS is_onboarding,
    (
      lower(COALESCE(l.status,'')) <> 'inactive'
      AND l.first_seen_at < CURRENT_TIMESTAMP - interval '48 hours'
      AND (
        NULLIF(btrim(l.asin),'') IS NULL
        OR a.last_attempt_at IS NULL
        OR ci.asin IS NULL
        OR COALESCE(a.last_returned_at, ci.catalog_enriched_at) IS NULL
      )
    ) AS source_attention
FROM core.seller_listing l
LEFT JOIN ops.catalog_item_attempt a
  ON a.marketplace_id=l.marketplace_id AND a.asin=l.asin
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=l.marketplace_id AND ci.asin=l.asin;

COMMENT ON VIEW mart.catalog_onboarding_state IS
'Catalog ingestion lifecycle. Seller Listings owns discovery; ops.catalog_item_attempt proves request attempts; core.catalog_item exists only when Amazon actually returned an entity. A 48-hour grace separates normal propagation from source attention.';

INSERT INTO ops.schema_migrations(filename)
VALUES ('050_catalog_attempt_tracking.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
