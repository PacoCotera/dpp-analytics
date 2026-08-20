-- Follow-up hardening for the target-grain repair. Migration 014 is immutable once
-- applied; use distinct index names here so a renamed legacy table cannot retain a
-- schema-level index name that prevents the clean fact table from being indexed.

CREATE INDEX IF NOT EXISTS ads_daily_target_fact_date_idx
    ON ads.daily_target(business_date DESC, account_id);

CREATE INDEX IF NOT EXISTS ads_daily_target_fact_campaign_idx
    ON ads.daily_target(account_id, campaign_id, business_date DESC);

CREATE INDEX IF NOT EXISTS ads_daily_target_fact_efficiency_idx
    ON ads.daily_target(account_id, spend DESC, business_date DESC);

CREATE INDEX IF NOT EXISTS ads_daily_search_term_fact_date_idx
    ON ads.daily_search_term(business_date DESC, account_id);

CREATE INDEX IF NOT EXISTS ads_daily_search_term_fact_campaign_idx
    ON ads.daily_search_term(account_id, campaign_id, business_date DESC);

COMMENT ON INDEX ads.ads_daily_target_fact_date_idx IS
  'Query support for target performance windows after the mixed target/search-term grain was retired.';
COMMENT ON INDEX ads.ads_daily_search_term_fact_date_idx IS
  'Query support for shopper search-term performance windows.';
