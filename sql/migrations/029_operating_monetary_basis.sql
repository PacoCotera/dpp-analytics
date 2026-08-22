-- Canonical operating monetary basis.
--
-- The product has three intentionally different money concepts:
--   1) live/order evidence: gross customer spend from Orders (tax-inclusive shopper amount),
--   2) reconciled operating sales: Amazon Sales & Traffic orderedProductSales,
--   3) accounting: Finance net sales ex IVA + IVA + gross customer spend separately.
--
-- Settlement/proceeds fields are accounting evidence. They MUST NOT be used as a
-- fallback for customer-facing operating sales because in Mexico they can be net
-- of IVA and therefore silently mix bases inside the same chart/table.

CREATE OR REPLACE VIEW mart.order_item_customer_spend AS
SELECT
    o.marketplace_id,
    o.amazon_order_id,
    (o.created_time AT TIME ZONE m.timezone)::date AS business_date,
    o.created_time,
    i.seller_sku,
    i.asin,
    COALESCE(i.quantity_ordered,0)::bigint AS units,
    COALESCE(i.unit_price_amount * i.quantity_ordered,0)::numeric(14,2) AS customer_spend,
    COALESCE(o.fulfillment_status,'') AS fulfillment_status
FROM core.amazon_order_item i
JOIN core.amazon_order o USING (amazon_order_id)
JOIN core.marketplace m USING (marketplace_id)
WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED';

COMMENT ON VIEW mart.order_item_customer_spend IS
'Order-item operating money on gross customer-spend basis. Uses unit price x quantity; never settlement/proceeds amounts.';

CREATE OR REPLACE VIEW mart.order_customer_spend AS
WITH item_rollup AS (
    SELECT
        marketplace_id,
        amazon_order_id,
        business_date,
        min(created_time) AS created_time,
        COALESCE(sum(units),0)::bigint AS units,
        COALESCE(sum(customer_spend),0)::numeric(14,2) AS item_customer_spend
    FROM mart.order_item_customer_spend
    GROUP BY marketplace_id, amazon_order_id, business_date
)
SELECT
    o.marketplace_id,
    o.amazon_order_id,
    r.business_date,
    o.created_time,
    COALESCE(o.grand_total_amount,r.item_customer_spend,0)::numeric(14,2) AS customer_spend,
    COALESCE(r.units,0)::bigint AS units,
    COALESCE(o.fulfillment_status,'') AS fulfillment_status
FROM core.amazon_order o
JOIN item_rollup r USING (marketplace_id, amazon_order_id)
WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED';

COMMENT ON VIEW mart.order_customer_spend IS
'Order-level gross customer spend. Prefers Amazon order grand total; falls back only to gross item price x quantity, never proceeds.';

-- Preserve the existing compatibility contract while correcting its fallback basis.
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
GROUP BY business_date, marketplace_id;

COMMENT ON VIEW mart.order_sales_daily IS
'Near-real-time order-derived operating sales. sales/aov are gross customer spend; reconciled history comes from Amazon Sales & Traffic in mart.business_daily.';

-- SKU/order operational history is also gross customer spend. This view is not
-- an accounting/proceeds view and must never use proceeds_* fields.
CREATE OR REPLACE VIEW mart.sku_daily AS
SELECT
    x.business_date,
    x.marketplace_id,
    x.seller_sku,
    max(x.asin) AS asin,
    COALESCE(sum(x.customer_spend),0)::numeric(14,2) AS sales,
    COALESCE(sum(x.units),0)::bigint AS units,
    count(DISTINCT x.amazon_order_id)::bigint AS orders,
    max(k.sessions) AS sessions,
    max(k.page_views) AS page_views,
    max(k.unit_session_percentage) AS unit_session_percentage
FROM mart.order_item_customer_spend x
LEFT JOIN core.sku_sales_traffic_daily k
  ON k.business_date=x.business_date
 AND k.marketplace_id=x.marketplace_id
 AND k.seller_sku=x.seller_sku
WHERE x.seller_sku IS NOT NULL
GROUP BY x.business_date,x.marketplace_id,x.seller_sku;

COMMENT ON VIEW mart.sku_daily IS
'Near-real-time SKU operating history. sales is gross customer spend from order item price x quantity; proceeds are intentionally excluded.';

-- Inventory velocity and product-mover reads should use reconciled Amazon Sales &
-- Traffic rather than an accounting/proceeds order measure.
CREATE OR REPLACE VIEW mart.sku_velocity_t28 AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS cutoff_date
    FROM core.sku_sales_traffic_daily
    GROUP BY marketplace_id
)
SELECT
    s.marketplace_id,
    s.seller_sku,
    max(s.asin) AS asin,
    COALESCE(sum(s.ordered_product_sales),0)::numeric(14,2) AS sales_t28,
    COALESCE(sum(s.units_ordered),0)::bigint AS units_t28,
    COALESCE(sum(s.total_order_items),0)::bigint AS orders_t28,
    (COALESCE(sum(s.units_ordered),0)::numeric / 28.0) AS units_per_day
FROM core.sku_sales_traffic_daily s
JOIN cutoff c USING (marketplace_id)
WHERE s.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date
GROUP BY s.marketplace_id,s.seller_sku;

COMMENT ON VIEW mart.sku_velocity_t28 IS
'Reconciled 28-day SKU velocity from Amazon Sales & Traffic. Monetary sales are orderedProductSales, not settlement proceeds.';

CREATE OR REPLACE VIEW mart.catalog_movers_t28 AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS cutoff_date
    FROM core.sku_sales_traffic_daily
    GROUP BY marketplace_id
), agg AS (
    SELECT
        s.marketplace_id,
        s.seller_sku,
        max(s.asin) AS asin,
        COALESCE(sum(s.ordered_product_sales) FILTER (
            WHERE s.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date
        ),0)::numeric(14,2) AS sales_t28,
        COALESCE(sum(s.units_ordered) FILTER (
            WHERE s.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date
        ),0)::bigint AS units_t28,
        COALESCE(sum(s.ordered_product_sales) FILTER (
            WHERE s.business_date BETWEEN c.cutoff_date-55 AND c.cutoff_date-28
        ),0)::numeric(14,2) AS sales_prior_t28
    FROM core.sku_sales_traffic_daily s
    JOIN cutoff c USING (marketplace_id)
    WHERE s.business_date BETWEEN c.cutoff_date-55 AND c.cutoff_date
    GROUP BY s.marketplace_id,s.seller_sku
)
SELECT
    a.*,
    CASE
        WHEN sales_prior_t28 > 0 THEN round(100.0*(sales_t28-sales_prior_t28)/sales_prior_t28,1)
        WHEN sales_t28 > 0 THEN NULL
        ELSE 0::numeric
    END AS delta28_pct,
    CASE
        WHEN sales_t28 > 0 AND sales_prior_t28 = 0 THEN 'NEW'
        WHEN sales_prior_t28 > 0 AND sales_t28 >= sales_prior_t28*1.20 THEN 'ACCELERATING'
        WHEN sales_prior_t28 > 0 AND sales_t28 >= sales_prior_t28*1.05 THEN 'GROWING'
        WHEN sales_prior_t28 > 0 AND sales_t28 <= sales_prior_t28*0.80 THEN 'DECLINING'
        WHEN sales_prior_t28 > 0 AND sales_t28 <= sales_prior_t28*0.95 THEN 'COOLING'
        ELSE 'STABLE'
    END AS state
FROM agg a;

COMMENT ON VIEW mart.catalog_movers_t28 IS
'Reconciled product movers from Amazon SKU Sales & Traffic. sales_t28 and prior use orderedProductSales consistently.';

-- Today is a live shopper-spend surface. Keep same-time pace on exactly the same
-- gross customer-spend basis as the headline.
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
'Live Today headline and same-time benchmark on gross customer-spend basis from Orders; includes customer tax in the order amount and excludes settlement proceeds.';
