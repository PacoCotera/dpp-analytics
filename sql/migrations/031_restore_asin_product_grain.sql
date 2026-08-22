-- Restore canonical product demand at child-ASIN grain after migration 029.
-- Seller SKUs are offer identifiers; aliases must not duplicate customer demand.

CREATE OR REPLACE VIEW mart.sku_velocity_t28 AS
WITH cutoff AS (
    SELECT marketplace_id,max(business_date) cutoff_date FROM core.asin_sales_traffic_daily GROUP BY marketplace_id
), ranked_listing AS (
    SELECT sc.marketplace_id,sc.seller_sku,sc.asin,
           row_number() OVER (PARTITION BY sc.marketplace_id,sc.asin ORDER BY
             CASE WHEN lower(COALESCE(sc.status,''))<>'inactive' THEN 0 ELSE 1 END,
             CASE WHEN COALESCE(sc.active,true) THEN 0 ELSE 1 END,
             sc.fetched_at DESC NULLS LAST,sc.open_date DESC NULLS LAST,sc.seller_sku) offer_rank
    FROM mart.seller_catalog sc WHERE sc.asin IS NOT NULL AND sc.asin<>''
), demand AS (
    SELECT a.marketplace_id,a.asin,
           COALESCE(sum(a.ordered_product_sales),0)::numeric(14,2) sales_t28,
           COALESCE(sum(a.units_ordered),0)::bigint units_t28,
           COALESCE(sum(a.total_order_items),0)::bigint orders_t28
    FROM core.asin_sales_traffic_daily a JOIN cutoff c USING(marketplace_id)
    WHERE a.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date GROUP BY a.marketplace_id,a.asin
), parents AS (
    SELECT DISTINCT marketplace_id,parent_asin asin FROM core.asin_sales_traffic_daily
    WHERE parent_asin IS NOT NULL AND parent_asin<>'' AND parent_asin<>asin
)
SELECT r.marketplace_id,r.seller_sku,r.asin,
       CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(d.sales_t28,0) ELSE 0 END::numeric(14,2) sales_t28,
       CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(d.units_t28,0) ELSE 0 END::bigint units_t28,
       CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(d.orders_t28,0) ELSE 0 END::bigint orders_t28,
       (CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(d.units_t28,0) ELSE 0 END::numeric/28.0) units_per_day
FROM ranked_listing r LEFT JOIN demand d ON d.marketplace_id=r.marketplace_id AND d.asin=r.asin
LEFT JOIN parents p ON p.marketplace_id=r.marketplace_id AND p.asin=r.asin;

COMMENT ON VIEW mart.sku_velocity_t28 IS
'Reconciled 28-day child-ASIN demand assigned once to the canonical seller offer. Aliases and structural parents receive zero demand.';

CREATE OR REPLACE VIEW mart.catalog_movers_t28 AS
WITH cutoff AS (
    SELECT marketplace_id,max(business_date) cutoff_date FROM core.asin_sales_traffic_daily GROUP BY marketplace_id
), ranked_listing AS (
    SELECT sc.marketplace_id,sc.seller_sku,sc.asin,
           row_number() OVER (PARTITION BY sc.marketplace_id,sc.asin ORDER BY
             CASE WHEN lower(COALESCE(sc.status,''))<>'inactive' THEN 0 ELSE 1 END,
             CASE WHEN COALESCE(sc.active,true) THEN 0 ELSE 1 END,
             sc.fetched_at DESC NULLS LAST,sc.open_date DESC NULLS LAST,sc.seller_sku) offer_rank
    FROM mart.seller_catalog sc WHERE sc.asin IS NOT NULL AND sc.asin<>''
), demand AS (
    SELECT a.marketplace_id,a.asin,
           COALESCE(sum(a.ordered_product_sales) FILTER (WHERE a.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date),0)::numeric(14,2) sales_t28,
           COALESCE(sum(a.units_ordered) FILTER (WHERE a.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date),0)::bigint units_t28,
           COALESCE(sum(a.ordered_product_sales) FILTER (WHERE a.business_date BETWEEN c.cutoff_date-55 AND c.cutoff_date-28),0)::numeric(14,2) sales_prior_t28
    FROM core.asin_sales_traffic_daily a JOIN cutoff c USING(marketplace_id)
    WHERE a.business_date BETWEEN c.cutoff_date-55 AND c.cutoff_date GROUP BY a.marketplace_id,a.asin
), parents AS (
    SELECT DISTINCT marketplace_id,parent_asin asin FROM core.asin_sales_traffic_daily
    WHERE parent_asin IS NOT NULL AND parent_asin<>'' AND parent_asin<>asin
), agg AS (
    SELECT r.marketplace_id,r.seller_sku,r.asin,
           CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(d.sales_t28,0) ELSE 0 END::numeric(14,2) sales_t28,
           CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(d.units_t28,0) ELSE 0 END::bigint units_t28,
           CASE WHEN r.offer_rank=1 AND p.asin IS NULL THEN COALESCE(d.sales_prior_t28,0) ELSE 0 END::numeric(14,2) sales_prior_t28
    FROM ranked_listing r LEFT JOIN demand d ON d.marketplace_id=r.marketplace_id AND d.asin=r.asin
    LEFT JOIN parents p ON p.marketplace_id=r.marketplace_id AND p.asin=r.asin
)
SELECT a.*,
       CASE WHEN sales_prior_t28>0 THEN round(100.0*(sales_t28-sales_prior_t28)/sales_prior_t28,1) WHEN sales_t28>0 THEN NULL ELSE 0::numeric END delta28_pct,
       CASE WHEN sales_t28>0 AND sales_prior_t28=0 THEN 'NEW'
            WHEN sales_prior_t28>0 AND sales_t28>=sales_prior_t28*1.20 THEN 'ACCELERATING'
            WHEN sales_prior_t28>0 AND sales_t28>=sales_prior_t28*1.05 THEN 'GROWING'
            WHEN sales_prior_t28>0 AND sales_t28<=sales_prior_t28*0.80 THEN 'DECLINING'
            WHEN sales_prior_t28>0 AND sales_t28<=sales_prior_t28*0.95 THEN 'COOLING' ELSE 'STABLE' END state
FROM agg a;

COMMENT ON VIEW mart.catalog_movers_t28 IS
'Reconciled child-ASIN movers assigned once to the canonical seller offer; no seller-SKU alias duplication.';