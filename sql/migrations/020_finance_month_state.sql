-- Canonical Finance accounting-period state.
-- Amazon-side closure is independent from seller-owned COGS readiness.
-- A management month is CLOSED only when an immutable finance_month_close
-- snapshot exists; missing product costs must never keep the Amazon side OPEN.

CREATE OR REPLACE VIEW mart.finance_month_state AS
WITH months AS (
    SELECT DISTINCT marketplace_id,
           date_trunc('month', business_date)::date AS month
    FROM mart.business_daily
    WHERE reconciled_daily_report
),
order_release AS (
    SELECT
      o.marketplace_id,
      date_trunc('month', o.created_time AT TIME ZONE 'America/Mexico_City')::date AS month,
      count(DISTINCT o.amazon_order_id)::int AS core_orders,
      count(DISTINCT ft.amazon_order_id) FILTER (
        WHERE ft.transaction_status='RELEASED' AND ft.transaction_type='Shipment'
      )::int AS released_orders,
      count(*) FILTER (WHERE ft.transaction_status='DEFERRED')::int AS deferred_events
    FROM core.amazon_order o
    LEFT JOIN core.financial_transaction ft
      ON ft.marketplace_id=o.marketplace_id
     AND ft.amazon_order_id=o.amazon_order_id
    WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
    GROUP BY o.marketplace_id,
             date_trunc('month', o.created_time AT TIME ZONE 'America/Mexico_City')::date
),
closed AS (
    SELECT marketplace_id, month, version, state, closed_at
    FROM mart.finance_month_close_latest
)
SELECT
  m.marketplace_id,
  m.month,
  (m.month = date_trunc('month', now() AT TIME ZONE 'America/Mexico_City')::date) AS is_current_month,
  COALESCE(r.core_orders,0) AS core_orders,
  COALESCE(r.released_orders,0) AS released_orders,
  COALESCE(r.deferred_events,0) AS deferred_events,
  (COALESCE(r.deferred_events,0)=0 AND (COALESCE(r.released_orders,0)>0 OR COALESCE(r.core_orders,0)=0)) AS order_release_complete,
  a.advertising_close_state,
  a.candidate_advertising_amount,
  a.candidate_advertising_source,
  a.ads_calendar_complete,
  a.ads_attribution_mature,
  a.ads_api_restatement_available,
  (
    COALESCE(r.deferred_events,0)=0
    AND (COALESCE(r.released_orders,0)>0 OR COALESCE(r.core_orders,0)=0)
    AND a.advertising_close_state IN ('ADS_API_ACCRUAL_READY','PRODUCT_ADS_PAYMENT_BRIDGE_READY')
    AND (m.month + interval '1 month - 1 day')::date
        + COALESCE(current_setting('dpp.finance_close_grace_days', true)::int, 10)
        <= (now() AT TIME ZONE 'America/Mexico_City')::date
  ) AS amazon_closed,
  c.version AS management_close_version,
  c.state AS management_close_state,
  c.closed_at AS management_closed_at,
  CASE
    WHEN m.month = date_trunc('month', now() AT TIME ZONE 'America/Mexico_City')::date THEN 'OPEN'
    WHEN c.version IS NOT NULL THEN c.state
    WHEN COALESCE(r.deferred_events,0)=0
      AND (COALESCE(r.released_orders,0)>0 OR COALESCE(r.core_orders,0)=0)
      AND a.advertising_close_state IN ('ADS_API_ACCRUAL_READY','PRODUCT_ADS_PAYMENT_BRIDGE_READY')
      AND (m.month + interval '1 month - 1 day')::date
          + COALESCE(current_setting('dpp.finance_close_grace_days', true)::int, 10)
          <= (now() AT TIME ZONE 'America/Mexico_City')::date
      THEN 'AMAZON_CLOSED_COGS_PENDING'
    ELSE 'AMAZON_CLOSING'
  END AS accounting_state
FROM months m
LEFT JOIN order_release r USING (marketplace_id, month)
LEFT JOIN mart.ads_finance_month_context a USING (marketplace_id, month)
LEFT JOIN closed c USING (marketplace_id, month);

COMMENT ON VIEW mart.finance_month_state IS
'Canonical accounting-period state. OPEN is the current month. AMAZON_CLOSING waits only for Amazon release, advertising close and grace. AMAZON_CLOSED_COGS_PENDING means Amazon is final but seller COGS has not yet been frozen. CLOSED/RESTATED require immutable core.finance_month_close plus SKU COGS snapshots. Product-cost edits never alter a closed version.';
