-- The market-level Amazon Search Terms report contains roughly twelve million
-- Mexico-store rows per week. Persisting the complete marketplace document in
-- JSONB and duplicating every row in the canonical table exhausted the 38 GB
-- production host after the first period. The source remains valuable, but the
-- decision system only needs rows connected to an owned ASIN or a query already
-- observed for DPP in SQP/Advertising.

CREATE TABLE brand.amazon_search_term_report (
    marketplace_id text NOT NULL,
    report_period text NOT NULL CHECK (report_period IN ('WEEK','MONTH','QUARTER')),
    start_date date NOT NULL,
    end_date date NOT NULL,
    source_report_id text NOT NULL,
    source_document_id text NOT NULL,
    source_row_count bigint NOT NULL CHECK (source_row_count >= 0),
    retained_row_count bigint NOT NULL CHECK (retained_row_count >= 0),
    owned_clicked_row_count bigint NOT NULL CHECK (owned_clicked_row_count >= 0),
    tracked_query_row_count bigint NOT NULL CHECK (tracked_query_row_count >= 0),
    current_owned_asin_count integer NOT NULL CHECK (current_owned_asin_count >= 0),
    tracked_query_count integer NOT NULL CHECK (tracked_query_count >= 0),
    retention_basis text NOT NULL
        CHECK (retention_basis='OWNED_CLICKED_ASIN_OR_OBSERVED_DPP_QUERY'),
    source_content_sha256 char(64),
    source_uncompressed_bytes bigint CHECK (source_uncompressed_bytes >= 0),
    source_compressed_bytes bigint CHECK (source_compressed_bytes >= 0),
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (marketplace_id,report_period,start_date,end_date)
);

ALTER TABLE brand.amazon_search_term
    ADD COLUMN matches_owned_clicked_asin boolean NOT NULL DEFAULT false,
    ADD COLUMN matches_tracked_query boolean NOT NULL DEFAULT false;

COMMENT ON TABLE brand.amazon_search_term_report IS
'Coverage and bounded-retention contract for the full-market Amazon Search Terms source. Source counts describe the complete downloaded report; canonical rows retain only owned-ASIN or observed-DPP-query evidence.';

COMMENT ON COLUMN brand.amazon_search_term_report.retention_basis IS
'The full-market source document is downloaded and reconciled by count/hash, while only rows tied to an owned clicked ASIN or a query observed in DPP SQP/Advertising are retained.';

COMMENT ON COLUMN brand.amazon_search_term.matches_owned_clicked_asin IS
'True when clicked_asin was a canonical current DPP offer at ingestion time.';

COMMENT ON COLUMN brand.amazon_search_term.matches_tracked_query IS
'True when the normalized query was already observed for DPP through SQP or Amazon Ads at ingestion time.';

-- No production decision consumed the unbounded first-period load. Reset it
-- atomically and repopulate through the bounded contract. TRUNCATE releases the
-- multi-gigabyte canonical relation immediately; the post-migration maintenance
-- action compacts deleted raw JSONB storage outside this transaction.
TRUNCATE TABLE brand.amazon_search_term;

DELETE FROM raw.api_payload
WHERE source='amazon_brand_analytics'
  AND resource_type='GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT';

DELETE FROM ops.ingestion_cursor
WHERE source='amazon_brand_analytics'
  AND job_name='search_terms_weekly';

CREATE TABLE IF NOT EXISTS ops.maintenance_action (
    action_name text PRIMARY KEY,
    status text NOT NULL CHECK (status IN ('PENDING','COMPLETE')),
    detail text,
    requested_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

INSERT INTO ops.maintenance_action(action_name,status,detail)
VALUES (
    'compact_raw_payload_after_search_terms_reset',
    'PENDING',
    'VACUUM FULL raw.api_payload after removal of the unbounded full-market Search Terms document'
)
ON CONFLICT(action_name) DO UPDATE SET
    status='PENDING', detail=EXCLUDED.detail, requested_at=now(), completed_at=NULL;

-- Amazon can emit identity-valid Repeat Purchase rows with unavailable
-- measures (most commonly a zero/no-repeat row without money or ratio fields).
-- Preserve that source fact as PARTIAL rather than fabricating zeros/currency
-- or rejecting the complete report.
ALTER TABLE brand.repeat_purchase_behavior
    ALTER COLUMN orders DROP NOT NULL,
    ALTER COLUMN unique_customers DROP NOT NULL,
    ALTER COLUMN repeat_customer_ratio DROP NOT NULL,
    ALTER COLUMN repeat_purchase_revenue DROP NOT NULL,
    ALTER COLUMN repeat_purchase_revenue_currency DROP NOT NULL,
    ALTER COLUMN repeat_purchase_revenue_ratio DROP NOT NULL,
    ADD COLUMN quality_state text NOT NULL DEFAULT 'COMPLETE'
        CHECK (quality_state IN ('COMPLETE','PARTIAL')),
    ADD COLUMN unavailable_fields text[] NOT NULL DEFAULT '{}'::text[];

CREATE TABLE brand.repeat_purchase_report (
    marketplace_id text NOT NULL,
    report_period text NOT NULL CHECK (report_period IN ('WEEK','MONTH','QUARTER')),
    start_date date NOT NULL,
    end_date date NOT NULL,
    source_report_id text NOT NULL,
    source_document_id text NOT NULL,
    source_row_count integer NOT NULL CHECK (source_row_count >= 0),
    complete_row_count integer NOT NULL CHECK (complete_row_count >= 0),
    partial_row_count integer NOT NULL CHECK (partial_row_count >= 0),
    source_content_sha256 char(64),
    source_uncompressed_bytes bigint CHECK (source_uncompressed_bytes >= 0),
    source_compressed_bytes bigint CHECK (source_compressed_bytes >= 0),
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (marketplace_id,report_period,start_date,end_date),
    CHECK (complete_row_count + partial_row_count = source_row_count)
);

COMMENT ON COLUMN brand.repeat_purchase_behavior.quality_state IS
'COMPLETE only when every documented Repeat Purchase measure is present and valid; PARTIAL rows retain identity but remain ineligible for LTV/economic use.';

COMMENT ON COLUMN brand.repeat_purchase_behavior.unavailable_fields IS
'Documented source measures that were missing or invalid. Values are left NULL and are never inferred.';
