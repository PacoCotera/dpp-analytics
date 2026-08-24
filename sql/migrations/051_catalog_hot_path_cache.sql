-- Persist only the expensive rolling facts behind the commercial Catalog read.
--
-- Production baseline db408d58 measured /api/catalog at 6.775s cold and
-- /api/product at 4.775s cold while warm response-cache hits were <40ms.
-- Both surfaces read mart.catalog_portfolio_product. Keep seller identity,
-- inventory and Catalog metadata live, but stop rebuilding the same 56-day
-- Sales & Traffic and SKU activity aggregates on every request.

CREATE MATERIALIZED VIEW mart.catalog_traffic_t56_cache AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS through_date
    FROM core.asin_sales_traffic_daily
    GROUP BY marketplace_id
)
SELECT
    a.marketplace_id,
    a.asin,
    max(NULLIF(a.parent_asin,'')) AS parent_asin,
    c.through_date,
    COALESCE(sum(a.ordered_product_sales) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::numeric(14,2) AS sales_t28,
    COALESCE(sum(a.units_ordered) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::bigint AS units_t28,
    COALESCE(sum(a.total_order_items) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::bigint AS orders_t28,
    COALESCE(sum(a.sessions) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::bigint AS sessions_t28,
    COALESCE(sum(a.page_views) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::bigint AS page_views_t28,
    COALESCE(sum(a.ordered_product_sales) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
    ),0)::numeric(14,2) AS sales_prior_t28,
    COALESCE(sum(a.units_ordered) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
    ),0)::bigint AS units_prior_t28,
    COALESCE(sum(a.sessions) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
    ),0)::bigint AS sessions_prior_t28
FROM core.asin_sales_traffic_daily a
JOIN cutoff c USING (marketplace_id)
WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date
GROUP BY a.marketplace_id, a.asin, c.through_date;

CREATE UNIQUE INDEX catalog_traffic_t56_cache_pk
    ON mart.catalog_traffic_t56_cache(marketplace_id, asin);

COMMENT ON MATERIALIZED VIEW mart.catalog_traffic_t56_cache IS
'Persisted 28D/prior-28 child-ASIN Sales & Traffic facts used by Catalog/Product hot paths. Refreshed after successful Data Kiosk writes; seller listing/catalog/inventory identity remains live.';

CREATE MATERIALIZED VIEW mart.catalog_sku_activity_t56_cache AS
SELECT
    marketplace_id,
    seller_sku,
    COALESCE(sum(sales) FILTER (WHERE business_date >= current_date - 55),0)::numeric(14,2) AS recent_sales,
    COALESCE(sum(units) FILTER (WHERE business_date >= current_date - 55),0)::bigint AS recent_units
FROM mart.sku_daily
GROUP BY marketplace_id, seller_sku;

CREATE UNIQUE INDEX catalog_sku_activity_t56_cache_pk
    ON mart.catalog_sku_activity_t56_cache(marketplace_id, seller_sku);

COMMENT ON MATERIALIZED VIEW mart.catalog_sku_activity_t56_cache IS
'Persisted recent seller-SKU order activity used only for canonical offer-owner ranking. Refreshed after successful Orders writes.';

-- Preserve the exact commercial-offer contract from migration 021 while
-- replacing only its two repeated historical aggregation CTEs with compact
-- persisted relations. Existing dependent views keep the same object/columns.
CREATE OR REPLACE VIEW mart.catalog_portfolio_product AS
WITH parents AS (
    SELECT DISTINCT marketplace_id, parent_asin AS asin
    FROM mart.catalog_traffic_t56_cache
    WHERE parent_asin IS NOT NULL AND parent_asin <> '' AND parent_asin <> asin
),
ranked AS (
    SELECT
        sc.*,
        COALESCE(i.available,0)::int AS available,
        COALESCE(i.inbound,0)::int AS inbound,
        i.days_cover_on_hand,
        i.days_cover_with_inbound,
        COALESCE(i.action,'HOLD') AS inventory_action,
        row_number() OVER (
            PARTITION BY sc.marketplace_id, sc.asin
            ORDER BY
                (COALESCE(sa.recent_units,0) > 0) DESC,
                COALESCE(sa.recent_units,0) DESC,
                (COALESCE(i.available,0) + COALESCE(i.inbound,0) > 0) DESC,
                (lower(COALESCE(sc.status,'')) <> 'inactive') DESC,
                sc.open_date DESC NULLS LAST,
                sc.seller_sku
        )::int AS offer_rank
    FROM mart.seller_catalog sc
    LEFT JOIN mart.catalog_sku_activity_t56_cache sa
      ON sa.marketplace_id=sc.marketplace_id AND sa.seller_sku=sc.seller_sku
    LEFT JOIN mart.inventory_attention i
      ON i.marketplace_id=sc.marketplace_id AND i.seller_sku=sc.seller_sku
),
owners AS (
    SELECT marketplace_id, asin, seller_sku AS offer_owner_sku
    FROM ranked
    WHERE offer_rank=1
)
SELECT
    r.marketplace_id,
    r.seller_sku,
    r.asin,
    t.parent_asin,
    CASE
        WHEN p.asin IS NOT NULL THEN r.asin
        ELSE COALESCE(NULLIF(t.parent_asin,''), r.asin)
    END AS family_asin,
    CASE
        WHEN p.asin IS NOT NULL THEN 'STRUCTURAL_PARENT'
        WHEN r.offer_rank > 1 THEN 'SELLER_SKU_ALIAS'
        WHEN t.parent_asin IS NOT NULL AND t.parent_asin <> r.asin THEN 'SELLABLE_VARIATION'
        ELSE 'SELLABLE_STANDALONE'
    END AS product_role,
    r.offer_rank,
    o.offer_owner_sku,
    (r.offer_rank=1 AND p.asin IS NULL) AS is_offer_owner,
    r.title,
    COALESCE(ci.image_url, r.image_url) AS image_url,
    CASE WHEN ci.image_url IS NOT NULL THEN 'CATALOG_EXACT_ASIN'
         WHEN r.image_url IS NOT NULL THEN 'SELLER_LISTING_EXACT_ASIN'
         ELSE 'NONE' END AS image_source,
    r.price,
    r.status,
    r.fulfillment_channel,
    r.open_date,
    r.fetched_at,
    r.available,
    r.inbound,
    r.days_cover_on_hand,
    r.days_cover_with_inbound,
    r.inventory_action,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(t.sales_t28,0) ELSE 0 END::numeric(14,2) AS sales_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(t.units_t28,0) ELSE 0 END::bigint AS units_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(t.orders_t28,0) ELSE 0 END::bigint AS orders_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(t.sessions_t28,0) ELSE 0 END::bigint AS sessions_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(t.page_views_t28,0) ELSE 0 END::bigint AS page_views_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL AND COALESCE(t.sessions_t28,0)>0
         THEN round(100.0*t.units_t28/t.sessions_t28,2) END AS conversion_t28_pct,
    CASE WHEN r.offer_rank<>1 OR p.asin IS NOT NULL THEN NULL
         WHEN COALESCE(t.sales_prior_t28,0)>0 THEN round(100.0*(t.sales_t28-t.sales_prior_t28)/t.sales_prior_t28,1)
         WHEN COALESCE(t.sales_t28,0)>0 THEN NULL ELSE 0::numeric END AS sales_delta28_pct,
    CASE WHEN r.offer_rank<>1 OR p.asin IS NOT NULL THEN NULL
         WHEN COALESCE(t.sessions_prior_t28,0)>0 THEN round(100.0*(t.sessions_t28-t.sessions_prior_t28)/t.sessions_prior_t28,1)
         WHEN COALESCE(t.sessions_t28,0)>0 THEN NULL ELSE 0::numeric END AS sessions_delta28_pct,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL AND COALESCE(t.sessions_prior_t28,0)>0 AND COALESCE(t.sessions_t28,0)>0
         THEN round((100.0*t.units_t28/t.sessions_t28)-(100.0*t.units_prior_t28/t.sessions_prior_t28),2) END AS conversion_delta28_pp,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN t.through_date ELSE NULL END AS traffic_through_date,
    (ci.asin IS NOT NULL) AS catalog_enriched
FROM ranked r
JOIN owners o USING (marketplace_id, asin)
LEFT JOIN mart.catalog_traffic_t56_cache t
  ON t.marketplace_id=r.marketplace_id AND t.asin=r.asin
LEFT JOIN parents p
  ON p.marketplace_id=r.marketplace_id AND p.asin=r.asin
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=r.marketplace_id AND ci.asin=r.asin;

COMMENT ON VIEW mart.catalog_portfolio_product IS
'Canonical commercial Catalog identity. Rolling child-ASIN traffic and seller-SKU activity are persisted in dedicated hot-path caches; seller listing, Catalog metadata and inventory remain live. Demand is attached once to the canonical seller offer owner per ASIN.';
