BEGIN;

-- 048 introduced the durable lifecycle columns. Refine the read model without
-- rewriting applied migration history: a known ASIN that has never been queried
-- is AWAITING_CATALOG; once queried but not returned by Amazon it is explicitly
-- CATALOG_PROPAGATING.
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
      WHEN ci.asin IS NULL OR ci.catalog_last_attempt_at IS NULL THEN 'AWAITING_CATALOG'
      WHEN ci.catalog_enriched_at IS NULL THEN 'CATALOG_PROPAGATING'
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
      )
    ) AS source_attention
FROM core.seller_listing l
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=l.marketplace_id AND ci.asin=l.asin;

COMMENT ON VIEW mart.catalog_onboarding_state IS
'Catalog ingestion lifecycle. AWAITING_CATALOG means an ASIN is known but not yet queried; CATALOG_PROPAGATING means Catalog Items was queried but Amazon has not returned the item. Source attention begins only after a 48-hour grace window.';

INSERT INTO ops.schema_migrations(filename)
VALUES ('049_catalog_propagation_state.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
