-- Advertising V2 must explain the configuration that existed when a decision
-- was produced. Reporting facts alone cannot prove campaign state, budget, bid,
-- targeting expression, serving status, or later manual changes.

CREATE TABLE ads.entity_snapshot_batch (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    snapshot_at timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('IN_PROGRESS','COMPLETE','FAILED')),
    ingestion_run_id bigint REFERENCES ops.ingestion_runs(id),
    entity_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    error_message text,
    PRIMARY KEY (account_id,snapshot_at),
    CHECK ((status='COMPLETE' AND completed_at IS NOT NULL) OR status<>'COMPLETE')
);

CREATE TABLE ads.entity_snapshot (
    account_id text NOT NULL,
    snapshot_at timestamptz NOT NULL,
    entity_type text NOT NULL CHECK (
        entity_type IN ('CAMPAIGN','AD_GROUP','PRODUCT_AD','TARGET','KEYWORD')
    ),
    entity_id text NOT NULL,
    campaign_id text,
    ad_group_id text,
    name text,
    state text,
    serving_status text,
    serving_status_details jsonb NOT NULL DEFAULT '[]'::jsonb,
    bid numeric(16,4),
    budget numeric(16,4),
    budget_type text,
    targeting_type text,
    portfolio_id text,
    seller_sku text,
    asin text,
    match_type text,
    expression_type text,
    expression jsonb NOT NULL DEFAULT '[]'::jsonb,
    resolved_expression jsonb NOT NULL DEFAULT '[]'::jsonb,
    bidding_strategy text,
    placement_bidding jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_created_at timestamptz,
    source_updated_at timestamptz,
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    source_record jsonb NOT NULL,
    PRIMARY KEY (account_id,snapshot_at,entity_type,entity_id),
    FOREIGN KEY (account_id,snapshot_at)
        REFERENCES ads.entity_snapshot_batch(account_id,snapshot_at)
        ON DELETE CASCADE
);

CREATE INDEX ads_entity_snapshot_subject_idx
    ON ads.entity_snapshot(account_id,entity_type,entity_id,snapshot_at DESC);

CREATE INDEX ads_entity_snapshot_campaign_idx
    ON ads.entity_snapshot(account_id,campaign_id,snapshot_at DESC)
    WHERE campaign_id IS NOT NULL;

CREATE INDEX ads_entity_snapshot_sku_idx
    ON ads.entity_snapshot(account_id,seller_sku,snapshot_at DESC)
    WHERE seller_sku IS NOT NULL;

CREATE INDEX ads_entity_snapshot_asin_idx
    ON ads.entity_snapshot(account_id,asin,snapshot_at DESC)
    WHERE asin IS NOT NULL;

CREATE OR REPLACE VIEW ads.current_entity_snapshot AS
WITH latest_complete AS (
    SELECT account_id,max(snapshot_at) AS snapshot_at
    FROM ads.entity_snapshot_batch
    WHERE status='COMPLETE'
    GROUP BY account_id
)
SELECT snapshot.*
FROM latest_complete
JOIN ads.entity_snapshot snapshot USING (account_id,snapshot_at);

COMMENT ON TABLE ads.entity_snapshot_batch IS
'Point-in-time Sponsored Products management snapshot. Only COMPLETE batches are eligible for current-state, replay, safety, or change detection.';

COMMENT ON TABLE ads.entity_snapshot IS
'Canonical immutable campaign-management observations. source_record preserves the exact entity response; typed columns support deterministic rules without browser joins.';

COMMENT ON VIEW ads.current_entity_snapshot IS
'Latest complete entity snapshot per Ads account. Incomplete and failed batches never replace the last trustworthy configuration.';
