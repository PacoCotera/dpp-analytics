-- Gross/invalid traffic is an independent Amazon data-quality source. The
-- populated MX report returns campaign names but not campaign IDs, so source
-- rows and conservative point-in-time resolution evidence are both retained.

CREATE TABLE ads.gross_invalid_traffic_observation (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    report_id text NOT NULL,
    source_row_ordinal integer NOT NULL CHECK (source_row_ordinal > 0),
    requested_start_date date NOT NULL,
    requested_end_date date NOT NULL,
    source_start_date date,
    source_end_date date,
    campaign_name text,
    campaign_status text,
    valid_impressions bigint,
    valid_click_throughs bigint,
    gross_impressions bigint,
    invalid_impressions bigint,
    source_invalid_impression_rate numeric(18,10),
    gross_click_throughs bigint,
    invalid_click_throughs bigint,
    source_invalid_click_through_rate numeric(18,10),
    identity_snapshot_at timestamptz,
    resolved_campaign_id text,
    identity_candidate_count integer NOT NULL DEFAULT 0,
    identity_state text NOT NULL CHECK (
        identity_state IN (
            'CURRENT_NAME_UNIQUE','NAME_CONFLICT','NAME_MISSING',
            'NO_COMPLETE_SNAPSHOT'
        )
    ),
    identity_candidate_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_record jsonb NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id,report_id,source_row_ordinal),
    CHECK (requested_end_date >= requested_start_date),
    CHECK (
        source_end_date IS NULL OR source_start_date IS NULL
        OR source_end_date >= source_start_date
    ),
    CHECK (jsonb_typeof(identity_candidate_ids)='array'),
    CHECK (jsonb_typeof(source_record)='object'),
    CHECK (
        (identity_state='CURRENT_NAME_UNIQUE'
         AND identity_candidate_count=1 AND resolved_campaign_id IS NOT NULL)
        OR
        (identity_state<>'CURRENT_NAME_UNIQUE'
         AND resolved_campaign_id IS NULL)
    )
);

CREATE INDEX ads_gross_invalid_window_idx
    ON ads.gross_invalid_traffic_observation(
        account_id,requested_end_date DESC,requested_start_date DESC
    );

CREATE INDEX ads_gross_invalid_campaign_idx
    ON ads.gross_invalid_traffic_observation(
        account_id,resolved_campaign_id,requested_end_date DESC
    ) WHERE resolved_campaign_id IS NOT NULL;

CREATE VIEW mart.ads_gross_invalid_traffic_report AS
SELECT
    account.marketplace_id,
    observation.account_id,
    observation.report_id,
    observation.requested_start_date AS window_start,
    observation.requested_end_date AS window_end,
    count(*)::bigint AS source_rows,
    count(*) FILTER (
        WHERE observation.identity_state='CURRENT_NAME_UNIQUE'
    )::bigint AS uniquely_resolved_rows,
    count(*) FILTER (
        WHERE observation.identity_state<>'CURRENT_NAME_UNIQUE'
    )::bigint AS unresolved_rows,
    COALESCE(sum(observation.valid_impressions),0)::bigint AS valid_impressions,
    COALESCE(sum(observation.gross_impressions),0)::bigint AS gross_impressions,
    COALESCE(sum(observation.invalid_impressions),0)::bigint AS invalid_impressions,
    COALESCE(sum(observation.valid_click_throughs),0)::bigint
        AS valid_click_throughs,
    COALESCE(sum(observation.gross_click_throughs),0)::bigint
        AS gross_click_throughs,
    COALESCE(sum(observation.invalid_click_throughs),0)::bigint
        AS invalid_click_throughs,
    CASE WHEN sum(observation.gross_impressions)>0
         THEN sum(observation.invalid_impressions)::numeric
              / sum(observation.gross_impressions)
    END AS derived_invalid_impression_rate,
    CASE WHEN sum(observation.gross_click_throughs)>0
         THEN sum(observation.invalid_click_throughs)::numeric
              / sum(observation.gross_click_throughs)
    END AS derived_invalid_click_through_rate,
    max(observation.identity_snapshot_at) AS identity_snapshot_at,
    max(observation.ingested_at) AS ingested_at,
    CASE
        WHEN count(*) FILTER (
            WHERE observation.identity_state<>'CURRENT_NAME_UNIQUE'
        )=0 THEN 'IDENTITY_RECONCILED'
        WHEN count(*) FILTER (
            WHERE observation.identity_state='NO_COMPLETE_SNAPSHOT'
        )>0 THEN 'IDENTITY_SNAPSHOT_MISSING'
        ELSE 'IDENTITY_UNRESOLVED'
    END AS identity_state
FROM ads.gross_invalid_traffic_observation observation
JOIN ads.account account USING (account_id)
GROUP BY
    account.marketplace_id,observation.account_id,observation.report_id,
    observation.requested_start_date,observation.requested_end_date;

COMMENT ON TABLE ads.gross_invalid_traffic_observation IS
'Immutable Sponsored Products gross/invalid-traffic source rows. Amazon valid traffic remains the charged-performance basis; gross and invalid traffic are trust evidence, not additional spend or sales.';

COMMENT ON COLUMN ads.gross_invalid_traffic_observation.resolved_campaign_id IS
'Campaign ID only when the source campaign name matched exactly one campaign in the latest COMPLETE entity snapshot at ingestion. Name conflicts or missing history remain unresolved.';

COMMENT ON VIEW mart.ads_gross_invalid_traffic_report IS
'Account/report/window traffic-quality evidence with identity coverage. Rates derived from counts are separate from the vendor row rates retained in the source observations.';
