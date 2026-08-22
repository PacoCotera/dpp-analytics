-- Product Ads must use the populated canonical CHILD-ASIN Sales & Traffic source,
-- not core.sku_sales_traffic_daily (which is structurally present but not populated
-- in DPP production). Alias seller SKUs are collapsed onto the canonical commercial
-- offer owner before Ads metrics are aggregated.
--
-- T28 seller sales are summed independently across the full 28-day window. They are
-- NOT limited to dates on which the product happened to have an Ads row.

CREATE OR REPLACE VIEW mart.ads_product_business_daily AS
WITH raw_ads AS (
    SELECT a.marketplace_id,p.business_date,p.account_id,p.campaign_id,
           nullif(p.advertised_sku,'') AS raw_sku,nullif(p.advertised_asin,'') AS raw_asin,
           p.impressions,p.clicks,p.spend,p.attributed_sales,p.purchases,p.units,
           p.source_generated_at,p.ingested_at,p.attribution_method,p.attribution_window,
           ads.attribution_window_days(p.attribution_window) AS attribution_window_days
    FROM ads.daily_advertised_product p
    JOIN ads.account a USING(account_id)
    WHERE a.marketplace_id IS NOT NULL
      AND (nullif(p.advertised_sku,'') IS NOT NULL OR nullif(p.advertised_asin,'') IS NOT NULL)
), resolved AS (
    SELECT r.*,
           COALESCE(r.raw_asin,sl.asin,s.asin) AS resolved_asin
    FROM raw_ads r
    LEFT JOIN core.seller_listing sl
      ON sl.marketplace_id=r.marketplace_id AND sl.seller_sku=r.raw_sku
    LEFT JOIN core.sku s ON s.sku=r.raw_sku
), canonicalized AS (
    SELECT r.*,
           COALESCE(owner.seller_sku,r.raw_sku) AS sku,
           COALESCE(owner.asin,r.resolved_asin) AS asin
    FROM resolved r
    LEFT JOIN LATERAL (
      SELECT p.seller_sku,p.asin
      FROM mart.catalog_portfolio_product p
      WHERE p.marketplace_id=r.marketplace_id AND p.asin=r.resolved_asin AND p.is_offer_owner
      ORDER BY p.seller_sku LIMIT 1
    ) owner ON true
), ads_product AS (
    SELECT marketplace_id,business_date,sku,asin,
           count(DISTINCT account_id)::int AS advertiser_accounts,
           count(DISTINCT campaign_id)::int AS campaigns,
           sum(impressions)::bigint AS impressions,sum(clicks)::bigint AS clicks,
           sum(spend)::numeric(16,4) AS ad_spend,
           sum(attributed_sales)::numeric(16,4) AS attributed_sales,
           sum(purchases)::bigint AS attributed_purchases,sum(units)::bigint AS attributed_units,
           max(source_generated_at) AS ads_source_generated_at,max(ingested_at) AS ads_ingested_at,
           string_agg(DISTINCT nullif(attribution_method,''),', ' ORDER BY nullif(attribution_method,'')) AS attribution_method,
           string_agg(DISTINCT nullif(attribution_window,''),', ' ORDER BY nullif(attribution_window,'')) AS attribution_window,
           max(attribution_window_days) AS attribution_window_days,
           bool_and(attribution_window_days IS NOT NULL) AS attribution_window_known
    FROM canonicalized
    GROUP BY marketplace_id,business_date,sku,asin
), latest AS (
    SELECT marketplace_id,max(business_date) AS ads_through_date
    FROM ads_product GROUP BY marketplace_id
), seller_product AS (
    SELECT marketplace_id,business_date,asin,
           COALESCE(sum(ordered_product_sales),0)::numeric(16,4) AS total_business_sales,
           COALESCE(sum(total_order_items),0)::bigint AS total_business_orders,
           COALESCE(sum(units_ordered),0)::bigint AS total_business_units
    FROM core.asin_sales_traffic_daily
    GROUP BY marketplace_id,business_date,asin
)
SELECT p.marketplace_id,p.business_date,p.sku,p.asin,p.advertiser_accounts,p.campaigns,
       p.impressions,p.clicks,p.ad_spend,p.attributed_sales,p.attributed_purchases,p.attributed_units,
       s.total_business_sales,s.total_business_orders,s.total_business_units,
       CASE WHEN p.impressions>0 THEN p.clicks::numeric/p.impressions END AS ctr,
       CASE WHEN p.clicks>0 THEN p.ad_spend/p.clicks END AS cpc,
       CASE WHEN p.ad_spend>0 THEN p.attributed_sales/p.ad_spend END AS roas,
       CASE WHEN p.attributed_sales>0 THEN p.ad_spend/p.attributed_sales END AS acos,
       CASE WHEN s.total_business_sales>0 THEN p.ad_spend/s.total_business_sales END AS tacos,
       CASE WHEN s.total_business_sales>0 THEN p.attributed_sales/s.total_business_sales END AS attributed_sales_share,
       p.attribution_method,p.attribution_window,p.ads_source_generated_at,p.ads_ingested_at,l.ads_through_date,
       CASE WHEN p.attribution_window_known THEN p.business_date<=l.ads_through_date-p.attribution_window_days ELSE false END AS attribution_mature,
       CASE WHEN NOT p.attribution_window_known THEN 'UNKNOWN'
            WHEN p.business_date<=l.ads_through_date-p.attribution_window_days THEN 'MATURE' ELSE 'PROVISIONAL' END AS attribution_state,
       p.attribution_window_days,
       CASE WHEN p.attribution_window_known THEN l.ads_through_date-p.attribution_window_days END AS mature_through_date
FROM ads_product p
JOIN latest l USING(marketplace_id)
LEFT JOIN seller_product s
  ON s.marketplace_id=p.marketplace_id AND s.business_date=p.business_date AND s.asin=p.asin;

COMMENT ON VIEW mart.ads_product_business_daily IS
'Canonical product-level Ads context. Advertised SKU aliases collapse to the canonical offer owner. Independent seller sales come from populated CHILD-ASIN Sales & Traffic. Attributed sales are attribution, not incrementality.';

CREATE OR REPLACE VIEW mart.ads_product_business_t28 AS
WITH cutoff AS (
    SELECT marketplace_id,max(business_date) AS through_date
    FROM mart.ads_product_business_daily GROUP BY marketplace_id
), ads_agg AS (
    SELECT d.marketplace_id,d.sku,d.asin,c.through_date,
           sum(d.ad_spend)::numeric(16,4) AS spend,
           sum(d.attributed_sales)::numeric(16,4) AS attributed_sales,
           sum(d.impressions)::bigint AS impressions,sum(d.clicks)::bigint AS clicks,
           sum(d.attributed_purchases)::bigint AS attributed_purchases,
           sum(d.attributed_units)::bigint AS attributed_units,
           count(DISTINCT d.business_date)::int AS observed_ads_days,
           count(DISTINCT d.business_date) FILTER (WHERE d.attribution_mature)::int AS mature_ads_days,
           max(d.ads_source_generated_at) AS ads_source_generated_at,max(d.ads_ingested_at) AS ads_ingested_at
    FROM mart.ads_product_business_daily d JOIN cutoff c USING(marketplace_id)
    WHERE d.business_date BETWEEN c.through_date-27 AND c.through_date
    GROUP BY d.marketplace_id,d.sku,d.asin,c.through_date
), seller_t28 AS (
    SELECT a.marketplace_id,a.sku,a.asin,a.through_date,
           COALESCE(sum(s.ordered_product_sales),0)::numeric(16,4) AS total_business_sales,
           COALESCE(sum(s.total_order_items),0)::bigint AS total_business_orders,
           COALESCE(sum(s.units_ordered),0)::bigint AS total_business_units
    FROM ads_agg a
    LEFT JOIN core.asin_sales_traffic_daily s
      ON s.marketplace_id=a.marketplace_id AND s.asin=a.asin
     AND s.business_date BETWEEN a.through_date-27 AND a.through_date
    GROUP BY a.marketplace_id,a.sku,a.asin,a.through_date
)
SELECT a.marketplace_id,a.sku,a.asin,a.through_date,(a.through_date-27) AS period_start,
       a.spend,a.attributed_sales,a.impressions,a.clicks,a.attributed_purchases,a.attributed_units,
       s.total_business_sales,s.total_business_orders,s.total_business_units,
       CASE WHEN a.impressions>0 THEN a.clicks::numeric/a.impressions END AS ctr,
       CASE WHEN a.clicks>0 THEN a.spend/a.clicks END AS cpc,
       CASE WHEN a.spend>0 THEN a.attributed_sales/a.spend END AS roas,
       CASE WHEN a.attributed_sales>0 THEN a.spend/a.attributed_sales END AS acos,
       CASE WHEN s.total_business_sales>0 THEN a.spend/s.total_business_sales END AS tacos,
       CASE WHEN s.total_business_sales>0 THEN a.attributed_sales/s.total_business_sales END AS attributed_sales_share,
       a.observed_ads_days,a.mature_ads_days,a.ads_source_generated_at,a.ads_ingested_at
FROM ads_agg a
JOIN seller_t28 s USING(marketplace_id,sku,asin,through_date);

COMMENT ON VIEW mart.ads_product_business_t28 IS
'Canonical product 28-day Ads context. Seller-sales denominator covers the full 28-day window from CHILD-ASIN Sales & Traffic, independent of Ads-row sparsity. Alias SKUs are collapsed to canonical offer owners.';
