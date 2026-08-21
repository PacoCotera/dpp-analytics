-- Canonical commercial portfolio grain for Catalog.
-- Keep seller offers distinct from structural parent ASINs and connect the demand
-- funnel (traffic -> conversion -> units/sales) with inventory at seller-SKU grain.

CREATE OR REPLACE VIEW mart.catalog_portfolio_product AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS through_date
    FROM core.sku_sales_traffic_daily
    GROUP BY marketplace_id
),
traffic AS (
    SELECT
        s.marketplace_id,
        s.seller_sku,
        max(s.asin) AS asin,
        c.through_date,
        COALESCE(sum(s.ordered_product_sales) FILTER (
            WHERE s.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::numeric(14,2) AS sales_t28,
        COALESCE(sum(s.units_ordered) FILTER (
            WHERE s.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::bigint AS units_t28,
        COALESCE(sum(s.total_order_items) FILTER (
            WHERE s.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::bigint AS orders_t28,
        COALESCE(sum(s.sessions) FILTER (
            WHERE s.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::bigint AS sessions_t28,
        COALESCE(sum(s.page_views) FILTER (
            WHERE s.business_date BETWEEN c.through_date - 27 AND c.through_date
        ),0)::bigint AS page_views_t28,
        COALESCE(sum(s.ordered_product_sales) FILTER (
            WHERE s.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
        ),0)::numeric(14,2) AS sales_prior_t28,
        COALESCE(sum(s.units_ordered) FILTER (
            WHERE s.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
        ),0)::bigint AS units_prior_t28,
        COALESCE(sum(s.sessions) FILTER (
            WHERE s.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
        ),0)::bigint AS sessions_prior_t28
    FROM core.sku_sales_traffic_daily s
    JOIN cutoff c USING (marketplace_id)
    WHERE s.business_date BETWEEN c.through_date - 55 AND c.through_date
    GROUP BY s.marketplace_id, s.seller_sku, c.through_date
),
relationship AS (
    SELECT DISTINCT ON (marketplace_id, asin)
        marketplace_id,
        asin,
        parent_asin
    FROM core.asin_sales_traffic_daily
    WHERE parent_asin IS NOT NULL AND parent_asin <> ''
    ORDER BY marketplace_id, asin, business_date DESC
),
parents AS (
    SELECT DISTINCT marketplace_id, parent_asin AS asin
    FROM relationship
    WHERE parent_asin IS NOT NULL AND parent_asin <> asin
)
SELECT
    sc.marketplace_id,
    sc.seller_sku,
    sc.asin,
    r.parent_asin,
    CASE
        WHEN p.asin IS NOT NULL THEN sc.asin
        ELSE COALESCE(NULLIF(r.parent_asin,''), sc.asin)
    END AS family_asin,
    CASE
        WHEN p.asin IS NOT NULL THEN 'STRUCTURAL_PARENT'
        WHEN r.parent_asin IS NOT NULL AND r.parent_asin <> sc.asin THEN 'SELLABLE_VARIATION'
        ELSE 'SELLABLE_STANDALONE'
    END AS product_role,
    sc.title,
    -- Prefer exact-ASIN Catalog Items media. Seller-report media is a fallback only.
    COALESCE(ci.image_url, sc.image_url) AS image_url,
    sc.price,
    sc.status,
    sc.fulfillment_channel,
    sc.open_date,
    sc.fetched_at,
    COALESCE(i.available,0)::int AS available,
    COALESCE(i.inbound,0)::int AS inbound,
    i.days_cover_on_hand,
    i.days_cover_with_inbound,
    COALESCE(i.action,'HOLD') AS inventory_action,
    COALESCE(t.sales_t28,0)::numeric(14,2) AS sales_t28,
    COALESCE(t.units_t28,0)::bigint AS units_t28,
    COALESCE(t.orders_t28,0)::bigint AS orders_t28,
    COALESCE(t.sessions_t28,0)::bigint AS sessions_t28,
    COALESCE(t.page_views_t28,0)::bigint AS page_views_t28,
    CASE WHEN COALESCE(t.sessions_t28,0) > 0
         THEN round(100.0 * t.units_t28 / t.sessions_t28, 2)
    END AS conversion_t28_pct,
    CASE WHEN COALESCE(t.sales_prior_t28,0) > 0
         THEN round(100.0 * (t.sales_t28 - t.sales_prior_t28) / t.sales_prior_t28, 1)
         WHEN COALESCE(t.sales_t28,0) > 0 THEN NULL
         ELSE 0::numeric
    END AS sales_delta28_pct,
    CASE WHEN COALESCE(t.sessions_prior_t28,0) > 0
         THEN round(100.0 * (t.sessions_t28 - t.sessions_prior_t28) / t.sessions_prior_t28, 1)
         WHEN COALESCE(t.sessions_t28,0) > 0 THEN NULL
         ELSE 0::numeric
    END AS sessions_delta28_pct,
    CASE WHEN COALESCE(t.sessions_prior_t28,0) > 0
         THEN round(
             (100.0 * t.units_t28 / NULLIF(t.sessions_t28,0))
             - (100.0 * t.units_prior_t28 / NULLIF(t.sessions_prior_t28,0)),
             2
         )
    END AS conversion_delta28_pp,
    t.through_date AS traffic_through_date,
    (ci.asin IS NOT NULL) AS catalog_enriched
FROM mart.seller_catalog sc
LEFT JOIN traffic t
  ON t.marketplace_id=sc.marketplace_id AND t.seller_sku=sc.seller_sku
LEFT JOIN relationship r
  ON r.marketplace_id=sc.marketplace_id AND r.asin=sc.asin
LEFT JOIN parents p
  ON p.marketplace_id=sc.marketplace_id AND p.asin=sc.asin
LEFT JOIN mart.inventory_attention i
  ON i.marketplace_id=sc.marketplace_id AND i.seller_sku=sc.seller_sku
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=sc.marketplace_id AND ci.asin=sc.asin;

COMMENT ON VIEW mart.catalog_portfolio_product IS
'Commercial Catalog grain: seller offer identity + family role + Data Kiosk 28-day traffic/conversion/sales + current inventory. Structural parent ASINs are explicitly non-sellable containers.';
