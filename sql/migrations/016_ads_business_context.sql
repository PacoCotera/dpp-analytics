-- Business-context layer for Amazon Ads.
-- Keeps attributed advertising facts separate from independent seller sales and
-- gives every consuming surface one consistent TACOS / attribution-maturity basis.
-- Multi-account and multi-marketplace ready; DPP Mexico is simply the first market.

CREATE OR REPLACE VIEW mart.ads_business_daily AS
WITH ads_day AS (
    SELECT
        a.marketplace_id,
        d.business_date,
        count(DISTINCT d.account_id)::int AS advertiser_accounts,
        sum(d.impressions)::bigint AS impressions,
        sum(d.clicks)::bigint AS clicks,
        sum(d.spend)::numeric(16,4) AS ad_spend,
        sum(d.attributed_sales)::numeric(16,4) AS attributed_sales,
        sum(d.purchases)::bigint AS attributed_purchases,
        sum(d.units)::bigint AS attributed_units,
        max(d.source_generated_at) AS ads_source_generated_at,
        max(d.ingested_at) AS ads_ingested_at,
        string_agg(DISTINCT nullif(d.attribution_method,''), ', ' ORDER BY nullif(d.attribution_method,'')) AS attribution_method,
        string_agg(DISTINCT nullif(d.attribution_window,''), ', ' ORDER BY nullif(d.attribution_window,'')) AS attribution_window
    FROM ads.daily_account d
    JOIN ads.account a USING (account_id)
    WHERE a.marketplace_id IS NOT NULL
    GROUP BY a.marketplace_id, d.business_date
), latest AS (
    SELECT marketplace_id, max(business_date) AS ads_through_date
    FROM ads_day
    GROUP BY marketplace_id
)
SELECT
    ad.marketplace_id,
    ad.business_date,
    ad.advertiser_accounts,
    ad.impressions,
    ad.clicks,
    ad.ad_spend,
    ad.attributed_sales,
    ad.attributed_purchases,
    ad.attributed_units,
    b.sales::numeric(16,4) AS total_business_sales,
    b.orders::bigint AS total_business_orders,
    b.units::bigint AS total_business_units,
    CASE WHEN ad.impressions > 0 THEN ad.clicks::numeric / ad.impressions END AS ctr,
    CASE WHEN ad.clicks > 0 THEN ad.ad_spend / ad.clicks END AS cpc,
    CASE WHEN ad.ad_spend > 0 THEN ad.attributed_sales / ad.ad_spend END AS roas,
    CASE WHEN ad.attributed_sales > 0 THEN ad.ad_spend / ad.attributed_sales END AS acos,
    CASE WHEN b.sales > 0 THEN ad.ad_spend / b.sales END AS tacos,
    CASE WHEN b.sales > 0 THEN ad.attributed_sales / b.sales END AS attributed_sales_share,
    ad.attribution_method,
    ad.attribution_window,
    ad.ads_source_generated_at,
    ad.ads_ingested_at,
    l.ads_through_date,
    (ad.business_date <= l.ads_through_date - 7) AS attribution_mature,
    CASE
        WHEN ad.business_date <= l.ads_through_date - 7 THEN 'MATURE'
        ELSE 'PROVISIONAL'
    END AS attribution_state
FROM ads_day ad
JOIN latest l USING (marketplace_id)
LEFT JOIN mart.business_daily b
  ON b.marketplace_id = ad.marketplace_id
 AND b.business_date = ad.business_date
 AND b.reconciled_daily_report;

COMMENT ON VIEW mart.ads_business_daily IS
'Amazon Ads daily facts aligned to independent reconciled seller sales. TACOS uses total business sales. attributed_sales is Amazon-attributed advertising sales and MUST NOT be subtracted from total sales or presented as exact organic/incremental sales. Latest seven Ads dates are provisional under the current seller click attribution window.';

CREATE OR REPLACE VIEW mart.ads_business_t28 AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS through_date
    FROM mart.ads_business_daily
    GROUP BY marketplace_id
), current_period AS (
    SELECT
        d.marketplace_id,
        c.through_date,
        sum(d.ad_spend)::numeric(16,4) AS spend,
        sum(d.attributed_sales)::numeric(16,4) AS attributed_sales,
        sum(d.impressions)::bigint AS impressions,
        sum(d.clicks)::bigint AS clicks,
        sum(d.attributed_purchases)::bigint AS attributed_purchases,
        sum(d.attributed_units)::bigint AS attributed_units,
        sum(d.total_business_sales)::numeric(16,4) AS total_business_sales,
        count(*)::int AS observed_ads_days,
        count(*) FILTER (WHERE d.attribution_mature)::int AS mature_ads_days,
        max(d.ads_source_generated_at) AS ads_source_generated_at,
        max(d.ads_ingested_at) AS ads_ingested_at
    FROM mart.ads_business_daily d
    JOIN cutoff c USING (marketplace_id)
    WHERE d.business_date BETWEEN c.through_date - 27 AND c.through_date
    GROUP BY d.marketplace_id, c.through_date
), prior_period AS (
    SELECT
        d.marketplace_id,
        c.through_date,
        sum(d.ad_spend)::numeric(16,4) AS spend,
        sum(d.attributed_sales)::numeric(16,4) AS attributed_sales,
        sum(d.total_business_sales)::numeric(16,4) AS total_business_sales
    FROM mart.ads_business_daily d
    JOIN cutoff c USING (marketplace_id)
    WHERE d.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
    GROUP BY d.marketplace_id, c.through_date
)
SELECT
    p.marketplace_id,
    p.through_date,
    (p.through_date - 27) AS period_start,
    p.spend,
    p.attributed_sales,
    p.impressions,
    p.clicks,
    p.attributed_purchases,
    p.attributed_units,
    p.total_business_sales,
    CASE WHEN p.impressions > 0 THEN p.clicks::numeric / p.impressions END AS ctr,
    CASE WHEN p.clicks > 0 THEN p.spend / p.clicks END AS cpc,
    CASE WHEN p.spend > 0 THEN p.attributed_sales / p.spend END AS roas,
    CASE WHEN p.attributed_sales > 0 THEN p.spend / p.attributed_sales END AS acos,
    CASE WHEN p.total_business_sales > 0 THEN p.spend / p.total_business_sales END AS tacos,
    CASE WHEN p.total_business_sales > 0 THEN p.attributed_sales / p.total_business_sales END AS attributed_sales_share,
    p.observed_ads_days,
    28::int AS expected_ads_days,
    (28 - p.observed_ads_days)::int AS missing_ads_days,
    p.mature_ads_days,
    p.ads_source_generated_at,
    p.ads_ingested_at,
    q.spend AS prior_spend,
    q.attributed_sales AS prior_attributed_sales,
    q.total_business_sales AS prior_total_business_sales,
    CASE WHEN q.spend > 0 THEN 100 * (p.spend - q.spend) / q.spend END AS spend_delta_pct,
    CASE WHEN q.attributed_sales > 0 THEN 100 * (p.attributed_sales - q.attributed_sales) / q.attributed_sales END AS attributed_sales_delta_pct,
    CASE WHEN q.total_business_sales > 0 AND p.total_business_sales > 0
         THEN 100 * ((p.spend / p.total_business_sales) - (q.spend / q.total_business_sales)) END AS tacos_delta_points
FROM current_period p
LEFT JOIN prior_period q
  ON q.marketplace_id = p.marketplace_id
 AND q.through_date = p.through_date;

COMMENT ON VIEW mart.ads_business_t28 IS
'Canonical 28-day Amazon Ads operating context for Home, Sales, Catalog, Product and Trajectory. Finance remains accounting-period based and must not use this rolling view for month close.';
