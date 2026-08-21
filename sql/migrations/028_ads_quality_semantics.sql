-- Correct the Ads quality contract so the operating trust gate is based on
-- independent Amazon report grains, not on a derived rollup checking itself.
--
-- ads.daily_account is intentionally rebuilt from ads.daily_campaign by the
-- ingestion worker. Account-vs-campaign equality is therefore an internal
-- rollup invariant, useful diagnostically but not evidence that Amazon supplied
-- two independently agreeing reports. Campaign and advertised-product reports
-- are requested separately and are the independent commercial reconciliation.

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
        min(attribution_method) AS attribution_method,
        min(attribution_window) AS attribution_window,
        count(DISTINCT attribution_method)::int AS attribution_method_count,
        count(DISTINCT attribution_window)::int AS attribution_window_count,
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
        min(attribution_method) AS attribution_method,
        min(attribution_window) AS attribution_window,
        count(DISTINCT attribution_method)::int AS attribution_method_count,
        count(DISTINCT attribution_window)::int AS attribution_window_count,
        max(ingested_at) AS ingested_at
    FROM ads.daily_advertised_product
    GROUP BY account_id, business_date
),
business AS (
    SELECT marketplace_id, business_date,
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
    ) AS account_rollup_consistent,
    (
        c.account_id IS NOT NULL AND p.account_id IS NOT NULL
        AND abs(c.spend - p.spend) <= 0.01
        AND abs(c.attributed_sales - p.attributed_sales) <= 0.01
    ) AS independent_value_reconciled,
    (
        c.account_id IS NOT NULL AND p.account_id IS NOT NULL
        AND c.attribution_method_count = 1
        AND c.attribution_window_count = 1
        AND p.attribution_method_count = 1
        AND p.attribution_window_count = 1
        AND c.attribution_method IS NOT DISTINCT FROM p.attribution_method
        AND c.attribution_window IS NOT DISTINCT FROM p.attribution_window
        AND d.attribution_method IS NOT DISTINCT FROM c.attribution_method
        AND d.attribution_window IS NOT DISTINCT FROM c.attribution_window
    ) AS attribution_contract_consistent,
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
        ) THEN 'ACCOUNT_ROLLUP_INCONSISTENT'
        WHEN NOT (
            abs(c.spend - p.spend) <= 0.01
            AND abs(c.attributed_sales - p.attributed_sales) <= 0.01
        ) THEN 'INDEPENDENT_REPORT_VALUE_MISMATCH'
        WHEN NOT (
            c.attribution_method_count = 1
            AND c.attribution_window_count = 1
            AND p.attribution_method_count = 1
            AND p.attribution_window_count = 1
            AND c.attribution_method IS NOT DISTINCT FROM p.attribution_method
            AND c.attribution_window IS NOT DISTINCT FROM p.attribution_window
            AND d.attribution_method IS NOT DISTINCT FROM c.attribution_method
            AND d.attribution_window IS NOT DISTINCT FROM c.attribution_window
        ) THEN 'ATTRIBUTION_CONTRACT_MISMATCH'
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
'Account/day Amazon Ads control contract. daily_account is a derived campaign rollup, so account_rollup_consistent is only an internal invariant. Operating trust is additionally gated by independent campaign-vs-advertised-product value reconciliation, a consistent attribution contract, account currency, and the independent seller-sales denominator required for TACOS. Attributed sales are Amazon attribution, never incremental sales.';

CREATE OR REPLACE VIEW mart.ads_ingestion_quality_summary AS
SELECT
    marketplace_id,
    account_id,
    min(business_date) AS first_date,
    max(business_date) AS latest_date,
    count(*)::int AS days_seen,
    count(*) FILTER (WHERE quality_state = 'OK')::int AS healthy_days,
    count(*) FILTER (WHERE quality_state <> 'OK')::int AS issue_days,
    count(*) FILTER (WHERE quality_state = 'ACCOUNT_ROLLUP_INCONSISTENT')::int AS rollup_issue_days,
    count(*) FILTER (WHERE quality_state = 'INDEPENDENT_REPORT_VALUE_MISMATCH')::int AS independent_report_issue_days,
    count(*) FILTER (WHERE quality_state = 'ATTRIBUTION_CONTRACT_MISMATCH')::int AS attribution_contract_issue_days,
    max(latest_ingested_at) AS latest_ingested_at,
    CASE
        WHEN count(*) = 0 THEN 'NO_DATA'
        WHEN count(*) FILTER (WHERE quality_state <> 'OK') = 0 THEN 'HEALTHY'
        ELSE 'ATTENTION'
    END AS quality_state
FROM mart.ads_ingestion_quality
GROUP BY marketplace_id, account_id;

COMMENT ON VIEW mart.ads_ingestion_quality_summary IS
'Per-account Ads ingestion readiness summary. HEALTHY means independent campaign and advertised-product reports reconcile for commercial values, attribution semantics agree, account rollup is internally consistent, currency is valid, and TACOS has seller-sales coverage.';
