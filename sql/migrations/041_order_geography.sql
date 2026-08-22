-- Privacy-safe order geography for state-level commercial BI.
--
-- Orders API v2026-01-01 can return recipient data when includedData=RECIPIENT.
-- DPP does not retain recipient names, street address, phone, postal code, or the
-- recipient payload itself. Only coarse destination state/region and country are
-- persisted on the order fact for aggregate geographic analysis.

ALTER TABLE core.amazon_order
    ADD COLUMN IF NOT EXISTS destination_state_or_region text,
    ADD COLUMN IF NOT EXISTS destination_country_code char(2);

CREATE INDEX IF NOT EXISTS amazon_order_destination_state_idx
    ON core.amazon_order (marketplace_id, destination_country_code, destination_state_or_region)
    WHERE destination_state_or_region IS NOT NULL;

COMMENT ON COLUMN core.amazon_order.destination_state_or_region IS
'Coarse recipient state/region from Orders v2026 RECIPIENT data. No recipient name, street address, phone, or postal code is retained.';

COMMENT ON COLUMN core.amazon_order.destination_country_code IS
'Recipient country code retained only for aggregate geography. No recipient PII is retained.';

CREATE OR REPLACE VIEW mart.order_geography_daily AS
SELECT
    s.business_date,
    s.marketplace_id,
    o.destination_country_code AS country_code,
    nullif(btrim(o.destination_state_or_region),'') AS state_or_region,
    COALESCE(sum(s.customer_spend),0)::numeric(14,2) AS sales,
    count(*)::bigint AS orders,
    COALESCE(sum(s.units),0)::bigint AS units
FROM mart.order_customer_spend s
JOIN core.amazon_order o USING (marketplace_id, amazon_order_id)
WHERE nullif(btrim(o.destination_state_or_region),'') IS NOT NULL
GROUP BY s.business_date,s.marketplace_id,o.destination_country_code,nullif(btrim(o.destination_state_or_region),'');

COMMENT ON VIEW mart.order_geography_daily IS
'Privacy-safe state/region-level order demand. Money uses canonical shopper spend including IVA; customer address/recipient PII is not stored.';
