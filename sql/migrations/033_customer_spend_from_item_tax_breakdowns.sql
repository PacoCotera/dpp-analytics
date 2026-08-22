-- Correct shopper-spend basis using the transaction's explicit revenue/tax components.
--
-- Production evidence showed that Orders v2026 product.price.unitPrice for DPP MX
-- can be tax-exclusive. It is therefore not sufficient to label unitPrice x quantity
-- as shopper spend. PROCEEDS carries ITEM and TAX as separate revenue components
-- when tax is broken out. If TAX is absent, Amazon may already include tax in ITEM;
-- in that case ITEM is used as-is. Settlement fees are not part of this view.
--
-- This keeps every order on one basis: customer product spend including IVA.
-- Shipping is intentionally separate from product sales and is not added here.

CREATE OR REPLACE VIEW mart.order_item_customer_spend AS
SELECT
    o.marketplace_id,
    o.amazon_order_id,
    (o.created_time AT TIME ZONE m.timezone)::date AS business_date,
    o.created_time,
    i.seller_sku,
    i.asin,
    COALESCE(i.quantity_ordered,0)::bigint AS units,
    CASE
      WHEN i.proceeds_item_amount IS NOT NULL AND i.proceeds_tax_amount IS NOT NULL
        THEN i.proceeds_item_amount + i.proceeds_tax_amount
      WHEN i.proceeds_item_amount IS NOT NULL
        THEN i.proceeds_item_amount
      ELSE COALESCE(i.proceeds_total_amount, i.unit_price_amount * i.quantity_ordered, 0)
    END::numeric(14,2) AS customer_spend,
    CASE
      WHEN i.proceeds_item_amount IS NOT NULL AND i.proceeds_tax_amount IS NOT NULL THEN 'PROCEEDS_ITEM_PLUS_TAX'
      WHEN i.proceeds_item_amount IS NOT NULL THEN 'PROCEEDS_ITEM_TAX_EMBEDDED_OR_UNAVAILABLE'
      WHEN i.proceeds_total_amount IS NOT NULL THEN 'PROCEEDS_TOTAL_FALLBACK'
      WHEN i.unit_price_amount IS NOT NULL THEN 'UNIT_PRICE_FALLBACK'
      ELSE 'NO_AMOUNT'
    END::text AS customer_spend_source,
    COALESCE(o.fulfillment_status,'') AS fulfillment_status
FROM core.amazon_order_item i
JOIN core.amazon_order o USING (amazon_order_id)
JOIN core.marketplace m USING (marketplace_id)
WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED';

COMMENT ON VIEW mart.order_item_customer_spend IS
'Item-level customer product spend including explicit tax when Amazon provides TAX separately. ITEM+TAX is authoritative; ITEM alone is used when Amazon does not split tax. Shipping and settlement fees are excluded.';

CREATE OR REPLACE VIEW mart.order_customer_spend AS
WITH item_rollup AS (
    SELECT marketplace_id,amazon_order_id,
           COALESCE(sum(units),0)::bigint AS units,
           COALESCE(sum(customer_spend),0)::numeric(14,2) AS item_customer_spend,
           count(*)::bigint AS item_rows,
           bool_and(customer_spend_source IN ('PROCEEDS_ITEM_PLUS_TAX','PROCEEDS_ITEM_TAX_EMBEDDED_OR_UNAVAILABLE')) AS proceeds_item_complete
    FROM mart.order_item_customer_spend
    GROUP BY marketplace_id,amazon_order_id
)
SELECT
    o.marketplace_id,
    o.amazon_order_id,
    (o.created_time AT TIME ZONE m.timezone)::date AS business_date,
    o.created_time,
    CASE
      WHEN COALESCE(r.item_rows,0)>0 THEN r.item_customer_spend
      ELSE COALESCE(o.grand_total_amount,0)
    END::numeric(14,2) AS customer_spend,
    COALESCE(r.units,COALESCE(o.quantity_fulfilled,0)+COALESCE(o.quantity_unfulfilled,0),0)::bigint AS units,
    COALESCE(o.fulfillment_status,'') AS fulfillment_status,
    CASE
      WHEN COALESCE(r.item_rows,0)>0 AND r.proceeds_item_complete THEN 'ITEM_PROCEEDS_TAX_BASIS'
      WHEN COALESCE(r.item_rows,0)>0 THEN 'ITEM_FALLBACK_BASIS'
      WHEN o.grand_total_amount IS NOT NULL THEN 'ORDER_GRAND_TOTAL_FALLBACK'
      ELSE 'NO_AMOUNT'
    END::text AS customer_spend_source
FROM core.amazon_order o
JOIN core.marketplace m USING (marketplace_id)
LEFT JOIN item_rollup r USING (marketplace_id,amazon_order_id)
WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED';

COMMENT ON VIEW mart.order_customer_spend IS
'Order-level customer product spend on one tax-inclusive basis. Item ITEM+TAX evidence is preferred; order grand total is only used while item detail is absent. Shipping and settlement fees are excluded.';

CREATE OR REPLACE VIEW mart.order_sales_daily AS
SELECT business_date,marketplace_id,
       COALESCE(sum(customer_spend),0)::numeric(14,2) AS sales,
       count(*)::bigint AS orders,
       COALESCE(sum(units),0)::bigint AS units,
       CASE WHEN count(*)>0 THEN (COALESCE(sum(customer_spend),0)/count(*))::numeric(14,2) ELSE 0::numeric END AS aov
FROM mart.order_customer_spend
GROUP BY business_date,marketplace_id;

-- seller-SKU operational velocity inherits the same customer-spend basis; its money
-- is not used as canonical reconciled commercial revenue.
CREATE OR REPLACE VIEW mart.sku_daily AS
WITH order_sku AS (
    SELECT x.business_date,x.marketplace_id,x.seller_sku,max(x.asin) AS asin,
           COALESCE(sum(x.customer_spend),0)::numeric(14,2) AS sales,
           COALESCE(sum(x.units),0)::bigint AS units,
           count(DISTINCT x.amazon_order_id)::bigint AS orders
    FROM mart.order_item_customer_spend x
    WHERE x.seller_sku IS NOT NULL
    GROUP BY x.business_date,x.marketplace_id,x.seller_sku
)
SELECT o.business_date,o.marketplace_id,o.seller_sku,o.asin,o.sales,o.units,o.orders,
       a.sessions,a.page_views,a.unit_session_percentage,a.session_percentage,a.units_refunded
FROM order_sku o
LEFT JOIN core.asin_sales_traffic_daily a
  ON a.business_date=o.business_date AND a.marketplace_id=o.marketplace_id AND a.asin=o.asin;

CREATE OR REPLACE VIEW mart.today_operating AS
WITH orders_local AS (
    SELECT o.marketplace_id,(o.created_time AT TIME ZONE m.timezone) AS local_created,
           o.customer_spend AS sales,o.units
    FROM mart.order_customer_spend o JOIN core.marketplace m USING(marketplace_id)
), clock AS (
    SELECT m.marketplace_id,m.timezone,(CURRENT_TIMESTAMP AT TIME ZONE m.timezone) AS local_now
    FROM core.marketplace m
), today AS (
    SELECT c.marketplace_id,COALESCE(sum(o.sales),0)::numeric(14,2) AS sales_today,
           count(o.local_created)::bigint AS orders_today,COALESCE(sum(o.units),0)::bigint AS units_today
    FROM clock c LEFT JOIN orders_local o
      ON o.marketplace_id=c.marketplace_id AND o.local_created::date=c.local_now::date
    GROUP BY c.marketplace_id
), comparison_days AS (
    SELECT c.marketplace_id,c.local_now,d::date AS business_date
    FROM clock c CROSS JOIN LATERAL generate_series(c.local_now::date-56,c.local_now::date-1,interval '1 day') d
    WHERE extract(isodow FROM d)=extract(isodow FROM c.local_now)
), comparison_daily AS (
    SELECT d.marketplace_id,d.business_date,COALESCE(sum(o.sales),0)::numeric(14,2) AS sales_same_time
    FROM comparison_days d LEFT JOIN orders_local o
      ON o.marketplace_id=d.marketplace_id AND o.local_created::date=d.business_date AND o.local_created::time<=d.local_now::time
    GROUP BY d.marketplace_id,d.business_date
), baseline AS (
    SELECT marketplace_id,avg(sales_same_time)::numeric(14,2) AS same_weekday_same_time_avg
    FROM comparison_daily GROUP BY marketplace_id
)
SELECT t.marketplace_id,t.sales_today,t.orders_today,t.units_today,b.same_weekday_same_time_avg,
       CASE WHEN b.same_weekday_same_time_avg>0
            THEN round(100.0*(t.sales_today-b.same_weekday_same_time_avg)/b.same_weekday_same_time_avg,1) END AS pace_vs_same_weekday_pct
FROM today t LEFT JOIN baseline b USING(marketplace_id);

COMMENT ON VIEW mart.today_operating IS
'Live Today customer product spend including IVA from explicit ITEM+TAX order evidence where available. All orders use the same basis; settlement fees are excluded.';
