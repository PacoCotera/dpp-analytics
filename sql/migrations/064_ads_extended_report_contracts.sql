-- Retain the decision-relevant columns proven available in the Batch 0
-- production report probes. Same-SKU and other-SKU attribution stay explicit;
-- none of these fields represent incrementality.

ALTER TABLE ads.daily_campaign
    ADD COLUMN attributed_sales_same_sku numeric(18,4),
    ADD COLUMN purchases_same_sku bigint,
    ADD COLUMN campaign_bidding_strategy text,
    ADD COLUMN campaign_budget numeric(18,4),
    ADD COLUMN campaign_budget_type text,
    ADD COLUMN campaign_rule_based_budget numeric(18,4),
    ADD COLUMN applicable_budget_rule_id text,
    ADD COLUMN applicable_budget_rule_name text,
    ADD COLUMN top_of_search_impression_share numeric(18,10);

ALTER TABLE ads.daily_advertised_product
    ADD COLUMN ad_id text,
    ADD COLUMN portfolio_id text,
    ADD COLUMN attributed_sales_same_sku numeric(18,4),
    ADD COLUMN purchases_same_sku bigint,
    ADD COLUMN attributed_sales_other_sku numeric(18,4),
    ADD COLUMN units_other_sku bigint,
    ADD COLUMN campaign_budget numeric(18,4),
    ADD COLUMN campaign_budget_type text,
    ADD COLUMN campaign_status text;

ALTER TABLE ads.daily_target
    ADD COLUMN keyword_bid numeric(18,4),
    ADD COLUMN target_status text,
    ADD COLUMN portfolio_id text,
    ADD COLUMN attributed_sales_same_sku numeric(18,4),
    ADD COLUMN purchases_same_sku bigint,
    ADD COLUMN attributed_sales_other_sku numeric(18,4),
    ADD COLUMN units_other_sku bigint,
    ADD COLUMN top_of_search_impression_share numeric(18,10);

ALTER TABLE ads.daily_search_term
    ADD COLUMN keyword_bid numeric(18,4),
    ADD COLUMN target_status text,
    ADD COLUMN portfolio_id text,
    ADD COLUMN attributed_sales_same_sku numeric(18,4),
    ADD COLUMN purchases_same_sku bigint,
    ADD COLUMN attributed_sales_other_sku numeric(18,4),
    ADD COLUMN units_other_sku bigint;

CREATE OR REPLACE VIEW mart.ads_campaign_product_spend_reconciliation AS
WITH product AS (
    SELECT
        account_id,business_date,campaign_id,
        sum(spend)::numeric(18,4) AS product_spend,
        count(*)::bigint AS product_rows
    FROM ads.daily_advertised_product
    GROUP BY account_id,business_date,campaign_id
)
SELECT
    account.marketplace_id,
    campaign.account_id,
    campaign.business_date,
    campaign.campaign_id,
    campaign.spend::numeric(18,4) AS campaign_spend,
    product.product_spend,
    COALESCE(product.product_rows,0)::bigint AS product_rows,
    (campaign.spend-COALESCE(product.product_spend,0))::numeric(18,4)
        AS unassigned_product_spend,
    CASE
        WHEN product.product_spend IS NULL THEN 'PRODUCT_GRAIN_MISSING'
        WHEN abs(campaign.spend-product.product_spend) <= 0.01 THEN 'RECONCILED'
        ELSE 'RESIDUAL'
    END AS reconciliation_state
FROM ads.daily_campaign campaign
JOIN ads.account account USING (account_id)
LEFT JOIN product USING (account_id,business_date,campaign_id);

CREATE OR REPLACE VIEW mart.ads_account_product_spend_reconciliation AS
SELECT
    marketplace_id,
    account_id,
    business_date,
    sum(campaign_spend)::numeric(18,4) AS campaign_spend,
    sum(product_spend)::numeric(18,4) AS product_spend,
    sum(unassigned_product_spend)::numeric(18,4) AS unassigned_product_spend,
    count(*)::bigint AS campaigns,
    count(*) FILTER (WHERE reconciliation_state='RECONCILED')::bigint
        AS reconciled_campaigns,
    count(*) FILTER (WHERE reconciliation_state='PRODUCT_GRAIN_MISSING')::bigint
        AS missing_product_campaigns,
    count(*) FILTER (WHERE reconciliation_state='RESIDUAL')::bigint
        AS residual_campaigns,
    CASE
        WHEN count(*) FILTER (WHERE reconciliation_state<>'RECONCILED')=0
            THEN 'RECONCILED'
        WHEN count(*) FILTER (WHERE reconciliation_state='PRODUCT_GRAIN_MISSING')>0
            THEN 'INCOMPLETE'
        ELSE 'RESIDUAL'
    END AS reconciliation_state
FROM mart.ads_campaign_product_spend_reconciliation
GROUP BY marketplace_id,account_id,business_date;

COMMENT ON VIEW mart.ads_campaign_product_spend_reconciliation IS
'Exact campaign-to-advertised-product spend comparison at account/campaign/day grain. A residual is retained and never allocated in proportion to sales or units.';

COMMENT ON VIEW mart.ads_account_product_spend_reconciliation IS
'Account/day rollup of campaign-to-product spend reconciliation. Product economics cannot be RECONCILED while product-grain spend is missing or residual.';

COMMENT ON COLUMN ads.daily_campaign.attributed_sales_same_sku IS
'Amazon-attributed same-SKU sales under the declared attribution window; not incremental sales.';

COMMENT ON COLUMN ads.daily_advertised_product.attributed_sales_other_sku IS
'Amazon-attributed other-SKU sales (halo evidence); not incremental sales and not product seller revenue.';
