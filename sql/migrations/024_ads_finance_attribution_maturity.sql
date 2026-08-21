-- Finance must use the same explicit Ads attribution contract as operating marts.
-- Do not assume every ad product/account has a seven-day conversion window.

CREATE OR REPLACE VIEW mart.ads_finance_month_context AS
WITH months AS (
    SELECT DISTINCT marketplace_id,date_trunc('month',business_date)::date AS month
    FROM mart.business_daily WHERE reconciled_daily_report
), ads_month AS (
    SELECT a.marketplace_id,date_trunc('month',d.business_date)::date AS month,
           count(DISTINCT d.business_date)::int AS observed_ads_days,
           count(DISTINCT d.account_id)::int AS advertiser_accounts,
           sum(d.spend)::numeric(16,2) AS ads_api_accrual,
           sum(d.attributed_sales)::numeric(16,2) AS attributed_sales,
           sum(d.impressions)::bigint AS impressions,sum(d.clicks)::bigint AS clicks,
           sum(d.purchases)::bigint AS attributed_purchases,sum(d.units)::bigint AS attributed_units,
           max(d.business_date) AS ads_last_business_date,
           max(d.source_generated_at) AS ads_source_generated_at,max(d.ingested_at) AS ads_ingested_at,
           string_agg(DISTINCT nullif(d.attribution_method,''),', ' ORDER BY nullif(d.attribution_method,'')) AS attribution_method,
           string_agg(DISTINCT nullif(d.attribution_window,''),', ' ORDER BY nullif(d.attribution_window,'')) AS attribution_window,
           max(ads.attribution_window_days(d.attribution_window)) AS attribution_window_days,
           bool_and(ads.attribution_window_days(d.attribution_window) IS NOT NULL) AS attribution_window_known
    FROM ads.daily_account d JOIN ads.account a USING(account_id)
    WHERE a.marketplace_id IS NOT NULL
    GROUP BY a.marketplace_id,date_trunc('month',d.business_date)::date
), ads_latest AS (
    SELECT a.marketplace_id,max(d.business_date) AS ads_through_date
    FROM ads.daily_account d JOIN ads.account a USING(account_id)
    WHERE a.marketplace_id IS NOT NULL GROUP BY a.marketplace_id
), bridge AS (
    SELECT marketplace_id,
           (date_trunc('month',posted_date AT TIME ZONE 'America/Mexico_City')-interval '1 month')::date AS month,
           count(*)::int AS bridge_events,sum(total_amount)::numeric(16,2) AS bridge_amount,
           min(posted_date) AS bridge_first_posted_at,max(posted_date) AS bridge_last_posted_at
    FROM core.financial_transaction
    WHERE transaction_status='RELEASED' AND transaction_type='ProductAdsPayment'
    GROUP BY marketplace_id,(date_trunc('month',posted_date AT TIME ZONE 'America/Mexico_City')-interval '1 month')::date
), closed AS (
    SELECT marketplace_id,month,version,state,advertising,close_basis,closed_at
    FROM mart.finance_month_close_latest
), readiness AS (
    SELECT m.*,a.observed_ads_days,a.advertiser_accounts,a.ads_api_accrual,a.attributed_sales,a.impressions,a.clicks,
           a.attributed_purchases,a.attributed_units,a.attribution_method,a.attribution_window,a.attribution_window_days,
           a.attribution_window_known,a.ads_last_business_date,l.ads_through_date,a.ads_source_generated_at,a.ads_ingested_at,
           extract(day FROM (m.month+interval '1 month - 1 day'))::int AS expected_ads_days,
           (m.month+interval '1 month - 1 day')::date AS month_end,
           (COALESCE(a.observed_ads_days,0)=extract(day FROM (m.month+interval '1 month - 1 day'))::int) AS ads_calendar_complete,
           CASE WHEN a.attribution_window_known
                THEN l.ads_through_date >= (m.month+interval '1 month - 1 day')::date + a.attribution_window_days
                ELSE false END AS ads_attribution_mature,
           b.bridge_events,b.bridge_amount,b.bridge_first_posted_at,b.bridge_last_posted_at,
           c.version,c.state,c.advertising,c.close_basis,c.closed_at
    FROM months m
    LEFT JOIN ads_month a ON a.marketplace_id=m.marketplace_id AND a.month=m.month
    LEFT JOIN ads_latest l ON l.marketplace_id=m.marketplace_id
    LEFT JOIN bridge b ON b.marketplace_id=m.marketplace_id AND b.month=m.month
    LEFT JOIN closed c ON c.marketplace_id=m.marketplace_id AND c.month=m.month
)
SELECT marketplace_id,month,month_end,expected_ads_days,COALESCE(observed_ads_days,0) AS observed_ads_days,
       GREATEST(expected_ads_days-COALESCE(observed_ads_days,0),0)::int AS missing_ads_days,
       COALESCE(advertiser_accounts,0) AS advertiser_accounts,ads_api_accrual,attributed_sales,impressions,clicks,
       attributed_purchases,attributed_units,
       CASE WHEN impressions>0 THEN clicks::numeric/impressions END AS ctr,
       CASE WHEN clicks>0 THEN ads_api_accrual/clicks END AS cpc,
       CASE WHEN ads_api_accrual>0 THEN attributed_sales/ads_api_accrual END AS roas,
       CASE WHEN attributed_sales>0 THEN ads_api_accrual/attributed_sales END AS acos,
       attribution_method,attribution_window,attribution_window_days,ads_last_business_date,ads_through_date,
       ads_source_generated_at,ads_ingested_at,ads_calendar_complete,ads_attribution_mature,
       CASE WHEN attribution_window_known THEN month_end+attribution_window_days END AS ads_mature_after_date,
       CASE WHEN attribution_window_known THEN CASE WHEN ads_attribution_mature THEN 'MATURE' ELSE 'PROVISIONAL' END ELSE 'UNKNOWN' END AS ads_attribution_state,
       COALESCE(bridge_events,0) AS bridge_events,bridge_amount AS product_ads_payment_bridge,
       bridge_first_posted_at,bridge_last_posted_at,
       CASE WHEN ads_calendar_complete AND ads_attribution_mature THEN 'ADS_API_ACCRUAL_READY'
            WHEN COALESCE(bridge_events,0)>0 THEN 'PRODUCT_ADS_PAYMENT_BRIDGE_READY' ELSE 'PENDING' END AS advertising_close_state,
       CASE WHEN ads_calendar_complete AND ads_attribution_mature THEN ads_api_accrual
            WHEN COALESCE(bridge_events,0)>0 THEN bridge_amount ELSE NULL END AS candidate_advertising_amount,
       CASE WHEN ads_calendar_complete AND ads_attribution_mature THEN 'amazon_ads_api_accrual'
            WHEN COALESCE(bridge_events,0)>0 THEN 'following_calendar_month_ProductAdsPayment_bridge' ELSE NULL END AS candidate_advertising_source,
       version AS closed_version,state AS management_close_state,advertising AS immutable_closed_advertising,
       close_basis AS immutable_close_basis,closed_at,
       (version IS NOT NULL
        AND close_basis->>'advertising_source'='following_calendar_month_ProductAdsPayment_bridge'
        AND ads_calendar_complete AND ads_attribution_mature) AS ads_api_restatement_available
FROM readiness;

COMMENT ON VIEW mart.ads_finance_month_context IS
'Finance-only monthly advertising reconciliation. Ads API close readiness uses the explicit attribution window recorded with report facts; unknown windows cannot mature silently. The following-month RELEASED ProductAdsPayment remains the temporary bridge. Closed management months remain immutable and later Ads differences require explicit RESTATED versions.';
