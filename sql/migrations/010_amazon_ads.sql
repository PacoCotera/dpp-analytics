-- Amazon Ads warehouse foundation.
-- Canonical facts are intentionally independent of Amazon report payload shapes.
-- Reporting v3 is a transport adapter while available; new integration work must target
-- Amazon's current Unified Reporting direction so a reporting-endpoint migration never
-- requires remodeling DPP's commercial facts.

CREATE SCHEMA IF NOT EXISTS ads;

CREATE TABLE IF NOT EXISTS ads.account (
    account_id text PRIMARY KEY,
    manager_account_id text,
    marketplace_id text,
    country_code char(2),
    currency char(3),
    timezone text,
    account_name text,
    account_type text,
    status text,
    consented_at timestamptz,
    refresh_token_expires_at timestamptz,
    last_discovered_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS ads_account_marketplace_idx ON ads.account (marketplace_id, country_code);

CREATE TABLE IF NOT EXISTS ads.campaign (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    campaign_id text NOT NULL,
    ad_product text NOT NULL,
    campaign_type text,
    campaign_name text,
    state text,
    targeting_type text,
    budget numeric(16,4),
    budget_type text,
    start_date date,
    end_date date,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (account_id, campaign_id)
);

CREATE TABLE IF NOT EXISTS ads.daily_account (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    business_date date NOT NULL,
    ad_product text NOT NULL DEFAULT 'ALL',
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    spend numeric(16,4) NOT NULL DEFAULT 0,
    attributed_sales numeric(16,4) NOT NULL DEFAULT 0,
    purchases bigint NOT NULL DEFAULT 0,
    units bigint NOT NULL DEFAULT 0,
    currency char(3),
    attribution_method text,
    attribution_window text,
    source_report_id text,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, business_date, ad_product)
);
CREATE INDEX IF NOT EXISTS ads_daily_account_date_idx ON ads.daily_account (business_date DESC);

CREATE TABLE IF NOT EXISTS ads.daily_campaign (
    account_id text NOT NULL,
    campaign_id text NOT NULL,
    business_date date NOT NULL,
    ad_product text NOT NULL,
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    spend numeric(16,4) NOT NULL DEFAULT 0,
    attributed_sales numeric(16,4) NOT NULL DEFAULT 0,
    purchases bigint NOT NULL DEFAULT 0,
    units bigint NOT NULL DEFAULT 0,
    currency char(3),
    attribution_method text,
    attribution_window text,
    source_report_id text,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, campaign_id, business_date),
    FOREIGN KEY (account_id, campaign_id) REFERENCES ads.campaign(account_id, campaign_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ads_daily_campaign_date_idx ON ads.daily_campaign (business_date DESC);

CREATE TABLE IF NOT EXISTS ads.daily_advertised_product (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    business_date date NOT NULL,
    ad_product text NOT NULL,
    campaign_id text,
    ad_group_id text,
    advertised_sku text NOT NULL DEFAULT '',
    advertised_asin text NOT NULL DEFAULT '',
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    spend numeric(16,4) NOT NULL DEFAULT 0,
    attributed_sales numeric(16,4) NOT NULL DEFAULT 0,
    purchases bigint NOT NULL DEFAULT 0,
    units bigint NOT NULL DEFAULT 0,
    currency char(3),
    attribution_method text,
    attribution_window text,
    source_report_id text,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, business_date, ad_product, campaign_id, ad_group_id, advertised_sku, advertised_asin)
);
CREATE INDEX IF NOT EXISTS ads_daily_product_sku_date_idx ON ads.daily_advertised_product (advertised_sku, business_date DESC);
CREATE INDEX IF NOT EXISTS ads_daily_product_asin_date_idx ON ads.daily_advertised_product (advertised_asin, business_date DESC);

CREATE TABLE IF NOT EXISTS ads.daily_target (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    business_date date NOT NULL,
    ad_product text NOT NULL,
    campaign_id text,
    ad_group_id text,
    target_id text NOT NULL DEFAULT '',
    target_expression text,
    search_term text NOT NULL DEFAULT '',
    match_type text,
    advertised_sku text,
    advertised_asin text,
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    spend numeric(16,4) NOT NULL DEFAULT 0,
    attributed_sales numeric(16,4) NOT NULL DEFAULT 0,
    purchases bigint NOT NULL DEFAULT 0,
    units bigint NOT NULL DEFAULT 0,
    currency char(3),
    attribution_method text,
    attribution_window text,
    source_report_id text,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, business_date, ad_product, campaign_id, ad_group_id, target_id, search_term)
);

CREATE OR REPLACE VIEW mart.ads_daily AS
SELECT
    a.marketplace_id,
    d.account_id,
    d.business_date,
    d.ad_product,
    d.impressions,
    d.clicks,
    d.spend,
    d.attributed_sales,
    d.purchases,
    d.units,
    CASE WHEN d.impressions > 0 THEN d.clicks::numeric / d.impressions END AS ctr,
    CASE WHEN d.clicks > 0 THEN d.spend / d.clicks END AS cpc,
    CASE WHEN d.spend > 0 THEN d.attributed_sales / d.spend END AS roas,
    CASE WHEN d.attributed_sales > 0 THEN d.spend / d.attributed_sales END AS acos,
    d.attribution_method,
    d.attribution_window,
    d.source_generated_at,
    d.ingested_at
FROM ads.daily_account d
JOIN ads.account a USING (account_id);

COMMENT ON VIEW mart.ads_daily IS
'Amazon Ads attributed performance. Attributed sales are not interchangeable with total seller sales; TACOS must be computed against independent business sales.';
