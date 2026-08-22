-- Product-grain monetary basis using the data actually available in production.
--
-- Amazon Data Kiosk Sales & Traffic is currently populated at CHILD-ASIN grain.
-- Do not pretend seller-SKU Sales & Traffic exists when it does not. Commercial
-- product sales therefore attach ASIN demand once to the canonical offer owner,
-- while inventory velocity remains SKU/order-unit based because replenishment is
-- an operational unit question, not a revenue-allocation question.

CREATE OR REPLACE VIEW mart.sku_velocity_t28 AS
WITH cutoff AS (
    SELECT marketplace_id,max(business_date) AS cutoff_date
    FROM mart.sku_daily
    GROUP BY marketplace_id
)
SELECT
    s.marketplace_id,
    s.seller_sku,
    max(s.asin) AS asin,
    COALESCE(sum(s.sales),0)::numeric(14,2) AS sales_t28,
    COALESCE(sum(s.units),0)::bigint AS units_t28,
    COALESCE(sum(s.orders),0)::bigint AS orders_t28,
    (COALESCE(sum(s.units),0)::numeric / 28.0) AS units_per_day
FROM mart.sku_daily s
JOIN cutoff c USING(marketplace_id)
WHERE s.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date
GROUP BY s.marketplace_id,s.seller_sku;

COMMENT ON VIEW mart.sku_velocity_t28 IS
'Operational SKU velocity for inventory. Units/orders come from Orders at seller-SKU grain. sales_t28 is gross shopper spend and is not the canonical commercial product-sales measure.';

CREATE OR REPLACE VIEW mart.catalog_movers_t28 AS
WITH cutoff AS (
    SELECT marketplace_id,max(business_date) AS cutoff_date
    FROM core.asin_sales_traffic_daily
    GROUP BY marketplace_id
), canonical AS (
    SELECT marketplace_id,seller_sku,asin
    FROM mart.catalog_portfolio_product
    WHERE is_offer_owner
      AND product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
), agg AS (
    SELECT
        p.marketplace_id,
        p.seller_sku,
        p.asin,
        COALESCE(sum(a.ordered_product_sales) FILTER (
            WHERE a.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date
        ),0)::numeric(14,2) AS sales_t28,
        COALESCE(sum(a.units_ordered) FILTER (
            WHERE a.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date
        ),0)::bigint AS units_t28,
        COALESCE(sum(a.ordered_product_sales) FILTER (
            WHERE a.business_date BETWEEN c.cutoff_date-55 AND c.cutoff_date-28
        ),0)::numeric(14,2) AS sales_prior_t28
    FROM canonical p
    JOIN cutoff c USING(marketplace_id)
    LEFT JOIN core.asin_sales_traffic_daily a
      ON a.marketplace_id=p.marketplace_id
     AND a.asin=p.asin
     AND a.business_date BETWEEN c.cutoff_date-55 AND c.cutoff_date
    GROUP BY p.marketplace_id,p.seller_sku,p.asin
)
SELECT
    a.*,
    CASE
        WHEN sales_prior_t28>0 THEN round(100.0*(sales_t28-sales_prior_t28)/sales_prior_t28,1)
        WHEN sales_t28>0 THEN NULL
        ELSE 0::numeric
    END AS delta28_pct,
    CASE
        WHEN sales_t28>0 AND sales_prior_t28=0 THEN 'NEW'
        WHEN sales_prior_t28>0 AND sales_t28>=sales_prior_t28*1.20 THEN 'ACCELERATING'
        WHEN sales_prior_t28>0 AND sales_t28>=sales_prior_t28*1.05 THEN 'GROWING'
        WHEN sales_prior_t28>0 AND sales_t28<=sales_prior_t28*0.80 THEN 'DECLINING'
        WHEN sales_prior_t28>0 AND sales_t28<=sales_prior_t28*0.95 THEN 'COOLING'
        ELSE 'STABLE'
    END AS state
FROM agg a;

COMMENT ON VIEW mart.catalog_movers_t28 IS
'Canonical commercial product movers. CHILD-ASIN Sales & Traffic demand is attached exactly once to the canonical seller offer owner; seller-SKU aliases and structural parents are excluded.';
