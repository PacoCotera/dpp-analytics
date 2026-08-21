-- Align targeting/search-term storage with the Reporting v3 ingestion contract.
--
-- 013 introduced a normalized ads.target dimension, but the ingestion writer stores
-- the report's target descriptors on the daily fact as well. Keeping those descriptors
-- on the fact is deliberate: Amazon can revise targeting metadata over time and a
-- historical reporting row must remain interpretable without projecting today's
-- dimension state backwards.

ALTER TABLE ads.daily_target
    ADD COLUMN IF NOT EXISTS target_type text,
    ADD COLUMN IF NOT EXISTS target_expression text,
    ADD COLUMN IF NOT EXISTS match_type text;

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
    'Target expression as reported for this historical fact; do not assume the current ads.target dimension has identical historical metadata.';

COMMENT ON TABLE ads.daily_target IS
    'Daily Sponsored Products targeting facts at account/campaign/ad-group/target grain. Amazon-attributed sales are attribution, not exact incremental sales.';
