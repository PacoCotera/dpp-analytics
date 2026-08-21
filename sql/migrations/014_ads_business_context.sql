-- Canonical Ads <-> seller-business context.
-- Consumers should use these marts rather than independently joining raw Ads facts.
-- Amazon-attributed sales are attribution facts, not incremental/organic truth.

CREATE OR REPLACE VIEW mart.ads_business_daily AS
WITH ads_day AS (
    SELECT
        a.marketplace_id,
        d.business_date,
        sum(d.impressions)::bigint AS impressions,
        sum(d.clicks)::bigint AS clicks,
        sum(d.spend)::numeric(16,2) AS spend,
        sum(d.attributed_sales)::numeric(16,2) AS attributed_sales,
        sum(d.purchases)::bigint AS purchases,
        sum(d.units)::bigint AS attributed_units,
        count(DISTINCT d.account_id)::int AS advertiser_accounts,
        max(d.source_generated_at) AS source_generated_at,
        max(d.ingested_at) AS ingested_at,
        string_agg(DISTINCT NULLIF(d.attribution_method,''), ', ' ORDER BY NULLIF(d.attribution_method,'')) AS attribution_method,
        string_agg(DISTINCT NULLIF(d.attribution_window,''), ', ' ORDER BY NULLIF(d.attribution_window,'')) AS attribution_window
    FROM ads.daily_account d
    JOIN ads.account a USING (account_id)
    GROUP BY a.marketplace_id, d.business_date
),
seller_day AS (
    SELECT marketplace_id, business_date,
           sum(sales)::numeric(16,2) AS seller_sales,
           sum(orders)::bigint AS seller_orders,
           sum(units)::bigint AS seller_units
    FROM mart.sku_daily
    GROUP BY marketplace_id, business_date
),
joined AS (
    SELECT
        COALESCE(s.marketplace_id,a.marketplace_id) AS marketplace_id,
        COALESCE(s.business_date,a.business_date) AS business_date,
        COALESCE(a.impressions,0)::bigint AS impressions,
        COALESCE(a.clicks,0)::bigint AS clicks,
        COALESCE(a.spend,0)::numeric(16,2) AS spend,
        COALESCE(a.attributed_sales,0)::numeric(16,2) AS attributed_sales,
        COALESCE(a.purchases,0)::bigint AS purchases,
        COALESCE(a.attributed_units,0)::bigint AS attributed_units,
        COALESCE(s.seller_sales,0)::numeric(16,2) AS seller_sales,
        COALESCE(s.seller_orders,0)::bigint AS seller_orders,
        COALESCE(s.seller_units,0)::bigint AS seller_units,
        COALESCE(a.advertiser_accounts,0)::int AS advertiser_accounts,
        a.attribution_method,a.attribution_window,a.source_generated_at,a.ingested_at
    FROM seller_day s
    FULL OUTER JOIN ads_day a USING (marketplace_id,business_date)
), cutoff AS (
    SELECT marketplace_id,max(business_date) AS latest_date FROM joined GROUP BY marketplace_id
)
SELECT j.*,
       CASE WHEN impressions>0 THEN clicks::numeric/impressions END AS ctr,
       CASE WHEN clicks>0 THEN spend/clicks END AS cpc,
       CASE WHEN spend>0 THEN attributed_sales/spend END AS roas,
       CASE WHEN attributed_sales>0 THEN spend/attributed_sales END AS acos,
       CASE WHEN seller_sales>0 THEN spend/seller_sales END AS tacos,
       CASE WHEN j.business_date > c.latest_date-7 THEN 'PROVISIONAL' ELSE 'MATURE' END AS attribution_maturity,
       CASE WHEN j.source_generated_at IS NULL THEN 'NO_ADS_SOURCE'
            WHEN now()-j.source_generated_at > interval '36 hours' THEN 'STALE'
            ELSE 'CURRENT' END AS freshness_state
FROM joined j JOIN cutoff c USING (marketplace_id);

COMMENT ON VIEW mart.ads_business_daily IS
'Canonical daily advertising + independent seller-sales context. attributed_sales is Amazon-attributed revenue; seller_sales-attributed_sales MUST NOT be labelled exact organic or incremental sales.';

CREATE OR REPLACE VIEW mart.ads_business_t28 AS
WITH cutoff AS (
    SELECT marketplace_id,max(business_date) AS cutoff_date FROM mart.ads_business_daily GROUP BY marketplace_id
)
SELECT d.marketplace_id,c.cutoff_date,
       sum(d.impressions)::bigint AS impressions,
       sum(d.clicks)::bigint AS clicks,
       sum(d.spend)::numeric(16,2) AS spend,
       sum(d.attributed_sales)::numeric(16,2) AS attributed_sales,
       sum(d.purchases)::bigint AS purchases,
       sum(d.attributed_units)::bigint AS attributed_units,
       sum(d.seller_sales)::numeric(16,2) AS seller_sales,
       sum(d.seller_orders)::bigint AS seller_orders,
       sum(d.seller_units)::bigint AS seller_units,
       CASE WHEN sum(d.impressions)>0 THEN sum(d.clicks)::numeric/sum(d.impressions) END AS ctr,
       CASE WHEN sum(d.clicks)>0 THEN sum(d.spend)/sum(d.clicks) END AS cpc,
       CASE WHEN sum(d.spend)>0 THEN sum(d.attributed_sales)/sum(d.spend) END AS roas,
       CASE WHEN sum(d.attributed_sales)>0 THEN sum(d.spend)/sum(d.attributed_sales) END AS acos,
       CASE WHEN sum(d.seller_sales)>0 THEN sum(d.spend)/sum(d.seller_sales) END AS tacos,
       max(d.source_generated_at) AS source_generated_at,
       bool_or(d.attribution_maturity='PROVISIONAL') AS contains_provisional_attribution
FROM mart.ads_business_daily d JOIN cutoff c USING (marketplace_id)
WHERE d.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date
GROUP BY d.marketplace_id,c.cutoff_date;

CREATE OR REPLACE VIEW mart.ads_product_t28 AS
WITH cutoff AS (
    SELECT a.marketplace_id,max(d.business_date) AS cutoff_date
    FROM ads.daily_advertised_product d JOIN ads.account a USING(account_id)
    GROUP BY a.marketplace_id
), ads_product AS (
    SELECT a.marketplace_id,d.advertised_sku AS seller_sku,max(NULLIF(d.advertised_asin,'')) AS asin,
           sum(d.impressions)::bigint AS impressions,sum(d.clicks)::bigint AS clicks,
           sum(d.spend)::numeric(16,2) AS spend,sum(d.attributed_sales)::numeric(16,2) AS attributed_sales,
           sum(d.purchases)::bigint AS purchases,sum(d.units)::bigint AS attributed_units,
           max(d.source_generated_at) AS source_generated_at
    FROM ads.daily_advertised_product d JOIN ads.account a USING(account_id) JOIN cutoff c USING(marketplace_id)
    WHERE d.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date AND NULLIF(d.advertised_sku,'') IS NOT NULL
    GROUP BY a.marketplace_id,d.advertised_sku
), seller_product AS (
    SELECT s.marketplace_id,s.seller_sku,max(s.asin) AS asin,sum(s.sales)::numeric(16,2) AS seller_sales,
           sum(s.orders)::bigint AS seller_orders,sum(s.units)::bigint AS seller_units
    FROM mart.sku_daily s JOIN cutoff c USING(marketplace_id)
    WHERE s.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date GROUP BY s.marketplace_id,s.seller_sku
)
SELECT COALESCE(s.marketplace_id,a.marketplace_id) AS marketplace_id,
       COALESCE(s.seller_sku,a.seller_sku) AS seller_sku,COALESCE(s.asin,a.asin) AS asin,
       COALESCE(a.impressions,0)::bigint AS impressions,COALESCE(a.clicks,0)::bigint AS clicks,
       COALESCE(a.spend,0)::numeric(16,2) AS spend,COALESCE(a.attributed_sales,0)::numeric(16,2) AS attributed_sales,
       COALESCE(a.purchases,0)::bigint AS purchases,COALESCE(a.attributed_units,0)::bigint AS attributed_units,
       COALESCE(s.seller_sales,0)::numeric(16,2) AS seller_sales,COALESCE(s.seller_orders,0)::bigint AS seller_orders,COALESCE(s.seller_units,0)::bigint AS seller_units,
       CASE WHEN a.impressions>0 THEN a.clicks::numeric/a.impressions END AS ctr,
       CASE WHEN a.clicks>0 THEN a.spend/a.clicks END AS cpc,
       CASE WHEN a.spend>0 THEN a.attributed_sales/a.spend END AS roas,
       CASE WHEN a.attributed_sales>0 THEN a.spend/a.attributed_sales END AS acos,
       CASE WHEN s.seller_sales>0 THEN a.spend/s.seller_sales END AS tacos,
       a.source_generated_at
FROM seller_product s FULL OUTER JOIN ads_product a USING(marketplace_id,seller_sku);

COMMENT ON VIEW mart.ads_product_t28 IS
'Product-level 28-day Ads context. TACOS uses independent seller sales. Difference between seller_sales and attributed_sales is not exact organic sales.';

-- Finance advertising has an accounting clock, not a rolling-window clock.
-- Until Ads API data is complete/mature, a RELEASED ProductAdsPayment posted in the following
-- calendar month is the explicit temporary close bridge for the prior business month.
CREATE OR REPLACE VIEW mart.finance_advertising_month_basis AS
WITH ads_month AS (
    SELECT a.marketplace_id,date_trunc('month',d.business_date)::date AS month,
           sum(d.spend)::numeric(16,2) AS ads_api_accrual,
           max(d.source_generated_at) AS source_generated_at,
           bool_or(d.business_date > (date_trunc('month',d.business_date)+interval '1 month-1 day')::date-7) AS has_provisional_days
    FROM ads.daily_account d JOIN ads.account a USING(account_id)
    GROUP BY a.marketplace_id,date_trunc('month',d.business_date)::date
), bridge AS (
    SELECT marketplace_id,(date_trunc('month',posted_date AT TIME ZONE 'America/Mexico_City')-interval '1 month')::date AS month,
           abs(sum(total_amount))::numeric(16,2) AS released_product_ads_payment,
           max(posted_date) AS bridge_posted_at
    FROM core.financial_transaction
    WHERE transaction_status='RELEASED' AND transaction_type='ProductAdsPayment' AND posted_date IS NOT NULL
    GROUP BY marketplace_id,(date_trunc('month',posted_date AT TIME ZONE 'America/Mexico_City')-interval '1 month')::date
), months AS (
    SELECT marketplace_id,month FROM ads_month UNION SELECT marketplace_id,month FROM bridge UNION SELECT marketplace_id,month FROM core.finance_month_close
), latest_close AS (
    SELECT * FROM mart.finance_month_close_latest
)
SELECT m.marketplace_id,m.month,a.ads_api_accrual,b.released_product_ads_payment,b.bridge_posted_at,a.source_generated_at,
       CASE WHEN a.ads_api_accrual IS NOT NULL AND NOT COALESCE(a.has_provisional_days,true) THEN 'ADS_API_ACCRUAL_READY'
            WHEN b.released_product_ads_payment IS NOT NULL THEN 'BRIDGE_READY' ELSE 'PENDING' END AS advertising_close_state,
       c.version AS management_close_version,c.state AS management_close_state,c.advertising AS frozen_advertising,
       CASE WHEN c.version IS NOT NULL AND a.ads_api_accrual IS NOT NULL AND NOT COALESCE(a.has_provisional_days,true)
                  AND abs(a.ads_api_accrual-c.advertising)>0.01 THEN true ELSE false END AS ads_api_restatement_available
FROM months m LEFT JOIN ads_month a USING(marketplace_id,month) LEFT JOIN bridge b USING(marketplace_id,month)
LEFT JOIN latest_close c USING(marketplace_id,month);

COMMENT ON VIEW mart.finance_advertising_month_basis IS
'Finance-only monthly advertising reconciliation. Closed management snapshots remain immutable; mature Ads API accrual differences are explicit restatement candidates, never silent rewrites.';
