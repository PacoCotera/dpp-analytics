-- Extend the Amazon Ads warehouse below campaign and advertised-product grain.
-- These tables are intentionally multi-account and multi-marketplace ready through
-- account_id. Search terms remain separate from targets because Amazon attribution
-- and query text can revise independently of the configured targeting object.

CREATE TABLE IF NOT EXISTS ads.target (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    target_id text NOT NULL,
    campaign_id text NOT NULL,
    ad_group_id text,
    ad_product text NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
    target_type text,
    target_expression text,
    match_type text,
    state text,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (account_id, target_id)
);

CREATE INDEX IF NOT EXISTS ads_target_campaign_idx
    ON ads.target(account_id, campaign_id);

CREATE TABLE IF NOT EXISTS ads.daily_target (
    account_id text NOT NULL,
    target_id text NOT NULL,
    business_date date NOT NULL,
    campaign_id text NOT NULL,
    ad_group_id text,
    ad_product text NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    spend numeric(18,4) NOT NULL DEFAULT 0,
    attributed_sales numeric(18,4) NOT NULL DEFAULT 0,
    purchases bigint NOT NULL DEFAULT 0,
    units bigint NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'MXN',
    attribution_method text,
    attribution_window text,
    source_report_id text,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, target_id, business_date),
    FOREIGN KEY (account_id, target_id) REFERENCES ads.target(account_id, target_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ads_daily_target_date_idx
    ON ads.daily_target(business_date, account_id);
CREATE INDEX IF NOT EXISTS ads_daily_target_campaign_idx
    ON ads.daily_target(account_id, campaign_id, business_date);

CREATE TABLE IF NOT EXISTS ads.daily_search_term (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    business_date date NOT NULL,
    campaign_id text NOT NULL,
    ad_group_id text,
    target_id text,
    ad_product text NOT NULL DEFAULT 'SPONSORED_PRODUCTS',
    search_term text NOT NULL,
    match_type text,
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    spend numeric(18,4) NOT NULL DEFAULT 0,
    attributed_sales numeric(18,4) NOT NULL DEFAULT 0,
    purchases bigint NOT NULL DEFAULT 0,
    units bigint NOT NULL DEFAULT 0,
    currency text NOT NULL DEFAULT 'MXN',
    attribution_method text,
    attribution_window text,
    source_report_id text,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, business_date, campaign_id, ad_group_id, search_term)
);

CREATE INDEX IF NOT EXISTS ads_daily_search_term_date_idx
    ON ads.daily_search_term(business_date, account_id);
CREATE INDEX IF NOT EXISTS ads_daily_search_term_target_idx
    ON ads.daily_search_term(account_id, target_id, business_date);

COMMENT ON TABLE ads.daily_search_term IS
    'Amazon Ads shopper-query facts. Attributed sales are Amazon attribution, never a proxy for exact organic/non-organic sales.';
