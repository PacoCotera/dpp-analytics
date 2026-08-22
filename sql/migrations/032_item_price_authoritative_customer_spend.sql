-- Shopper-spend authority correction.
--
-- Amazon order grand_total_amount is not reliable enough to be the primary
-- operating-money basis for DPP Mexico: observed orders can expose a tax-exclusive
-- amount while item unit_price_amount remains the actual shopper-facing price.
--
-- Therefore, whenever item detail exists, item price x quantity is authoritative.
-- Order grand total remains only a temporary completeness fallback until item detail
-- arrives. Settlement/proceeds values remain forbidden for operating sales.

CREATE OR REPLACE VIEW mart.order_customer_spend AS
WITH item_rollup AS (
    SELECT
        marketplace_id,
        amazon_order_id,
        COALESCE(sum(units),0)::bigint AS units,
        COALESCE(sum(customer_spend),0)::numeric(14,2) AS item_customer_spend,
        count(*)::bigint AS item_rows
    FROM mart.order_item_customer_spend
    GROUP BY marketplace_id,amazon_order_id
)
SELECT
    o.marketplace_id,
    o.amazon_order_id,
    (o.created_time AT TIME ZONE m.timezone)::date AS business_date,
    o.created_time,
    CASE
      WHEN COALESCE(r.item_rows,0) > 0 THEN r.item_customer_spend
      ELSE COALESCE(o.grand_total_amount,0)
    END::numeric(14,2) AS customer_spend,
    COALESCE(r.units,COALESCE(o.quantity_fulfilled,0)+COALESCE(o.quantity_unfulfilled,0),0)::bigint AS units,
    COALESCE(o.fulfillment_status,'') AS fulfillment_status,
    CASE
      WHEN COALESCE(r.item_rows,0) > 0 THEN 'ITEM_PRICE_X_QUANTITY'
      WHEN o.grand_total_amount IS NOT NULL THEN 'ORDER_GRAND_TOTAL_FALLBACK'
      ELSE 'NO_AMOUNT'
    END::text AS customer_spend_source
FROM core.amazon_order o
JOIN core.marketplace m USING (marketplace_id)
LEFT JOIN item_rollup r USING (marketplace_id,amazon_order_id)
WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED';

COMMENT ON VIEW mart.order_customer_spend IS
'Order-level shopper spend. Item unit price x quantity is authoritative whenever item detail exists; order grand total is only a temporary fallback before item detail arrives. Settlement/proceeds values are never used.';

-- Rebuild dependent operating views so all Today/order consumers inherit the same
-- authority rule without local patches.
CREATE OR REPLACE VIEW mart.order_sales_daily AS
SELECT
    business_date,
    marketplace_id,
    COALESCE(sum(customer_spend),0)::numeric(14,2) AS sales,
    count(*)::bigint AS orders,
    COALESCE(sum(units),0)::bigint AS units,
    CASE WHEN count(*) > 0
         THEN (COALESCE(sum(customer_spend),0) / count(*))::numeric(14,2)
         ELSE 0::numeric
    END AS aov
FROM mart.order_customer_spend
GROUP BY business_date,marketplace_id;

CREATE OR REPLACE VIEW mart.today_operating AS
WITH orders_local AS (
    SELECT
        o.marketplace_id,
        (o.created_time AT TIME ZONE m.timezone) AS local_created,
        o.customer_spend AS sales,
        o.units
    FROM mart.order_customer_spend o
    JOIN core.marketplace m USING (marketplace_id)
), clock AS (
    SELECT
        m.marketplace_id,
        m.timezone,
        (CURRENT_TIMESTAMP AT TIME ZONE m.timezone) AS local_now
    FROM core.marketplace m
), today AS (
    SELECT
        c.marketplace_id,
        COALESCE(sum(o.sales),0)::numeric(14,2) AS sales_today,
        count(o.local_created)::bigint AS orders_today,
        COALESCE(sum(o.units),0)::bigint AS units_today
    FROM clock c
    LEFT JOIN orders_local o
      ON o.marketplace_id=c.marketplace_id
     AND o.local_created::date=c.local_now::date
    GROUP BY c.marketplace_id
), comparison_days AS (
    SELECT
        c.marketplace_id,
        c.local_now,
        d::date AS business_date
    FROM clock c
    CROSS JOIN LATERAL generate_series(c.local_now::date-56,c.local_now::date-1,interval '1 day') d
    WHERE extract(isodow FROM d)=extract(isodow FROM c.local_now)
), comparison_daily AS (
    SELECT
        d.marketplace_id,
        d.business_date,
        COALESCE(sum(o.sales),0)::numeric(14,2) AS sales_same_time
    FROM comparison_days d
    LEFT JOIN orders_local o
      ON o.marketplace_id=d.marketplace_id
     AND o.local_created::date=d.business_date
     AND o.local_created::time<=d.local_now::time
    GROUP BY d.marketplace_id,d.business_date
), baseline AS (
    SELECT marketplace_id,avg(sales_same_time)::numeric(14,2) AS same_weekday_same_time_avg
    FROM comparison_daily
    GROUP BY marketplace_id
)
SELECT
    t.marketplace_id,
    t.sales_today,
    t.orders_today,
    t.units_today,
    b.same_weekday_same_time_avg,
    CASE
        WHEN b.same_weekday_same_time_avg > 0
        THEN round(100.0*(t.sales_today-b.same_weekday_same_time_avg)/b.same_weekday_same_time_avg,1)
        ELSE NULL
    END AS pace_vs_same_weekday_pct
FROM today t
LEFT JOIN baseline b USING (marketplace_id);

COMMENT ON VIEW mart.today_operating IS
'Live Today headline and same-time benchmark on shopper-spend basis. Item unit price x quantity is authoritative; order grand total is only a temporary fallback before item detail arrives.';
