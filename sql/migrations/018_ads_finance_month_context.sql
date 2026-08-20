-- Accounting-period Amazon Ads context for Finance.
-- Finance is month/state based, never a rolling-window interpretation.
--
-- Two advertising bases are kept side by side:
--   1. Ads API accrual (preferred for future closes once complete/mature).
--   2. Following-calendar-month RELEASED ProductAdsPayment bridge.
--
-- Existing immutable finance closes are never changed by this view. Historical
-- replacement of the bridge with Ads API accrual requires an explicit RESTATED
-- core.finance_month_close version with audit reason.

CREATE OR REPLACE VIEW mart.ads_finance_month_context AS
WITH months AS (
    SELECT DISTINCT
        marketplace_id,
        date_trunc('month', business_date)::date AS month
    FROM mart.business_daily
    WHERE reconciled_daily_report
),
ads_month AS (
    SELECT
        a.marketplace_id,
        date_trunc('month', d.business_date)::date AS month,
        count(DISTINCT d.business_date)::int AS observed_ads_days,
        count(DISTINCT d.account_id)::int AS advertiser_accounts,
        sum(d.spend)::numeric(16,2) AS ads_api_accrual,
        sum(d.attributed_sales)::numeric(16,2) AS attributed_sales,
        sum(d.impressions)::bigint AS impressions,
        sum(d.clicks)::bigint AS clicks,
        sum(d.purchases)::bigint AS attributed_purchases,
        sum(d.units)::bigint AS attributed_units,
        max(d.business_date) AS ads_last_business_date,
        max(d.source_generated_at) AS ads_source_generated_at,
        max(d.ingested_at) AS ads_ingested_at,
        string_agg(DISTINCT nullif(d.attribution_method,''), ', ' ORDER BY nullif(d.attribution_method,'')) AS attribution_method,
        string_agg(DISTINCT nullif(d.attribution_window,''), ', ' ORDER BY nullif(d.attribution_window,'')) AS attribution_window
    FROM ads.daily_account d
    JOIN ads.account a USING (account_id)
    WHERE a.marketplace_id IS NOT NULL
    GROUP BY a.marketplace_id, date_trunc('month', d.business_date)::date
),
ads_latest AS (
    SELECT a.marketplace_id, max(d.business_date) AS ads_through_date
    FROM ads.daily_account d
    JOIN ads.account a USING (account_id)
    WHERE a.marketplace_id IS NOT NULL
    GROUP BY a.marketplace_id
),
bridge AS (
    SELECT
        marketplace_id,
        (date_trunc('month', posted_date AT TIME ZONE 'America/Mexico_City') - interval '1 month')::date AS month,
        count(*)::int AS bridge_events,
        sum(total_amount)::numeric(16,2) AS bridge_amount,
        min(posted_date) AS bridge_first_posted_at,
        max(posted_date) AS bridge_last_posted_at
    FROM core.financial_transaction
    WHERE transaction_status = 'RELEASED'
      AND transaction_type = 'ProductAdsPayment'
    GROUP BY marketplace_id,
             (date_trunc('month', posted_date AT TIME ZONE 'America/Mexico_City') - interval '1 month')::date
),
closed AS (
    SELECT marketplace_id, month, version, state, advertising, close_basis, closed_at
    FROM mart.finance_month_close_latest
)
SELECT
    m.marketplace_id,
    m.month,
    (m.month + interval '1 month - 1 day')::date AS month_end,
    extract(day FROM (m.month + interval '1 month - 1 day'))::int AS expected_ads_days,
    COALESCE(a.observed_ads_days, 0) AS observed_ads_days,
    GREATEST(
        extract(day FROM (m.month + interval '1 month - 1 day'))::int - COALESCE(a.observed_ads_days, 0),
        0
    )::int AS missing_ads_days,
    COALESCE(a.advertiser_accounts, 0) AS advertiser_accounts,
    a.ads_api_accrual,
    a.attributed_sales,
    a.impressions,
    a.clicks,
    a.attributed_purchases,
    a.attributed_units,
    CASE WHEN a.impressions > 0 THEN a.clicks::numeric / a.impressions END AS ctr,
    CASE WHEN a.clicks > 0 THEN a.ads_api_accrual / a.clicks END AS cpc,
    CASE WHEN a.ads_api_accrual > 0 THEN a.attributed_sales / a.ads_api_accrual END AS roas,
    CASE WHEN a.attributed_sales > 0 THEN a.ads_api_accrual / a.attributed_sales END AS acos,
    a.attribution_method,
    a.attribution_window,
    a.ads_last_business_date,
    l.ads_through_date,
    a.ads_source_generated_at,
    a.ads_ingested_at,
    (
      COALESCE(a.observed_ads_days, 0) = extract(day FROM (m.month + interval '1 month - 1 day'))::int
    ) AS ads_calendar_complete,
    (
      l.ads_through_date >= (m.month + interval '1 month - 1 day')::date + 7
    ) AS ads_attribution_mature,
    COALESCE(b.bridge_events, 0) AS bridge_events,
    b.bridge_amount AS product_ads_payment_bridge,
    b.bridge_first_posted_at,
    b.bridge_last_posted_at,
    CASE
      WHEN COALESCE(a.observed_ads_days, 0) = extract(day FROM (m.month + interval '1 month - 1 day'))::int
       AND l.ads_through_date >= (m.month + interval '1 month - 1 day')::date + 7
        THEN 'ADS_API_ACCRUAL_READY'
      WHEN COALESCE(b.bridge_events, 0) > 0
        THEN 'PRODUCT_ADS_PAYMENT_BRIDGE_READY'
      ELSE 'PENDING'
    END AS advertising_close_state,
    CASE
      WHEN COALESCE(a.observed_ads_days, 0) = extract(day FROM (m.month + interval '1 month - 1 day'))::int
       AND l.ads_through_date >= (m.month + interval '1 month - 1 day')::date + 7
        THEN a.ads_api_accrual
      WHEN COALESCE(b.bridge_events, 0) > 0
        THEN b.bridge_amount
      ELSE NULL
    END AS candidate_advertising_amount,
    CASE
      WHEN COALESCE(a.observed_ads_days, 0) = extract(day FROM (m.month + interval '1 month - 1 day'))::int
       AND l.ads_through_date >= (m.month + interval '1 month - 1 day')::date + 7
        THEN 'amazon_ads_api_accrual'
      WHEN COALESCE(b.bridge_events, 0) > 0
        THEN 'following_calendar_month_ProductAdsPayment_bridge'
      ELSE NULL
    END AS candidate_advertising_source,
    c.version AS closed_version,
    c.state AS management_close_state,
    c.advertising AS immutable_closed_advertising,
    c.close_basis AS immutable_close_basis,
    c.closed_at,
    CASE
      WHEN c.version IS NOT NULL
       AND c.close_basis->>'advertising_source' = 'following_calendar_month_ProductAdsPayment_bridge'
       AND COALESCE(a.observed_ads_days, 0) = extract(day FROM (m.month + interval '1 month - 1 day'))::int
       AND l.ads_through_date >= (m.month + interval '1 month - 1 day')::date + 7
        THEN true
      ELSE false
    END AS ads_api_restatement_available
FROM months m
LEFT JOIN ads_month a
  ON a.marketplace_id = m.marketplace_id AND a.month = m.month
LEFT JOIN ads_latest l
  ON l.marketplace_id = m.marketplace_id
LEFT JOIN bridge b
  ON b.marketplace_id = m.marketplace_id AND b.month = m.month
LEFT JOIN closed c
  ON c.marketplace_id = m.marketplace_id AND c.month = m.month;

COMMENT ON VIEW mart.ads_finance_month_context IS
'Finance-only monthly advertising reconciliation. Shows Ads API accrual readiness and the temporary following-month RELEASED ProductAdsPayment bridge side by side. Closed management months remain immutable; ads_api_restatement_available is advisory only and requires an explicit RESTATED close version. Never use rolling T28 advertising context for accounting close.';
