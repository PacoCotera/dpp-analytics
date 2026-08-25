-- Catalog family identity must not depend on historical traffic existing first.
-- Prefer the live SKU relationship populated from Catalog Items or a guarded
-- seller correction; retain Sales & Traffic parent evidence as a fallback.
CREATE OR REPLACE VIEW mart.catalog_portfolio_product AS
WITH parents AS (
    SELECT DISTINCT marketplace_id, parent_asin AS asin
    FROM mart.catalog_traffic_t56_cache
    WHERE parent_asin IS NOT NULL AND parent_asin <> '' AND parent_asin <> asin
    UNION
    SELECT DISTINCT marketplace_id, parent_asin AS asin
    FROM core.sku
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
),
identified AS (
    SELECT
        r.*,
        COALESCE(NULLIF(s.parent_asin,''), NULLIF(t.parent_asin,'')) AS resolved_parent_asin,
        t.through_date,
        t.sales_t28,
        t.units_t28,
        t.orders_t28,
        t.sessions_t28,
        t.page_views_t28,
        t.sales_prior_t28,
        t.units_prior_t28,
        t.sessions_prior_t28
    FROM ranked r
    LEFT JOIN mart.catalog_traffic_t56_cache t
      ON t.marketplace_id=r.marketplace_id AND t.asin=r.asin
    LEFT JOIN core.sku s
      ON s.sku=r.seller_sku AND s.marketplace_id=r.marketplace_id
)
SELECT
    r.marketplace_id,
    r.seller_sku,
    r.asin,
    r.resolved_parent_asin AS parent_asin,
    CASE
        WHEN p.asin IS NOT NULL THEN r.asin
        ELSE COALESCE(r.resolved_parent_asin, r.asin)
    END AS family_asin,
    CASE
        WHEN p.asin IS NOT NULL THEN 'STRUCTURAL_PARENT'
        WHEN r.offer_rank > 1 THEN 'SELLER_SKU_ALIAS'
        WHEN r.resolved_parent_asin IS NOT NULL AND r.resolved_parent_asin <> r.asin THEN 'SELLABLE_VARIATION'
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
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(r.sales_t28,0) ELSE 0 END::numeric(14,2) AS sales_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(r.units_t28,0) ELSE 0 END::bigint AS units_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(r.orders_t28,0) ELSE 0 END::bigint AS orders_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(r.sessions_t28,0) ELSE 0 END::bigint AS sessions_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(r.page_views_t28,0) ELSE 0 END::bigint AS page_views_t28,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL AND COALESCE(r.sessions_t28,0)>0
         THEN round(100.0*r.units_t28/r.sessions_t28,2) END AS conversion_t28_pct,
    CASE WHEN r.offer_rank<>1 OR p.asin IS NOT NULL THEN NULL
         WHEN COALESCE(r.sales_prior_t28,0)>0 THEN round(100.0*(r.sales_t28-r.sales_prior_t28)/r.sales_prior_t28,1)
         WHEN COALESCE(r.sales_t28,0)>0 THEN NULL ELSE 0::numeric END AS sales_delta28_pct,
    CASE WHEN r.offer_rank<>1 OR p.asin IS NOT NULL THEN NULL
         WHEN COALESCE(r.sessions_prior_t28,0)>0 THEN round(100.0*(r.sessions_t28-r.sessions_prior_t28)/r.sessions_prior_t28,1)
         WHEN COALESCE(r.sessions_t28,0)>0 THEN NULL ELSE 0::numeric END AS sessions_delta28_pct,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL AND COALESCE(r.sessions_prior_t28,0)>0 AND COALESCE(r.sessions_t28,0)>0
         THEN round((100.0*r.units_t28/r.sessions_t28)-(100.0*r.units_prior_t28/r.sessions_prior_t28),2) END AS conversion_delta28_pp,
    CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN r.through_date ELSE NULL END AS traffic_through_date,
    (ci.asin IS NOT NULL) AS catalog_enriched
FROM identified r
JOIN owners o USING (marketplace_id, asin)
LEFT JOIN parents p
  ON p.marketplace_id=r.marketplace_id AND p.asin=r.asin
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=r.marketplace_id AND ci.asin=r.asin;

COMMENT ON VIEW mart.catalog_portfolio_product IS
'Canonical commercial Catalog identity. Live SKU/Catalog parent identity takes precedence over persisted rolling traffic evidence, allowing newly onboarded variants to join their family before their first traffic day.';
