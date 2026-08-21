-- Canonical Amazon Ads ingestion-quality contract.
--
-- Live Ads reporting arrives through independent report grains. Before those facts
-- are allowed to drive commercial interpretation, make disagreements visible at
-- account/day grain instead of silently trusting whichever report a UI happens to
-- read. This view is intentionally useful before credentials exist (it is empty)
-- and becomes a control-plane contract as soon as backfill starts.

CREATE OR REPLACE VIEW mart.ads_ingestion_quality AS
WITH campaign AS (
    SELECT
        account_id,
        business_date,
        sum(impressions)::bigint AS impressions,
        sum(clicks)::bigint AS clicks,
        sum(spend)::numeric(18,4) AS spend,
        sum(attributed_sales)::numeric(18,4) AS attributed_sales,
        sum(purchases)::bigint AS purchases,
        sum(units)::bigint AS units,
        max(ingested_at) AS ingested_at
    FROM ads.daily_campaign
    GROUP BY account_id, business_date
),
product AS (
    SELECT
        account_id,
        business_date,
        sum(impressions)::bigint AS impressions,
        sum(clicks)::bigint AS clicks,
        sum(spend)::numeric(18,4) AS spend,
        sum(attributed_sales)::numeric(18,4) AS attributed_sales,
        sum(purchases)::bigint AS purchases,
        sum(units)::bigint AS units,
        max(ingested_at) AS ingested_at
    FROM ads.daily_advertised_product
    GROUP BY account_id, business_date
),
business AS (
    SELECT
        marketplace_id,
        business_date,
        sum(sales)::numeric(18,4) AS seller_sales
    FROM mart.business_daily
    WHERE reconciled_daily_report
    GROUP BY marketplace_id, business_date
)
SELECT
    a.marketplace_id,
    d.account_id,
    d.business_date,
    a.currency,
    d.attribution_method,
    d.attribution_window,
    d.impressions AS account_impressions,
    c.impressions AS campaign_impressions,
    p.impressions AS product_impressions,
    d.clicks AS account_clicks,
    c.clicks AS campaign_clicks,
    p.clicks AS product_clicks,
    d.spend AS account_spend,
    c.spend AS campaign_spend,
    p.spend AS product_spend,
    d.attributed_sales AS account_attributed_sales,
    c.attributed_sales AS campaign_attributed_sales,
    p.attributed_sales AS product_attributed_sales,
    b.seller_sales,
    (b.seller_sales IS NOT NULL) AS seller_sales_denominator_present,
    (d.currency IS NOT DISTINCT FROM a.currency) AS account_currency_matches,
    (c.account_id IS NOT NULL) AS campaign_grain_present,
    (p.account_id IS NOT NULL) AS product_grain_present,
    (
        c.account_id IS NOT NULL
        AND d.impressions = c.impressions
        AND d.clicks = c.clicks
        AND abs(d.spend - c.spend) <= 0.01
        AND abs(d.attributed_sales - c.attributed_sales) <= 0.01
        AND d.purchases = c.purchases
        AND d.units = c.units
    ) AS account_campaign_reconciled,
    (
        p.account_id IS NOT NULL
        AND abs(d.spend - p.spend) <= 0.01
        AND abs(d.attributed_sales - p.attributed_sales) <= 0.01
    ) AS account_product_value_reconciled,
    greatest(d.ingested_at, c.ingested_at, p.ingested_at) AS latest_ingested_at,
    CASE
        WHEN a.marketplace_id IS NULL THEN 'ACCOUNT_MARKETPLACE_MISSING'
        WHEN d.currency IS DISTINCT FROM a.currency THEN 'CURRENCY_MISMATCH'
        WHEN c.account_id IS NULL THEN 'CAMPAIGN_GRAIN_MISSING'
        WHEN p.account_id IS NULL THEN 'PRODUCT_GRAIN_MISSING'
        WHEN NOT (
            d.impressions = c.impressions
            AND d.clicks = c.clicks
            AND abs(d.spend - c.spend) <= 0.01
            AND abs(d.attributed_sales - c.attributed_sales) <= 0.01
            AND d.purchases = c.purchases
            AND d.units = c.units
        ) THEN 'ACCOUNT_CAMPAIGN_MISMATCH'
        WHEN NOT (
            abs(d.spend - p.spend) <= 0.01
            AND abs(d.attributed_sales - p.attributed_sales) <= 0.01
        ) THEN 'ACCOUNT_PRODUCT_VALUE_MISMATCH'
        WHEN b.seller_sales IS NULL THEN 'SELLER_SALES_DENOMINATOR_MISSING'
        ELSE 'OK'
    END AS quality_state
FROM ads.daily_account d
JOIN ads.account a USING (account_id)
LEFT JOIN campaign c USING (account_id, business_date)
LEFT JOIN product p USING (account_id, business_date)
LEFT JOIN business b
  ON b.marketplace_id = a.marketplace_id
 AND b.business_date = d.business_date;

COMMENT ON VIEW mart.ads_ingestion_quality IS
'Account/day Amazon Ads control contract. Reconciles account rollup to campaign and advertised-product report grains, validates account currency, and verifies the independent seller-sales denominator required for TACOS. Attributed sales remain Amazon attribution and are never interpreted as incremental sales.';

CREATE OR REPLACE VIEW mart.ads_ingestion_quality_summary AS
SELECT
    marketplace_id,
    account_id,
    min(business_date) AS first_date,
    max(business_date) AS latest_date,
    count(*)::int AS days_seen,
    count(*) FILTER (WHERE quality_state = 'OK')::int AS healthy_days,
    count(*) FILTER (WHERE quality_state <> 'OK')::int AS issue_days,
    max(latest_ingested_at) AS latest_ingested_at,
    CASE
        WHEN count(*) = 0 THEN 'NO_DATA'
        WHEN count(*) FILTER (WHERE quality_state <> 'OK') = 0 THEN 'HEALTHY'
        ELSE 'ATTENTION'
    END AS quality_state
FROM mart.ads_ingestion_quality
GROUP BY marketplace_id, account_id;

COMMENT ON VIEW mart.ads_ingestion_quality_summary IS
'Per-account Ads ingestion readiness summary for Data Health and operational alerting.';
