-- Repair the target/search-term split for databases that already applied 010_amazon_ads.sql.
-- Migration 010 created ads.daily_target with search_term in its primary key. Migration
-- 013 introduced a proper target entity and a separate ads.daily_search_term table,
-- but CREATE TABLE IF NOT EXISTS could not replace the pre-existing daily_target shape.
--
-- Keep any legacy rows for audit, migrate target-only history when present, and make
-- ads.daily_target a true target-grain fact table going forward.

DO $$
BEGIN
    IF to_regclass('ads.daily_target') IS NOT NULL
       AND to_regclass('ads.daily_target_legacy') IS NULL
       AND EXISTS (
            SELECT 1
            FROM information_schema.columns
            WHERE table_schema='ads' AND table_name='daily_target' AND column_name='search_term'
       ) THEN
        ALTER TABLE ads.daily_target RENAME TO daily_target_legacy;
    END IF;
END $$;

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
    FOREIGN KEY (account_id, target_id)
      REFERENCES ads.target(account_id, target_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ads_daily_target_date_idx
    ON ads.daily_target(business_date, account_id);
CREATE INDEX IF NOT EXISTS ads_daily_target_campaign_idx
    ON ads.daily_target(account_id, campaign_id, business_date);

-- If the old mixed-grain table contains data, preserve its target semantics without
-- carrying shopper queries into the target fact. Search terms now have their own table.
DO $$
BEGIN
    IF to_regclass('ads.daily_target_legacy') IS NOT NULL THEN
        INSERT INTO ads.target(
            account_id,target_id,campaign_id,ad_group_id,ad_product,
            target_expression,match_type,last_seen_at,metadata
        )
        SELECT
            account_id,
            target_id,
            max(campaign_id),
            max(ad_group_id),
            max(ad_product),
            max(target_expression),
            max(match_type),
            max(ingested_at),
            jsonb_build_object('migrated_from','ads.daily_target_legacy')
        FROM ads.daily_target_legacy
        WHERE coalesce(target_id,'') <> ''
        GROUP BY account_id,target_id
        ON CONFLICT(account_id,target_id) DO UPDATE SET
            campaign_id=COALESCE(EXCLUDED.campaign_id,ads.target.campaign_id),
            ad_group_id=COALESCE(EXCLUDED.ad_group_id,ads.target.ad_group_id),
            target_expression=COALESCE(EXCLUDED.target_expression,ads.target.target_expression),
            match_type=COALESCE(EXCLUDED.match_type,ads.target.match_type),
            last_seen_at=GREATEST(ads.target.last_seen_at,EXCLUDED.last_seen_at);

        INSERT INTO ads.daily_target(
            account_id,target_id,business_date,campaign_id,ad_group_id,ad_product,
            impressions,clicks,spend,attributed_sales,purchases,units,currency,
            attribution_method,attribution_window,source_report_id,source_generated_at,ingested_at
        )
        SELECT
            account_id,target_id,business_date,max(campaign_id),max(ad_group_id),max(ad_product),
            sum(impressions),sum(clicks),sum(spend),sum(attributed_sales),sum(purchases),sum(units),
            max(currency),max(attribution_method),max(attribution_window),max(source_report_id),
            max(source_generated_at),max(ingested_at)
        FROM ads.daily_target_legacy
        WHERE coalesce(target_id,'') <> ''
        GROUP BY account_id,target_id,business_date
        ON CONFLICT(account_id,target_id,business_date) DO UPDATE SET
            campaign_id=EXCLUDED.campaign_id,
            ad_group_id=EXCLUDED.ad_group_id,
            ad_product=EXCLUDED.ad_product,
            impressions=EXCLUDED.impressions,
            clicks=EXCLUDED.clicks,
            spend=EXCLUDED.spend,
            attributed_sales=EXCLUDED.attributed_sales,
            purchases=EXCLUDED.purchases,
            units=EXCLUDED.units,
            currency=EXCLUDED.currency,
            attribution_method=EXCLUDED.attribution_method,
            attribution_window=EXCLUDED.attribution_window,
            source_report_id=EXCLUDED.source_report_id,
            source_generated_at=EXCLUDED.source_generated_at,
            ingested_at=EXCLUDED.ingested_at;

        COMMENT ON TABLE ads.daily_target_legacy IS
          'Deprecated mixed target/search-term grain retained for audit after migration 014. New ingestion writes target facts to ads.daily_target and shopper queries to ads.daily_search_term.';
    END IF;
END $$;

CREATE OR REPLACE VIEW mart.ads_target_daily AS
SELECT
    a.marketplace_id,
    d.account_id,
    d.business_date,
    d.ad_product,
    d.campaign_id,
    d.ad_group_id,
    d.target_id,
    t.target_type,
    t.target_expression,
    t.match_type,
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
FROM ads.daily_target d
JOIN ads.account a USING(account_id)
LEFT JOIN ads.target t
  ON t.account_id=d.account_id AND t.target_id=d.target_id;

CREATE OR REPLACE VIEW mart.ads_search_term_daily AS
SELECT
    a.marketplace_id,
    d.account_id,
    d.business_date,
    d.ad_product,
    d.campaign_id,
    d.ad_group_id,
    d.target_id,
    d.search_term,
    d.match_type,
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
FROM ads.daily_search_term d
JOIN ads.account a USING(account_id);

COMMENT ON VIEW mart.ads_target_daily IS
  'Target-grain Amazon Ads performance. Derived efficiency metrics preserve Amazon attribution semantics.';
COMMENT ON VIEW mart.ads_search_term_daily IS
  'Shopper-query Amazon Ads performance. Search terms are not exact organic-demand measures and can revise within the attribution window.';
