-- Finance accounting correctness hardening.
-- 1) Advertising is always stored/exposed as a negative management expense,
--    regardless of whether its source is positive Ads API spend or a negative
--    ProductAdsPayment settlement posting.
-- 2) Amazon order release is complete only when every non-cancelled order in the
--    business month has a RELEASED Shipment and no DEFERRED finance events remain.
-- 3) Marketplace timezone comes from core.marketplace.

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
    SELECT ft.marketplace_id,
           (date_trunc('month',ft.posted_date AT TIME ZONE mp.timezone)-interval '1 month')::date AS month,
           count(*)::int AS bridge_events,sum(ft.total_amount)::numeric(16,2) AS bridge_amount,
           min(ft.posted_date) AS bridge_first_posted_at,max(ft.posted_date) AS bridge_last_posted_at
    FROM core.financial_transaction ft
    JOIN core.marketplace mp USING(marketplace_id)
    WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='ProductAdsPayment'
    GROUP BY ft.marketplace_id,(date_trunc('month',ft.posted_date AT TIME ZONE mp.timezone)-interval '1 month')::date
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
       attribution_method,attribution_window,ads_last_business_date,ads_through_date,
       ads_source_generated_at,ads_ingested_at,ads_calendar_complete,ads_attribution_mature,
       COALESCE(bridge_events,0) AS bridge_events,bridge_amount AS product_ads_payment_bridge,
       bridge_first_posted_at,bridge_last_posted_at,
       CASE WHEN ads_calendar_complete AND ads_attribution_mature THEN 'ADS_API_ACCRUAL_READY'
            WHEN COALESCE(bridge_events,0)>0 THEN 'PRODUCT_ADS_PAYMENT_BRIDGE_READY' ELSE 'PENDING' END AS advertising_close_state,
       CASE WHEN ads_calendar_complete AND ads_attribution_mature THEN -abs(ads_api_accrual)
            WHEN COALESCE(bridge_events,0)>0 THEN -abs(bridge_amount) ELSE NULL END AS candidate_advertising_amount,
       CASE WHEN ads_calendar_complete AND ads_attribution_mature THEN 'amazon_ads_api_accrual'
            WHEN COALESCE(bridge_events,0)>0 THEN 'following_calendar_month_ProductAdsPayment_bridge' ELSE NULL END AS candidate_advertising_source,
       version AS closed_version,state AS management_close_state,advertising AS immutable_closed_advertising,
       close_basis AS immutable_close_basis,closed_at,
       (version IS NOT NULL
        AND close_basis->>'advertising_source'='following_calendar_month_ProductAdsPayment_bridge'
        AND ads_calendar_complete AND ads_attribution_mature) AS ads_api_restatement_available,
       attribution_window_days,
       CASE WHEN attribution_window_known THEN month_end+attribution_window_days END AS ads_mature_after_date,
       CASE WHEN attribution_window_known THEN CASE WHEN ads_attribution_mature THEN 'MATURE' ELSE 'PROVISIONAL' END ELSE 'UNKNOWN' END AS ads_attribution_state
FROM readiness;

COMMENT ON VIEW mart.ads_finance_month_context IS
'Finance-only monthly advertising reconciliation. candidate_advertising_amount is always a negative management expense. Ads API readiness uses the fact attribution window; the following-month RELEASED ProductAdsPayment is the temporary bridge. Closed months remain immutable.';

CREATE OR REPLACE VIEW mart.finance_month_state AS
WITH months AS (
    SELECT DISTINCT marketplace_id,date_trunc('month',business_date)::date AS month
    FROM mart.business_daily WHERE reconciled_daily_report
), order_release AS (
    SELECT o.marketplace_id,
           date_trunc('month',o.created_time AT TIME ZONE mp.timezone)::date AS month,
           count(DISTINCT o.amazon_order_id)::int AS core_orders,
           count(DISTINCT ft.amazon_order_id) FILTER (
             WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='Shipment'
           )::int AS released_orders,
           count(*) FILTER (WHERE ft.transaction_status='DEFERRED')::int AS deferred_events
    FROM core.amazon_order o
    JOIN core.marketplace mp USING(marketplace_id)
    LEFT JOIN core.financial_transaction ft
      ON ft.marketplace_id=o.marketplace_id AND ft.amazon_order_id=o.amazon_order_id
    WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
    GROUP BY o.marketplace_id,date_trunc('month',o.created_time AT TIME ZONE mp.timezone)::date
), closed AS (
    SELECT marketplace_id,month,version,state,closed_at FROM mart.finance_month_close_latest
), prepared AS (
    SELECT m.marketplace_id,m.month,mp.timezone,
           (m.month=date_trunc('month',now() AT TIME ZONE mp.timezone)::date) AS is_current_month,
           COALESCE(r.core_orders,0) AS core_orders,COALESCE(r.released_orders,0) AS released_orders,
           COALESCE(r.deferred_events,0) AS deferred_events,
           (COALESCE(r.deferred_events,0)=0 AND COALESCE(r.released_orders,0)=COALESCE(r.core_orders,0)) AS order_release_complete,
           a.advertising_close_state,a.candidate_advertising_amount,a.candidate_advertising_source,
           a.ads_calendar_complete,a.ads_attribution_mature,a.ads_api_restatement_available,
           c.version AS management_close_version,c.state AS management_close_state,c.closed_at AS management_closed_at,
           ((m.month+interval '1 month - 1 day')::date
              + COALESCE(current_setting('dpp.finance_close_grace_days',true)::int,10)
              <= (now() AT TIME ZONE mp.timezone)::date) AS grace_complete
    FROM months m
    JOIN core.marketplace mp USING(marketplace_id)
    LEFT JOIN order_release r USING(marketplace_id,month)
    LEFT JOIN mart.ads_finance_month_context a USING(marketplace_id,month)
    LEFT JOIN closed c USING(marketplace_id,month)
)
SELECT marketplace_id,month,is_current_month,core_orders,released_orders,deferred_events,
       order_release_complete,advertising_close_state,candidate_advertising_amount,candidate_advertising_source,
       ads_calendar_complete,ads_attribution_mature,ads_api_restatement_available,
       (order_release_complete
        AND advertising_close_state IN ('ADS_API_ACCRUAL_READY','PRODUCT_ADS_PAYMENT_BRIDGE_READY')
        AND grace_complete) AS amazon_closed,
       management_close_version,management_close_state,management_closed_at,
       CASE
         WHEN is_current_month THEN 'OPEN'
         WHEN management_close_version IS NOT NULL THEN management_close_state
         WHEN order_release_complete
          AND advertising_close_state IN ('ADS_API_ACCRUAL_READY','PRODUCT_ADS_PAYMENT_BRIDGE_READY')
          AND grace_complete THEN 'AMAZON_CLOSED_COGS_PENDING'
         ELSE 'AMAZON_CLOSING'
       END AS accounting_state
FROM prepared;

COMMENT ON VIEW mart.finance_month_state IS
'Canonical accounting-period state. Amazon release is complete only at 100% released non-cancelled orders with zero DEFERRED events. Missing seller COGS never keeps Amazon-side accounting open. CLOSED/RESTATED require immutable snapshots.';
