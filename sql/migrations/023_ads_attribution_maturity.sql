-- Attribution maturity must be driven by the reporting contract, not a hard-coded
-- seven-day assumption in business/product marts. Sponsored Products seller
-- reporting currently uses a 7-day click window; future ad products/accounts may not.
--
-- IMPORTANT: PostgreSQL CREATE OR REPLACE VIEW requires all existing columns to
-- retain their names/order. New maturity metadata is therefore appended after the
-- established view contract rather than inserted between existing columns.

CREATE OR REPLACE FUNCTION ads.attribution_window_days(window_text text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN window_text IS NULL OR btrim(window_text) = '' THEN NULL
    WHEN lower(window_text) ~ '(^|[^0-9])([0-9]+)d([^a-z]|$)'
      THEN (regexp_match(lower(window_text), '(^|[^0-9])([0-9]+)d([^a-z]|$)'))[2]::integer
    WHEN lower(window_text) ~ '(^|[^0-9])([0-9]+)[ _-]*day'
      THEN (regexp_match(lower(window_text), '(^|[^0-9])([0-9]+)[ _-]*day'))[2]::integer
    ELSE NULL
  END;
$$;

COMMENT ON FUNCTION ads.attribution_window_days(text) IS
'Parses the explicit Ads reporting attribution-window label into calendar days. Returns NULL for unknown/unparseable contracts so consumers cannot silently assume maturity.';

CREATE OR REPLACE VIEW mart.ads_business_daily AS
WITH ads_day AS (
    SELECT
        a.marketplace_id,
        d.business_date,
        count(DISTINCT d.account_id)::int AS advertiser_accounts,
        sum(d.impressions)::bigint AS impressions,
        sum(d.clicks)::bigint AS clicks,
        sum(d.spend)::numeric(16,4) AS ad_spend,
        sum(d.attributed_sales)::numeric(16,4) AS attributed_sales,
        sum(d.purchases)::bigint AS attributed_purchases,
        sum(d.units)::bigint AS attributed_units,
        max(d.source_generated_at) AS ads_source_generated_at,
        max(d.ingested_at) AS ads_ingested_at,
        string_agg(DISTINCT nullif(d.attribution_method,''), ', ' ORDER BY nullif(d.attribution_method,'')) AS attribution_method,
        string_agg(DISTINCT nullif(d.attribution_window,''), ', ' ORDER BY nullif(d.attribution_window,'')) AS attribution_window,
        max(ads.attribution_window_days(d.attribution_window)) AS attribution_window_days,
        bool_and(ads.attribution_window_days(d.attribution_window) IS NOT NULL) AS attribution_window_known
    FROM ads.daily_account d
    JOIN ads.account a USING (account_id)
    WHERE a.marketplace_id IS NOT NULL
    GROUP BY a.marketplace_id, d.business_date
), latest AS (
    SELECT marketplace_id, max(business_date) AS ads_through_date
    FROM ads_day
    GROUP BY marketplace_id
)
SELECT
    -- Existing contract from 016_ads_business_context.sql. Do not reorder.
    ad.marketplace_id,
    ad.business_date,
    ad.advertiser_accounts,
    ad.impressions,
    ad.clicks,
    ad.ad_spend,
    ad.attributed_sales,
    ad.attributed_purchases,
    ad.attributed_units,
    b.sales::numeric(16,4) AS total_business_sales,
    b.orders::bigint AS total_business_orders,
    b.units::bigint AS total_business_units,
    CASE WHEN ad.impressions > 0 THEN ad.clicks::numeric / ad.impressions END AS ctr,
    CASE WHEN ad.clicks > 0 THEN ad.ad_spend / ad.clicks END AS cpc,
    CASE WHEN ad.ad_spend > 0 THEN ad.attributed_sales / ad.ad_spend END AS roas,
    CASE WHEN ad.attributed_sales > 0 THEN ad.ad_spend / ad.attributed_sales END AS acos,
    CASE WHEN b.sales > 0 THEN ad.ad_spend / b.sales END AS tacos,
    CASE WHEN b.sales > 0 THEN ad.attributed_sales / b.sales END AS attributed_sales_share,
    ad.attribution_method,
    ad.attribution_window,
    ad.ads_source_generated_at,
    ad.ads_ingested_at,
    l.ads_through_date,
    CASE WHEN ad.attribution_window_known
         THEN ad.business_date <= l.ads_through_date - ad.attribution_window_days
         ELSE false END AS attribution_mature,
    CASE
      WHEN NOT ad.attribution_window_known THEN 'UNKNOWN'
      WHEN ad.business_date <= l.ads_through_date - ad.attribution_window_days THEN 'MATURE'
      ELSE 'PROVISIONAL'
    END AS attribution_state,
    -- New metadata is append-only to preserve CREATE OR REPLACE compatibility.
    ad.attribution_window_days,
    CASE WHEN ad.attribution_window_known
         THEN l.ads_through_date - ad.attribution_window_days END AS mature_through_date
FROM ads_day ad
JOIN latest l USING (marketplace_id)
LEFT JOIN mart.business_daily b
  ON b.marketplace_id=ad.marketplace_id
 AND b.business_date=ad.business_date
 AND b.reconciled_daily_report;

COMMENT ON VIEW mart.ads_business_daily IS
'Amazon Ads daily facts aligned to independent reconciled seller sales. TACOS uses total business sales. Attribution maturity is derived from the explicit reporting attribution window; unknown contracts remain UNKNOWN rather than assuming seven days. attributed_sales is attribution and MUST NOT be presented as exact incremental/organic sales.';

CREATE OR REPLACE VIEW mart.ads_product_business_daily AS
WITH ads_product AS (
    SELECT
        a.marketplace_id,
        p.business_date,
        nullif(p.advertised_sku,'') AS sku,
        nullif(p.advertised_asin,'') AS asin,
        count(DISTINCT p.account_id)::int AS advertiser_accounts,
        count(DISTINCT p.campaign_id)::int AS campaigns,
        sum(p.impressions)::bigint AS impressions,
        sum(p.clicks)::bigint AS clicks,
        sum(p.spend)::numeric(16,4) AS ad_spend,
        sum(p.attributed_sales)::numeric(16,4) AS attributed_sales,
        sum(p.purchases)::bigint AS attributed_purchases,
        sum(p.units)::bigint AS attributed_units,
        max(p.source_generated_at) AS ads_source_generated_at,
        max(p.ingested_at) AS ads_ingested_at,
        string_agg(DISTINCT nullif(p.attribution_method,''), ', ' ORDER BY nullif(p.attribution_method,'')) AS attribution_method,
        string_agg(DISTINCT nullif(p.attribution_window,''), ', ' ORDER BY nullif(p.attribution_window,'')) AS attribution_window,
        max(ads.attribution_window_days(p.attribution_window)) AS attribution_window_days,
        bool_and(ads.attribution_window_days(p.attribution_window) IS NOT NULL) AS attribution_window_known
    FROM ads.daily_advertised_product p
    JOIN ads.account a USING (account_id)
    WHERE a.marketplace_id IS NOT NULL
      AND (nullif(p.advertised_sku,'') IS NOT NULL OR nullif(p.advertised_asin,'') IS NOT NULL)
    GROUP BY a.marketplace_id,p.business_date,nullif(p.advertised_sku,''),nullif(p.advertised_asin,'')
), latest AS (
    SELECT marketplace_id,max(business_date) AS ads_through_date
    FROM ads_product GROUP BY marketplace_id
), seller_product AS (
    SELECT marketplace_id,business_date,seller_sku AS sku,max(asin) AS asin,
           COALESCE(sum(ordered_product_sales),0)::numeric(16,4) AS total_business_sales,
           COALESCE(sum(total_order_items),0)::bigint AS total_business_orders,
           COALESCE(sum(units_ordered),0)::bigint AS total_business_units
    FROM core.sku_sales_traffic_daily
    GROUP BY marketplace_id,business_date,seller_sku
)
SELECT
    -- Existing contract from 017_ads_product_business_context.sql. Do not reorder.
    p.marketplace_id,
    p.business_date,
    p.sku,
    p.asin,
    p.advertiser_accounts,
    p.campaigns,
    p.impressions,
    p.clicks,
    p.ad_spend,
    p.attributed_sales,
    p.attributed_purchases,
    p.attributed_units,
    s.total_business_sales,
    s.total_business_orders,
    s.total_business_units,
    CASE WHEN p.impressions>0 THEN p.clicks::numeric/p.impressions END AS ctr,
    CASE WHEN p.clicks>0 THEN p.ad_spend/p.clicks END AS cpc,
    CASE WHEN p.ad_spend>0 THEN p.attributed_sales/p.ad_spend END AS roas,
    CASE WHEN p.attributed_sales>0 THEN p.ad_spend/p.attributed_sales END AS acos,
    CASE WHEN s.total_business_sales>0 THEN p.ad_spend/s.total_business_sales END AS tacos,
    CASE WHEN s.total_business_sales>0 THEN p.attributed_sales/s.total_business_sales END AS attributed_sales_share,
    p.attribution_method,
    p.attribution_window,
    p.ads_source_generated_at,
    p.ads_ingested_at,
    l.ads_through_date,
    CASE WHEN p.attribution_window_known
         THEN p.business_date<=l.ads_through_date-p.attribution_window_days
         ELSE false END AS attribution_mature,
    CASE
      WHEN NOT p.attribution_window_known THEN 'UNKNOWN'
      WHEN p.business_date<=l.ads_through_date-p.attribution_window_days THEN 'MATURE'
      ELSE 'PROVISIONAL'
    END AS attribution_state,
    -- New metadata is append-only to preserve CREATE OR REPLACE compatibility.
    p.attribution_window_days,
    CASE WHEN p.attribution_window_known
         THEN l.ads_through_date-p.attribution_window_days END AS mature_through_date
FROM ads_product p
JOIN latest l USING (marketplace_id)
LEFT JOIN seller_product s
  ON s.marketplace_id=p.marketplace_id
 AND s.business_date=p.business_date
 AND (s.sku=p.sku OR (p.sku IS NULL AND s.asin=p.asin));

COMMENT ON VIEW mart.ads_product_business_daily IS
'Product-level Amazon Ads context aligned to independent seller sales. Attribution maturity is metadata-driven; unknown windows remain UNKNOWN. attributed_sales is not incremental sales and the residual is not exact organic sales.';
