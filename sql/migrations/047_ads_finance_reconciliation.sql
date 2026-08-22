-- Reconcile canonical Ads accrual to Amazon's RELEASED ProductAdsPayment cash/ledger evidence.
-- This is evidence, not a fake equality contract: accrual and payment timing differ.
-- Finance close continues to use ads_finance_month_context for the accounting candidate.

CREATE OR REPLACE VIEW mart.ads_finance_reconciliation AS
WITH ads_month AS (
  SELECT
    a.marketplace_id,
    date_trunc('month', d.business_date)::date AS month,
    sum(d.spend)::numeric(16,2) AS ads_accrual,
    min(d.business_date) AS first_ads_date,
    max(d.business_date) AS last_ads_date
  FROM ads.account a
  JOIN ads.daily_account d USING (account_id)
  GROUP BY a.marketplace_id, date_trunc('month', d.business_date)::date
), payments AS (
  SELECT
    marketplace_id,
    date_trunc('month', posted_date AT TIME ZONE 'America/Mexico_City')::date AS payment_month,
    sum(total_amount)::numeric(16,2) AS released_product_ads_payment,
    count(*)::bigint AS payment_events,
    min(posted_date) AS first_payment_at,
    max(posted_date) AS last_payment_at
  FROM core.financial_transaction
  WHERE transaction_status = 'RELEASED'
    AND transaction_type = 'ProductAdsPayment'
  GROUP BY marketplace_id, date_trunc('month', posted_date AT TIME ZONE 'America/Mexico_City')::date
), months AS (
  SELECT marketplace_id, month FROM ads_month
  UNION
  SELECT marketplace_id, (payment_month - interval '1 month')::date AS month FROM payments
)
SELECT
  m.marketplace_id,
  m.month,
  a.ads_accrual,
  p.released_product_ads_payment AS following_month_released_payment,
  p.payment_events AS following_month_payment_events,
  p.first_payment_at AS following_month_first_payment_at,
  p.last_payment_at AS following_month_last_payment_at,
  CASE
    WHEN a.ads_accrual IS NULL OR p.released_product_ads_payment IS NULL THEN NULL
    ELSE (a.ads_accrual + p.released_product_ads_payment)::numeric(16,2)
  END AS timing_basis_delta,
  CASE
    WHEN a.ads_accrual IS NULL THEN 'ADS_ACCRUAL_MISSING'
    WHEN p.released_product_ads_payment IS NULL THEN 'PAYMENT_EVIDENCE_PENDING'
    ELSE 'EVIDENCE_AVAILABLE'
  END AS evidence_state,
  'Ads API spend is an accrual/performance basis. ProductAdsPayment is RELEASED Amazon ledger/cash-timing evidence and is not expected to equal the accrual by calendar month.'::text AS interpretation
FROM months m
LEFT JOIN ads_month a ON a.marketplace_id=m.marketplace_id AND a.month=m.month
LEFT JOIN payments p ON p.marketplace_id=m.marketplace_id AND p.payment_month=(m.month + interval '1 month')::date;

COMMENT ON VIEW mart.ads_finance_reconciliation IS
'Finance evidence comparing monthly canonical Ads accrual with following-month RELEASED ProductAdsPayment. Delta is diagnostic only; never present it as an accounting reconciliation that must equal zero.';
