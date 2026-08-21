-- Correct Catalog demand-funnel source to the populated Data Kiosk child-ASIN grain.
-- Amazon salesAndTrafficTrends is collected at CHILD ASIN/day. Seller SKU is mapped
-- through mart.seller_catalog; do not claim a finer traffic grain than the source.

CREATE OR REPLACE VIEW mart.catalog_portfolio_product AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS through_date
    FROM core.asin_sales_traffic_daily
    GROUP BY marketplace_id
),
traffic AS (
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
    GROUP BY a.marketplace_id, a.asin, c.through_date
),
parents AS (
    SELECT DISTINCT marketplace_id, parent_asin AS asin
    FROM core.asin_sales_traffic_daily
    WHERE parent_asin IS NOT NULL AND parent_asin <> '' AND parent_asin <> asin
)
SELECT
    sc.marketplace_id,
    sc.seller_sku,
    sc.asin,
    t.parent_asin,
    CASE
        WHEN p.asin IS NOT NULL THEN sc.asin
        ELSE COALESCE(NULLIF(t.parent_asin,''), sc.asin)
    END AS family_asin,
    CASE
        WHEN p.asin IS NOT NULL THEN 'STRUCTURAL_PARENT'
        WHEN t.parent_asin IS NOT NULL AND t.parent_asin <> sc.asin THEN 'SELLABLE_VARIATION'
        ELSE 'SELLABLE_STANDALONE'
    END AS product_role,
    sc.title,
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
    CASE WHEN COALESCE(t.sessions_prior_t28,0) > 0 AND COALESCE(t.sessions_t28,0) > 0
         THEN round(
             (100.0 * t.units_t28 / t.sessions_t28)
             - (100.0 * t.units_prior_t28 / t.sessions_prior_t28),
             2
         )
    END AS conversion_delta28_pp,
    t.through_date AS traffic_through_date,
    (ci.asin IS NOT NULL) AS catalog_enriched
FROM mart.seller_catalog sc
LEFT JOIN traffic t
  ON t.marketplace_id=sc.marketplace_id AND t.asin=sc.asin
LEFT JOIN parents p
  ON p.marketplace_id=sc.marketplace_id AND p.asin=sc.asin
LEFT JOIN mart.inventory_attention i
  ON i.marketplace_id=sc.marketplace_id AND i.seller_sku=sc.seller_sku
LEFT JOIN core.catalog_item ci
  ON ci.marketplace_id=sc.marketplace_id AND ci.asin=sc.asin;

COMMENT ON VIEW mart.catalog_portfolio_product IS
'Commercial Catalog grain: seller offer identity + family role + canonical Data Kiosk CHILD-ASIN 28-day traffic/conversion/sales + current inventory. Traffic is never presented at a finer grain than Amazon supplied.';
