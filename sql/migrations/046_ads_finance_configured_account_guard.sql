-- Finance Ads completeness must include configured advertiser accounts that have
-- no report rows at all. Migration 045 only counted accounts observed in
-- report_daily_coverage, which could falsely close a multi-account marketplace
-- when one configured account was completely absent.

CREATE OR REPLACE VIEW mart.ads_finance_month_coverage AS
WITH months AS (
    SELECT DISTINCT marketplace_id,date_trunc('month',business_date)::date AS month
    FROM mart.business_daily
    WHERE reconciled_daily_report
), configured AS (
    SELECT account_id,marketplace_id
    FROM ads.account
    WHERE marketplace_id IS NOT NULL
      AND COALESCE(upper(status),'ENABLED') NOT IN ('ARCHIVED','DISABLED','DELETED')
), account_months AS (
    SELECT
        m.marketplace_id,m.month,a.account_id,
        extract(day FROM (m.month + interval '1 month - 1 day'))::int AS expected_days,
        count(c.report_date)::int AS coverage_days,
        count(c.report_date) FILTER (WHERE c.is_complete)::int AS complete_days,
        COALESCE(bool_and(c.is_complete) FILTER (WHERE c.report_date IS NOT NULL),false) AS all_observed_days_complete,
        array_agg(DISTINCT missing ORDER BY missing) FILTER (WHERE missing IS NOT NULL) AS missing_grains,
        min(c.oldest_source_generated_at) AS oldest_source_generated_at,
        min(c.oldest_ingested_at) AS oldest_ingested_at
    FROM months m
    JOIN configured a USING(marketplace_id)
    LEFT JOIN ads.report_daily_coverage c
      ON c.account_id=a.account_id
     AND c.report_date>=m.month
     AND c.report_date<(m.month+interval '1 month')::date
    LEFT JOIN LATERAL unnest(c.missing_grains) missing ON true
    GROUP BY m.marketplace_id,m.month,a.account_id
), marketplace_months AS (
    SELECT
        marketplace_id,month,
        count(*)::int AS configured_accounts,
        min(coverage_days)::int AS minimum_account_coverage_days,
        min(complete_days)::int AS minimum_account_complete_days,
        bool_and(all_observed_days_complete AND coverage_days=expected_days AND complete_days=expected_days) AS all_accounts_observed_complete,
        array_agg(account_id ORDER BY account_id) FILTER (WHERE coverage_days=0) AS missing_accounts,
        array_agg(DISTINCT missing ORDER BY missing) FILTER (WHERE missing IS NOT NULL) AS missing_grains,
        min(oldest_source_generated_at) AS oldest_source_generated_at,
        min(oldest_ingested_at) AS oldest_ingested_at
    FROM account_months
    LEFT JOIN LATERAL unnest(account_months.missing_grains) missing ON true
    GROUP BY marketplace_id,month
)
SELECT
    marketplace_id,month,configured_accounts,
    minimum_account_coverage_days,minimum_account_complete_days,
    all_accounts_observed_complete,
    COALESCE(missing_grains,ARRAY[]::text[]) AS missing_grains,
    oldest_source_generated_at,oldest_ingested_at,
    COALESCE(missing_accounts,ARRAY[]::text[]) AS missing_accounts
FROM marketplace_months;

COMMENT ON VIEW mart.ads_finance_month_coverage IS
'Finance Ads completeness across every enabled/configured advertiser account. Accounts with zero report coverage are explicit blockers; one healthy account can never mask a missing sibling account.';
