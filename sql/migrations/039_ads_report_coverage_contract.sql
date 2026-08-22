-- Amazon Ads report coverage/completeness contract.
-- A business date is trusted only when every required independent canonical grain
-- has a successful report run for the account. This stays transport-neutral so
-- Reporting v3 and Unified Reporting can coexist during migration.

CREATE TABLE IF NOT EXISTS ads.required_report_grain (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    report_grain text NOT NULL,
    ad_product text NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
    required boolean NOT NULL DEFAULT true,
    effective_from date NOT NULL DEFAULT CURRENT_DATE,
    effective_to date,
    PRIMARY KEY (account_id, report_grain, ad_product, effective_from),
    CONSTRAINT ads_required_report_grain_nonempty CHECK (btrim(report_grain) <> ''),
    CONSTRAINT ads_required_report_product_nonempty CHECK (btrim(ad_product) <> ''),
    CONSTRAINT ads_required_report_dates_valid CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

COMMENT ON TABLE ads.required_report_grain IS
'Account-scoped canonical Ads grains required before a date may be treated as complete. Configuration is business-grain based, never transport/report-type based.';

CREATE OR REPLACE VIEW ads.report_daily_coverage AS
WITH required AS (
    SELECT
        r.account_id,
        r.report_grain,
        r.ad_product,
        d::date AS report_date
    FROM ads.required_report_grain r
    CROSS JOIN LATERAL generate_series(
        r.effective_from::timestamp,
        COALESCE(r.effective_to, CURRENT_DATE)::timestamp,
        interval '1 day'
    ) d
    WHERE r.required
), successful AS (
    SELECT DISTINCT
        rr.account_id,
        rr.report_grain,
        COALESCE(rr.ad_product, 'SPONSORED_PRODUCTS') AS ad_product,
        d::date AS report_date,
        max(rr.source_generated_at) OVER (
            PARTITION BY rr.account_id, rr.report_grain,
                         COALESCE(rr.ad_product, 'SPONSORED_PRODUCTS'), d::date
        ) AS source_generated_at,
        max(rr.ingested_at) OVER (
            PARTITION BY rr.account_id, rr.report_grain,
                         COALESCE(rr.ad_product, 'SPONSORED_PRODUCTS'), d::date
        ) AS ingested_at
    FROM ads.report_run rr
    CROSS JOIN LATERAL generate_series(
        rr.start_date::timestamp,
        rr.end_date::timestamp,
        interval '1 day'
    ) d
    WHERE upper(rr.status) IN ('INGESTED', 'SUCCESS', 'COMPLETED')
)
SELECT
    r.account_id,
    r.report_date,
    count(*)::integer AS required_grains,
    count(s.report_grain)::integer AS complete_grains,
    (count(*) = count(s.report_grain)) AS is_complete,
    array_agg(r.report_grain || ':' || r.ad_product ORDER BY r.report_grain, r.ad_product)
        FILTER (WHERE s.report_grain IS NULL) AS missing_grains,
    min(s.source_generated_at) AS oldest_source_generated_at,
    min(s.ingested_at) AS oldest_ingested_at
FROM required r
LEFT JOIN successful s
  ON s.account_id = r.account_id
 AND s.report_date = r.report_date
 AND s.report_grain = r.report_grain
 AND s.ad_product = r.ad_product
GROUP BY r.account_id, r.report_date;

COMMENT ON VIEW ads.report_daily_coverage IS
'Daily Ads ingestion completeness. is_complete is true only when every configured independent canonical grain has a successful covering report run. Missing grains are explicit and must prevent trusted ROAS/ACOS/TACOS presentation.';

CREATE INDEX IF NOT EXISTS ads_required_report_grain_account_idx
    ON ads.required_report_grain (account_id, effective_from, effective_to)
    WHERE required;
