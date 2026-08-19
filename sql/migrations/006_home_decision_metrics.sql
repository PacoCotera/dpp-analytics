-- Decision-oriented HOME metrics.
-- Stockout/action semantics are based on recent selling velocity, not raw zero FBA inventory.
-- Intraday pace compares today against the prior 8 matching weekdays at the same local clock time.

CREATE OR REPLACE VIEW mart.sku_velocity_t28 AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS cutoff_date
    FROM core.sales_traffic_daily
    GROUP BY marketplace_id
)
SELECT
    s.marketplace_id,
    s.seller_sku,
    max(s.asin) AS asin,
    COALESCE(sum(s.sales),0)::numeric(14,2) AS sales_t28,
    COALESCE(sum(s.units),0)::bigint AS units_t28,
    COALESCE(sum(s.orders),0)::bigint AS orders_t28,
    (COALESCE(sum(s.units),0)::numeric / 28.0) AS units_per_day
FROM mart.sku_daily s
JOIN cutoff c USING (marketplace_id)
WHERE s.business_date BETWEEN c.cutoff_date - 27 AND c.cutoff_date
GROUP BY s.marketplace_id, s.seller_sku;

CREATE OR REPLACE VIEW mart.inventory_attention AS
SELECT
    i.marketplace_id,
    i.seller_sku,
    i.asin,
    i.snapshot_at,
    i.fulfillable_quantity AS available,
    (i.inbound_working_quantity + i.inbound_shipped_quantity + i.inbound_receiving_quantity)::int AS inbound,
    COALESCE(v.sales_t28,0)::numeric(14,2) AS sales_t28,
    COALESCE(v.units_t28,0)::bigint AS units_t28,
    COALESCE(v.units_per_day,0)::numeric AS units_per_day,
    CASE
        WHEN COALESCE(v.units_per_day,0) > 0
        THEN round(i.fulfillable_quantity / v.units_per_day, 1)
        ELSE NULL
    END AS days_cover_on_hand,
    CASE
        WHEN COALESCE(v.units_per_day,0) > 0
        THEN round((i.fulfillable_quantity + i.inbound_working_quantity + i.inbound_shipped_quantity + i.inbound_receiving_quantity) / v.units_per_day, 1)
        ELSE NULL
    END AS days_cover_with_inbound,
    CASE
        WHEN i.fulfillable_quantity = 0 AND COALESCE(v.units_t28,0) > 0 THEN 'STOCKOUT'
        WHEN COALESCE(v.units_per_day,0) = 0 THEN 'HOLD'
        WHEN (i.fulfillable_quantity + i.inbound_working_quantity + i.inbound_shipped_quantity + i.inbound_receiving_quantity) / v.units_per_day < 14 THEN 'PRODUCE'
        WHEN (i.fulfillable_quantity + i.inbound_working_quantity + i.inbound_shipped_quantity + i.inbound_receiving_quantity) / v.units_per_day < 28 THEN 'PLAN'
        ELSE 'OK'
    END AS action
FROM mart.inventory_current i
LEFT JOIN mart.sku_velocity_t28 v
  ON v.marketplace_id=i.marketplace_id AND v.seller_sku=i.seller_sku;

CREATE OR REPLACE VIEW mart.catalog_movers_t28 AS
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS cutoff_date
    FROM core.sales_traffic_daily
    GROUP BY marketplace_id
),
agg AS (
    SELECT
        s.marketplace_id,
        s.seller_sku,
        max(s.asin) AS asin,
        COALESCE(sum(s.sales) FILTER (WHERE s.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date),0)::numeric(14,2) AS sales_t28,
        COALESCE(sum(s.units) FILTER (WHERE s.business_date BETWEEN c.cutoff_date-27 AND c.cutoff_date),0)::bigint AS units_t28,
        COALESCE(sum(s.sales) FILTER (WHERE s.business_date BETWEEN c.cutoff_date-55 AND c.cutoff_date-28),0)::numeric(14,2) AS sales_prior_t28
    FROM mart.sku_daily s
    JOIN cutoff c USING (marketplace_id)
    WHERE s.business_date BETWEEN c.cutoff_date-55 AND c.cutoff_date
    GROUP BY s.marketplace_id, s.seller_sku
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

CREATE OR REPLACE VIEW mart.today_operating AS
WITH item_rollup AS (
    SELECT
        amazon_order_id,
        COALESCE(sum(quantity_ordered),0)::bigint AS units,
        COALESCE(sum(proceeds_total_amount), sum(proceeds_item_amount), sum(unit_price_amount*quantity_ordered),0)::numeric(14,2) AS item_sales
    FROM core.amazon_order_item
    GROUP BY amazon_order_id
),
orders_local AS (
    SELECT
        o.marketplace_id,
        (o.created_time AT TIME ZONE m.timezone) AS local_created,
        COALESCE(o.grand_total_amount, i.item_sales, 0)::numeric(14,2) AS sales,
        COALESCE(i.units,0)::bigint AS units
    FROM core.amazon_order o
    JOIN core.marketplace m USING (marketplace_id)
    LEFT JOIN item_rollup i USING (amazon_order_id)
    WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
),
clock AS (
    SELECT
        m.marketplace_id,
        m.timezone,
        (CURRENT_TIMESTAMP AT TIME ZONE m.timezone) AS local_now
    FROM core.marketplace m
),
today AS (
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
),
comparison_days AS (
    SELECT
        c.marketplace_id,
        c.local_now,
        d::date AS business_date
    FROM clock c
    CROSS JOIN LATERAL generate_series(c.local_now::date-56, c.local_now::date-1, interval '1 day') d
    WHERE extract(isodow FROM d)=extract(isodow FROM c.local_now)
),
comparison_daily AS (
    SELECT
        d.marketplace_id,
        d.business_date,
        COALESCE(sum(o.sales),0)::numeric(14,2) AS sales_same_time
    FROM comparison_days d
    LEFT JOIN orders_local o
      ON o.marketplace_id=d.marketplace_id
     AND o.local_created::date=d.business_date
     AND o.local_created::time <= d.local_now::time
    GROUP BY d.marketplace_id, d.business_date
),
baseline AS (
    SELECT marketplace_id, avg(sales_same_time)::numeric(14,2) AS same_weekday_same_time_avg
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
