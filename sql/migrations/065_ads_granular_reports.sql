-- Independent report grains selected in Batch 0. These facts explain allocation
-- and halo but must never be added to campaign/product spend or called incremental.

CREATE TABLE ads.daily_ad_group (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    business_date date NOT NULL,
    campaign_id text NOT NULL,
    ad_group_id text NOT NULL,
    campaign_name text,
    ad_group_name text,
    ad_status text,
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    spend numeric(18,4) NOT NULL DEFAULT 0,
    attributed_sales numeric(18,4) NOT NULL DEFAULT 0,
    purchases bigint NOT NULL DEFAULT 0,
    attributed_sales_same_sku numeric(18,4),
    purchases_same_sku bigint,
    currency char(3) NOT NULL DEFAULT 'MXN',
    attribution_method text NOT NULL DEFAULT 'click',
    attribution_window text NOT NULL,
    source_report_id text NOT NULL,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id,business_date,campaign_id,ad_group_id)
);

CREATE INDEX ads_daily_ad_group_date_idx
    ON ads.daily_ad_group(account_id,business_date DESC);

CREATE TABLE ads.daily_placement (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    business_date date NOT NULL,
    campaign_id text NOT NULL,
    placement text NOT NULL,
    campaign_name text,
    impressions bigint NOT NULL DEFAULT 0,
    clicks bigint NOT NULL DEFAULT 0,
    spend numeric(18,4) NOT NULL DEFAULT 0,
    attributed_sales numeric(18,4) NOT NULL DEFAULT 0,
    purchases bigint NOT NULL DEFAULT 0,
    attributed_sales_same_sku numeric(18,4),
    purchases_same_sku bigint,
    campaign_bidding_strategy text,
    campaign_budget numeric(18,4),
    campaign_budget_type text,
    campaign_rule_based_budget numeric(18,4),
    applicable_budget_rule_id text,
    applicable_budget_rule_name text,
    top_of_search_impression_share numeric(18,10),
    currency char(3) NOT NULL DEFAULT 'MXN',
    attribution_method text NOT NULL DEFAULT 'click',
    attribution_window text NOT NULL,
    source_report_id text NOT NULL,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id,business_date,campaign_id,placement)
);

CREATE INDEX ads_daily_placement_date_idx
    ON ads.daily_placement(account_id,business_date DESC);

CREATE TABLE ads.daily_purchased_product (
    account_id text NOT NULL REFERENCES ads.account(account_id) ON DELETE CASCADE,
    business_date date NOT NULL,
    campaign_id text NOT NULL,
    ad_group_id text NOT NULL DEFAULT '',
    target_id text NOT NULL DEFAULT '',
    advertised_sku text NOT NULL DEFAULT '',
    advertised_asin text NOT NULL DEFAULT '',
    purchased_asin text NOT NULL,
    campaign_name text,
    keyword text,
    keyword_type text,
    match_type text,
    purchases bigint NOT NULL DEFAULT 0,
    attributed_sales numeric(18,4) NOT NULL DEFAULT 0,
    purchases_other_sku bigint,
    attributed_sales_other_sku numeric(18,4),
    units_other_sku bigint,
    currency char(3) NOT NULL DEFAULT 'MXN',
    attribution_method text NOT NULL DEFAULT 'click',
    attribution_window text NOT NULL,
    source_report_id text NOT NULL,
    source_generated_at timestamptz,
    ingested_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (
        account_id,business_date,campaign_id,ad_group_id,target_id,
        advertised_sku,advertised_asin,purchased_asin
    )
);

CREATE INDEX ads_daily_purchased_product_advertised_idx
    ON ads.daily_purchased_product(
        account_id,advertised_sku,advertised_asin,business_date DESC
    );

CREATE INDEX ads_daily_purchased_product_purchased_idx
    ON ads.daily_purchased_product(account_id,purchased_asin,business_date DESC);

COMMENT ON TABLE ads.daily_ad_group IS
'Independent Sponsored Products ad-group attributed-performance grain. It is reconciled to campaign spend and never added to it.';

COMMENT ON TABLE ads.daily_placement IS
'Independent Sponsored Products campaign-placement attributed-performance grain used to diagnose placement allocation.';

COMMENT ON TABLE ads.daily_purchased_product IS
'Advertised-product to purchased-ASIN Amazon attribution. This is halo evidence, not incremental lift or independently measured seller sales.';

CREATE VIEW mart.ads_campaign_ad_group_spend_reconciliation AS
WITH ad_group AS (
    SELECT
        account_id,business_date,campaign_id,
        sum(spend)::numeric(18,4) AS ad_group_spend,
        count(*)::bigint AS ad_group_rows
    FROM ads.daily_ad_group
    GROUP BY account_id,business_date,campaign_id
)
SELECT
    account.marketplace_id,
    campaign.account_id,
    campaign.business_date,
    campaign.campaign_id,
    campaign.spend::numeric(18,4) AS campaign_spend,
    ad_group.ad_group_spend,
    COALESCE(ad_group.ad_group_rows,0)::bigint AS ad_group_rows,
    (campaign.spend-COALESCE(ad_group.ad_group_spend,0))::numeric(18,4)
        AS unassigned_ad_group_spend,
    CASE
        WHEN ad_group.ad_group_spend IS NULL THEN 'AD_GROUP_GRAIN_MISSING'
        WHEN abs(campaign.spend-ad_group.ad_group_spend) <= 0.01
            THEN 'RECONCILED'
        ELSE 'RESIDUAL'
    END AS reconciliation_state
FROM ads.daily_campaign campaign
JOIN ads.account account USING (account_id)
LEFT JOIN ad_group USING (account_id,business_date,campaign_id);

CREATE VIEW mart.ads_campaign_placement_spend_reconciliation AS
WITH placement AS (
    SELECT
        account_id,business_date,campaign_id,
        sum(spend)::numeric(18,4) AS placement_spend,
        count(*)::bigint AS placement_rows
    FROM ads.daily_placement
    GROUP BY account_id,business_date,campaign_id
)
SELECT
    account.marketplace_id,
    campaign.account_id,
    campaign.business_date,
    campaign.campaign_id,
    campaign.spend::numeric(18,4) AS campaign_spend,
    placement.placement_spend,
    COALESCE(placement.placement_rows,0)::bigint AS placement_rows,
    (campaign.spend-COALESCE(placement.placement_spend,0))::numeric(18,4)
        AS unassigned_placement_spend,
    CASE
        WHEN placement.placement_spend IS NULL THEN 'PLACEMENT_GRAIN_MISSING'
        WHEN abs(campaign.spend-placement.placement_spend) <= 0.01
            THEN 'RECONCILED'
        ELSE 'RESIDUAL'
    END AS reconciliation_state
FROM ads.daily_campaign campaign
JOIN ads.account account USING (account_id)
LEFT JOIN placement USING (account_id,business_date,campaign_id);

CREATE VIEW mart.ads_account_granular_spend_reconciliation AS
WITH grain AS (
    SELECT
        marketplace_id,account_id,business_date,campaign_id,
        'AD_GROUP'::text AS report_grain,
        campaign_spend,ad_group_spend AS grain_spend,
        unassigned_ad_group_spend AS unassigned_spend,
        reconciliation_state
    FROM mart.ads_campaign_ad_group_spend_reconciliation
    UNION ALL
    SELECT
        marketplace_id,account_id,business_date,campaign_id,
        'PLACEMENT'::text AS report_grain,
        campaign_spend,placement_spend AS grain_spend,
        unassigned_placement_spend AS unassigned_spend,
        reconciliation_state
    FROM mart.ads_campaign_placement_spend_reconciliation
)
SELECT
    marketplace_id,account_id,business_date,report_grain,
    sum(campaign_spend)::numeric(18,4) AS campaign_spend,
    sum(grain_spend)::numeric(18,4) AS grain_spend,
    sum(unassigned_spend)::numeric(18,4) AS unassigned_spend,
    count(*)::bigint AS campaigns,
    count(*) FILTER (WHERE reconciliation_state='RECONCILED')::bigint
        AS reconciled_campaigns,
    count(*) FILTER (WHERE reconciliation_state<>'RECONCILED')::bigint
        AS unreconciled_campaigns,
    CASE
        WHEN count(*) FILTER (WHERE reconciliation_state<>'RECONCILED')=0
            THEN 'RECONCILED'
        WHEN count(*) FILTER (WHERE reconciliation_state LIKE '%_MISSING')>0
            THEN 'INCOMPLETE'
        ELSE 'RESIDUAL'
    END AS reconciliation_state
FROM grain
GROUP BY marketplace_id,account_id,business_date,report_grain;

COMMENT ON VIEW mart.ads_campaign_ad_group_spend_reconciliation IS
'Exact campaign-to-ad-group spend comparison at account/campaign/day grain. Missing rows and residual spend remain explicit and are never allocated.';

COMMENT ON VIEW mart.ads_campaign_placement_spend_reconciliation IS
'Exact campaign-to-placement spend comparison at account/campaign/day grain. Missing rows and residual spend remain explicit and are never allocated.';

COMMENT ON VIEW mart.ads_account_granular_spend_reconciliation IS
'Account/day readiness for independent ad-group and placement report grains. Purchased-product attribution is excluded because it is not an independent spend total.';
