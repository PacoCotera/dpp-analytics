-- Privacy-minimized postal geography for commercial BI.
--
-- Orders v2026 RECIPIENT data contains a full delivery address. DPP retains only
-- state/region, country and postal code on the order fact; recipient name,
-- street lines, city, phone and the recipient payload itself are not persisted.
-- Access to RECIPIENT is separately probed by the geography enrichment job so a
-- missing restricted role can never break the canonical Orders ingestion path.

ALTER TABLE core.amazon_order
    ADD COLUMN IF NOT EXISTS destination_postal_code text;

CREATE INDEX IF NOT EXISTS amazon_order_destination_postal_idx
    ON core.amazon_order (marketplace_id, destination_country_code, destination_postal_code)
    WHERE destination_postal_code IS NOT NULL;

COMMENT ON COLUMN core.amazon_order.destination_postal_code IS
'Postal code extracted from Orders v2026 RECIPIENT solely for aggregate geography. Recipient name, street address, city, phone and recipient payload are not retained.';

CREATE OR REPLACE VIEW mart.order_geography_postal_daily AS
SELECT
    s.business_date,
    s.marketplace_id,
    o.destination_country_code AS country_code,
    nullif(btrim(o.destination_state_or_region),'') AS state_or_region,
    nullif(btrim(o.destination_postal_code),'') AS postal_code,
    COALESCE(sum(s.customer_spend),0)::numeric(14,2) AS sales,
    count(*)::bigint AS orders,
    COALESCE(sum(s.units),0)::bigint AS units,
    CASE WHEN count(*)>0
         THEN round(COALESCE(sum(s.customer_spend),0)/count(*),2)
         ELSE 0::numeric
    END::numeric(14,2) AS aov
FROM mart.order_customer_spend s
JOIN core.amazon_order o USING (marketplace_id, amazon_order_id)
WHERE nullif(btrim(o.destination_postal_code),'') IS NOT NULL
GROUP BY s.business_date,s.marketplace_id,o.destination_country_code,
         nullif(btrim(o.destination_state_or_region),''),
         nullif(btrim(o.destination_postal_code),'');

COMMENT ON VIEW mart.order_geography_postal_daily IS
'Postal-code demand for aggregate geographic BI. No recipient identity or street address is exposed; money is canonical shopper spend including IVA.';

CREATE OR REPLACE VIEW mart.order_geography_postal_sku_daily AS
SELECT
    x.business_date,
    x.marketplace_id,
    o.destination_country_code AS country_code,
    nullif(btrim(o.destination_state_or_region),'') AS state_or_region,
    nullif(btrim(o.destination_postal_code),'') AS postal_code,
    x.seller_sku,
    max(x.asin) AS asin,
    COALESCE(sum(x.customer_spend),0)::numeric(14,2) AS sales,
    count(DISTINCT x.amazon_order_id)::bigint AS orders,
    COALESCE(sum(x.units),0)::bigint AS units
FROM mart.order_item_customer_spend x
JOIN core.amazon_order o USING (marketplace_id, amazon_order_id)
WHERE nullif(btrim(o.destination_postal_code),'') IS NOT NULL
  AND x.seller_sku IS NOT NULL
GROUP BY x.business_date,x.marketplace_id,o.destination_country_code,
         nullif(btrim(o.destination_state_or_region),''),
         nullif(btrim(o.destination_postal_code),''),x.seller_sku;

COMMENT ON VIEW mart.order_geography_postal_sku_daily IS
'Postal-code product mix for aggregate geographic BI, keyed by seller SKU. No recipient identity or street address is exposed.';
