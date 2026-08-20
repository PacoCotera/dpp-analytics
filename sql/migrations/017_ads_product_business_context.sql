-- Product-level Amazon Ads context for Product Workspace and Catalog.
-- Advertising attribution stays distinct from independently reconciled seller sales.
-- In particular, total seller sales minus attributed_sales is NOT exact organic sales.

CREATE OR REPLACE VIEW mart.ads_product_business_daily AS
WITH ads_product AS (
    SELECT
        a.marketplace_id,
        p.business_date,
        nullif(p.advertised_sku, '') AS sku,
        nullif(p.advertised_asin, '') AS asin,
        count(DISTINCT p.account_id)::int AS advertiser_accounts,
        count(DISTINCT p.campaign_id)::int AS campaigns,
        sum(p.impressions)::bigint AS impressions,
        sum(p.clicks)::bigint AS clicks,
        sum(p.spend)::numeric(16,4) AS ad_spend,
        sum(p.attributed_sales)::numeric(16,4) AS attributed_sales,
        sum(p.purchases)::bigint AS attributed_purchases,
        sum(p.units)::bigint AS attributed_units,
        max(p.source_generated_at) AS ads_source_generated_at,
        max(p.ingested_at) AS ads_ingested_at,
        string_agg(DISTINCT nullif(p.attribution_method,''), ', ' ORDER BY nullif(p.attribution_method,'')) AS attribution_method,
        string_agg(DISTINCT nullif(p.attribution_window,''), ', ' ORDER BY nullif(p.attribution_window,'')) AS attribution_window
    FROM ads.daily_advertised_product p
    JOIN ads.account a USING (account_id)
    WHERE a.marketplace_id IS NOT NULL
      AND (nullif(p.advertised_sku, '') IS NOT NULL OR nullif(p.advertised_asin, '') IS NOT NULL)
    GROUP BY a.marketplace_id, p.business_date, nullif(p.advertised_sku, ''), nullif(p.advertised_asin, '')
), latest AS (
    SELECT marketplace_id, max(business_date) AS ads_through_date
    FROM ads_product
    GROUP BY marketplace_id
), seller_product AS (
    -- Data Kiosk SKU sales/traffic rows are the reconciled seller-business source at
    -- product/day grain. Do not use mart.sku_daily here: that view is order-derived,
    -- exposes seller_sku rather than sku, and has no reconciled-report state.
    SELECT
        marketplace_id,
        business_date,
        seller_sku AS sku,
        max(asin) AS asin,
        COALESCE(sum(ordered_product_sales), 0)::numeric(16,4) AS total_business_sales,
        COALESCE(sum(total_order_items), 0)::bigint AS total_business_orders,
        COALESCE(sum(units_ordered), 0)::bigint AS total_business_units
    FROM core.sku_sales_traffic_daily
    GROUP BY marketplace_id, business_date, seller_sku
)
SELECT
    p.marketplace_id,
    p.business_date,
    p.sku,
    p.asin,
    p.advertiser_accounts,
    p.campaigns,
    p.impressions,
    p.clicks,
    p.ad_spend,
    p.attributed_sales,
    p.attributed_purchases,
    p.attributed_units,
    s.total_business_sales,
    s.total_business_orders,
    s.total_business_units,
    CASE WHEN p.impressions > 0 THEN p.clicks::numeric / p.impressions END AS ctr,
    CASE WHEN p.clicks > 0 THEN p.ad_spend / p.clicks END AS cpc,
    CASE WHEN p.ad_spend > 0 THEN p.attributed_sales / p.ad_spend END AS roas,
    CASE WHEN p.attributed_sales > 0 THEN p.ad_spend / p.attributed_sales END AS acos,
    CASE WHEN s.total_business_sales > 0 THEN p.ad_spend / s.total_business_sales END AS tacos,
    CASE WHEN s.total_business_sales > 0 THEN p.attributed_sales / s.total_business_sales END AS attributed_sales_share,
    p.attribution_method,
    p.attribution_window,
    p.ads_source_generated_at,
    p.ads_ingested_at,
    l.ads_through_date,
    (p.business_date <= l.ads_through_date - 7) AS attribution_mature,
    CASE WHEN p.business_date <= l.ads_through_date - 7 THEN 'MATURE' ELSE 'PROVISIONAL' END AS attribution_state
FROM ads_product p
JOIN latest l USING (marketplace_id)
LEFT JOIN seller_product s
  ON s.marketplace_id = p.marketplace_id
 AND s.business_date = p.business_date
 AND (s.sku = p.sku OR (p.sku IS NULL AND s.asin = p.asin));

COMMENT ON VIEW mart.ads_product_business_daily IS
'Product-level Amazon Ads attributed performance aligned to independent reconciled seller sales. TACOS uses total product business sales. attributed_sales is an Amazon attribution measure and MUST NOT be subtracted from total sales or labeled organic/incremental sales.';

CREATE OR REPLACE VIEW mart.ads_product_business_t28 AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS through_date
    FROM mart.ads_product_business_daily
    GROUP BY marketplace_id
)
SELECT
    d.marketplace_id,
    d.sku,
    d.asin,
    c.through_date,
    (c.through_date - 27) AS period_start,
    sum(d.ad_spend)::numeric(16,4) AS spend,
    sum(d.attributed_sales)::numeric(16,4) AS attributed_sales,
    sum(d.impressions)::bigint AS impressions,
    sum(d.clicks)::bigint AS clicks,
    sum(d.attributed_purchases)::bigint AS attributed_purchases,
    sum(d.attributed_units)::bigint AS attributed_units,
    sum(d.total_business_sales)::numeric(16,4) AS total_business_sales,
    sum(d.total_business_orders)::bigint AS total_business_orders,
    sum(d.total_business_units)::bigint AS total_business_units,
    CASE WHEN sum(d.impressions) > 0 THEN sum(d.clicks)::numeric / sum(d.impressions) END AS ctr,
    CASE WHEN sum(d.clicks) > 0 THEN sum(d.ad_spend) / sum(d.clicks) END AS cpc,
    CASE WHEN sum(d.ad_spend) > 0 THEN sum(d.attributed_sales) / sum(d.ad_spend) END AS roas,
    CASE WHEN sum(d.attributed_sales) > 0 THEN sum(d.ad_spend) / sum(d.attributed_sales) END AS acos,
    CASE WHEN sum(d.total_business_sales) > 0 THEN sum(d.ad_spend) / sum(d.total_business_sales) END AS tacos,
    CASE WHEN sum(d.total_business_sales) > 0 THEN sum(d.attributed_sales) / sum(d.total_business_sales) END AS attributed_sales_share,
    count(DISTINCT d.business_date)::int AS observed_ads_days,
    count(DISTINCT d.business_date) FILTER (WHERE d.attribution_mature)::int AS mature_ads_days,
    max(d.ads_source_generated_at) AS ads_source_generated_at,
    max(d.ads_ingested_at) AS ads_ingested_at
FROM mart.ads_product_business_daily d
JOIN cutoff c USING (marketplace_id)
WHERE d.business_date BETWEEN c.through_date - 27 AND c.through_date
GROUP BY d.marketplace_id, d.sku, d.asin, c.through_date;

COMMENT ON VIEW mart.ads_product_business_t28 IS
'Canonical product-level 28-day Ads context for Product Workspace and Catalog. Use attribution maturity metadata in UI; do not imply attributed sales are incremental or that the residual is exact organic sales.';