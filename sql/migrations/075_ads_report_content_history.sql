-- Preserve each downloaded Sponsored Products report as content-addressed,
-- compressed point-in-time evidence. Canonical ads.daily_* tables intentionally
-- remain latest-state projections; this history records what was actually
-- available to DPP before a later attribution revision overwrites that state.

CREATE TABLE ads.report_content (
    content_sha256 text PRIMARY KEY CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    encoding text NOT NULL CHECK (encoding='GZIP_CANONICAL_JSON_ROWS_V1'),
    row_count bigint NOT NULL CHECK (row_count >= 0),
    uncompressed_bytes bigint NOT NULL CHECK (uncompressed_bytes >= 2),
    compressed_bytes bigint NOT NULL CHECK (compressed_bytes >= 0),
    payload bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (content_sha256,row_count),
    CHECK (octet_length(payload)=compressed_bytes)
);

CREATE TABLE ads.report_content_observation (
    observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id text NOT NULL REFERENCES ads.account(account_id),
    report_id text NOT NULL CHECK (btrim(report_id) <> ''),
    report_grain text NOT NULL CHECK (report_grain IN (
        'campaign','product','target','search_term','ad_group','placement','purchased_product'
    )),
    ad_product text NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
    start_date date NOT NULL,
    end_date date NOT NULL CHECK (end_date >= start_date),
    source_generated_at timestamptz,
    observed_at timestamptz NOT NULL DEFAULT now(),
    content_sha256 text NOT NULL,
    row_count bigint NOT NULL CHECK (row_count >= 0),
    FOREIGN KEY (content_sha256,row_count)
        REFERENCES ads.report_content(content_sha256,row_count),
    UNIQUE (account_id,report_id,content_sha256)
);

CREATE INDEX ads_report_content_observation_cutoff_idx
    ON ads.report_content_observation(account_id,report_grain,observed_at DESC);

CREATE INDEX ads_report_content_observation_window_idx
    ON ads.report_content_observation(account_id,report_grain,end_date DESC,start_date DESC);

CREATE FUNCTION ads.reject_report_content_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '%.% is immutable point-in-time evidence',TG_TABLE_SCHEMA,TG_TABLE_NAME;
END
$$;

CREATE TRIGGER report_content_immutable
BEFORE UPDATE OR DELETE ON ads.report_content
FOR EACH ROW EXECUTE FUNCTION ads.reject_report_content_mutation();

CREATE TRIGGER report_content_observation_immutable
BEFORE UPDATE OR DELETE ON ads.report_content_observation
FOR EACH ROW EXECUTE FUNCTION ads.reject_report_content_mutation();

COMMENT ON TABLE ads.report_content IS
'Deduplicated deterministic gzip of exact decoded Amazon Ads report rows. Content is immutable and retained separately from latest-state marts.';

COMMENT ON TABLE ads.report_content_observation IS
'Immutable record of when DPP observed one report content version. Point-in-time replay may use only observations at or before its declared cutoff.';

COMMENT ON COLUMN ads.report_content_observation.source_generated_at IS
'Amazon report generation timestamp when supplied. observed_at remains the authoritative DPP availability boundary.';
