-- Transport-neutral Amazon Ads report provenance.
-- Canonical ads facts must survive migration between Reporting v3 and Amazon's
-- current Unified Reporting transport without changing their business grain.

CREATE TABLE IF NOT EXISTS ads.report_run (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    report_id text NOT NULL,
    transport text NOT NULL,
    report_grain text NOT NULL,
    ad_product text,
    start_date date NOT NULL,
    end_date date NOT NULL,
    requested_at timestamptz,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL DEFAULT 'INGESTED',
    row_count bigint,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (account_id, report_id),
    CONSTRAINT ads_report_run_transport_nonempty CHECK (btrim(transport) <> ''),
    CONSTRAINT ads_report_run_grain_nonempty CHECK (btrim(report_grain) <> ''),
    CONSTRAINT ads_report_run_dates_valid CHECK (end_date >= start_date)
);

CREATE INDEX IF NOT EXISTS ads_report_run_account_date_idx
    ON ads.report_run (account_id, end_date DESC, report_grain);

COMMENT ON TABLE ads.report_run IS
'Amazon Ads ingestion provenance independent of report transport. transport identifies the adapter (for example reporting_v3 or unified_reporting); canonical ads facts remain transport-neutral.';

COMMENT ON COLUMN ads.report_run.report_grain IS
'Canonical business grain such as account, campaign, advertised_product, target, or search_term; not a vendor report-type identifier.';

COMMENT ON COLUMN ads.report_run.transport IS
'Physical Amazon Ads reporting transport used to obtain the facts. Do not branch product semantics on this value.';
