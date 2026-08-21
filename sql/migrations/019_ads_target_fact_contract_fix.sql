-- Align targeting/search-term storage with the Reporting v3 ingestion contract.
--
-- Reporting facts are authoritative historical observations. Target metadata may be
-- revised by Amazon, so the daily fact keeps the descriptors reported for that day.
-- ads.target remains available as a current-state dimension once target discovery is
-- wired, but ingestion must not require that mutable dimension to exist first.

ALTER TABLE ads.daily_target
    ADD COLUMN IF NOT EXISTS target_type text,
    ADD COLUMN IF NOT EXISTS target_expression text,
    ADD COLUMN IF NOT EXISTS match_type text;

-- 013 made the fact depend on ads.target even though Reporting v3 ingestion does not
-- populate that dimension. Drop that dependency before live backfill so a valid report
-- cannot fail merely because target discovery has not run.
ALTER TABLE ads.daily_target
    DROP CONSTRAINT IF EXISTS daily_target_account_id_target_id_fkey;

-- The v3 search-term writer keys rows by target as well as shopper query. The original
-- PK omitted target_id, which can collapse two targets producing the same query inside
-- one ad group/day. Normalize NULL to the empty reporting identifier before enforcing
-- the corrected grain.
UPDATE ads.daily_search_term
SET target_id = ''
WHERE target_id IS NULL;

ALTER TABLE ads.daily_search_term
    ALTER COLUMN target_id SET DEFAULT '',
    ALTER COLUMN target_id SET NOT NULL;

ALTER TABLE ads.daily_search_term
    DROP CONSTRAINT IF EXISTS daily_search_term_pkey;

ALTER TABLE ads.daily_search_term
    ADD CONSTRAINT daily_search_term_pkey
    PRIMARY KEY (account_id, business_date, campaign_id, ad_group_id, target_id, search_term);

COMMENT ON COLUMN ads.daily_target.target_expression IS
    'Target expression as reported for this historical fact; do not project current target metadata backwards.';

COMMENT ON TABLE ads.daily_target IS
    'Daily Sponsored Products targeting facts at account/campaign/ad-group/target grain. Amazon-attributed sales are attribution, not exact incremental sales.';
