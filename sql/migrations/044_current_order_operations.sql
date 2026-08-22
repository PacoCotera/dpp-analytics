-- Current order operations are a queue, not a business-date metric.
-- Pending/unshipped/partially-shipped orders remain operationally open until
-- Amazon changes their current fulfillment status, regardless of order date.
--
-- This view intentionally separates CURRENT_FULFILLMENT_STATE from the
-- selected-day transaction evidence used elsewhere on Today.

CREATE OR REPLACE VIEW mart.order_operations_current AS
WITH status_rollup AS (
    SELECT
        m.marketplace_id,
        count(o.amazon_order_id) FILTER (
            WHERE upper(COALESCE(o.fulfillment_status,'')) IN (
                'PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED',
                'UNSHIPPED','PARTIALLY_SHIPPED'
            )
        )::bigint AS open_orders,
        count(o.amazon_order_id) FILTER (
            WHERE upper(COALESCE(o.fulfillment_status,'')) IN (
                'PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED'
            )
        )::bigint AS pending_orders,
        count(o.amazon_order_id) FILTER (
            WHERE upper(COALESCE(o.fulfillment_status,''))='UNSHIPPED'
        )::bigint AS unshipped_orders,
        count(o.amazon_order_id) FILTER (
            WHERE upper(COALESCE(o.fulfillment_status,''))='PARTIALLY_SHIPPED'
        )::bigint AS partially_shipped_orders,
        count(o.amazon_order_id) FILTER (
            WHERE upper(COALESCE(o.fulfillment_status,''))='UNFULFILLABLE'
        )::bigint AS problem_orders,
        count(o.amazon_order_id) FILTER (
            WHERE upper(COALESCE(o.fulfillment_status,'')) IN (
                'PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED',
                'UNSHIPPED','PARTIALLY_SHIPPED'
            )
              AND upper(COALESCE(o.fulfilled_by,''))='AMAZON'
        )::bigint AS fba_open_orders,
        count(o.amazon_order_id) FILTER (
            WHERE upper(COALESCE(o.fulfillment_status,'')) IN (
                'PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED',
                'UNSHIPPED','PARTIALLY_SHIPPED'
            )
              AND upper(COALESCE(o.fulfilled_by,''))='MERCHANT'
        )::bigint AS fbm_open_orders,
        count(o.amazon_order_id) FILTER (
            WHERE upper(COALESCE(o.fulfillment_status,'')) IN (
                'PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED',
                'UNSHIPPED','PARTIALLY_SHIPPED'
            )
              AND upper(COALESCE(o.fulfilled_by,'')) NOT IN ('AMAZON','MERCHANT')
        )::bigint AS unknown_fulfillment_open_orders,
        count(o.amazon_order_id) FILTER (
            WHERE upper(COALESCE(o.fulfillment_status,''))='SHIPPED'
              AND o.last_updated_time IS NOT NULL
              AND (o.last_updated_time AT TIME ZONE m.timezone)::date=
                  (CURRENT_TIMESTAMP AT TIME ZONE m.timezone)::date
        )::bigint AS shipped_today,
        max(o.last_seen_at) AS state_as_of
    FROM core.marketplace m
    LEFT JOIN core.amazon_order o USING (marketplace_id)
    GROUP BY m.marketplace_id
),
open_header AS (
    SELECT
        o.marketplace_id,
        o.amazon_order_id,
        o.created_time,
        o.last_updated_time,
        o.fulfillment_status,
        o.fulfilled_by,
        o.channel_name,
        o.quantity_fulfilled,
        o.quantity_unfulfilled,
        m.timezone,
        COALESCE(s.customer_spend,o.grand_total_amount,0)::numeric(14,2) AS sales,
        COALESCE(
            s.units,
            COALESCE(o.quantity_fulfilled,0)+COALESCE(o.quantity_unfulfilled,0),
            0
        )::bigint AS units
    FROM core.amazon_order o
    JOIN core.marketplace m USING (marketplace_id)
    LEFT JOIN mart.order_customer_spend s USING (marketplace_id,amazon_order_id)
    WHERE upper(COALESCE(o.fulfillment_status,'')) IN (
        'PENDING','PENDING_AVAILABILITY','INVOICE_UNCONFIRMED',
        'UNSHIPPED','PARTIALLY_SHIPPED'
    )
),
open_items AS (
    SELECT
        h.amazon_order_id,
        jsonb_agg(
            jsonb_build_object(
                'order_item_id',i.order_item_id,
                'sku',i.seller_sku,
                'asin',i.asin,
                'product',COALESCE(sl.item_name,ci.title,s.title,i.title,i.seller_sku,i.asin,'Item'),
                'image_url',COALESCE(sl.image_url,ci.image_url),
                'quantity_ordered',COALESCE(i.quantity_ordered,0),
                'quantity_fulfilled',COALESCE(i.quantity_fulfilled,0),
                'quantity_unfulfilled',COALESCE(i.quantity_unfulfilled,0)
            )
            ORDER BY i.order_item_id
        ) AS items
    FROM open_header h
    JOIN core.amazon_order_item i USING (amazon_order_id)
    LEFT JOIN core.sku s ON s.sku=i.seller_sku
    LEFT JOIN core.seller_listing sl
      ON sl.marketplace_id=h.marketplace_id AND sl.seller_sku=i.seller_sku
    LEFT JOIN core.catalog_item ci
      ON ci.marketplace_id=h.marketplace_id AND ci.asin=COALESCE(i.asin,s.asin)
    GROUP BY h.amazon_order_id
),
open_detail AS (
    SELECT
        h.marketplace_id,
        jsonb_agg(
            jsonb_build_object(
                'order_id',h.amazon_order_id,
                'created_date',to_char(h.created_time AT TIME ZONE h.timezone,'YYYY-MM-DD'),
                'local_time',to_char(h.created_time AT TIME ZONE h.timezone,'MM-DD HH24:MI'),
                'age_seconds',greatest(0,extract(epoch FROM (CURRENT_TIMESTAMP-h.created_time))::bigint),
                'status',COALESCE(h.fulfillment_status,''),
                'fulfilled_by',COALESCE(h.fulfilled_by,''),
                'fulfillment_model',CASE upper(COALESCE(h.fulfilled_by,''))
                    WHEN 'AMAZON' THEN 'FBA'
                    WHEN 'MERCHANT' THEN 'FBM'
                    ELSE '—'
                END,
                'channel_name',COALESCE(h.channel_name,'Amazon'),
                'sales',h.sales,
                'units',h.units,
                'quantity_fulfilled',COALESCE(h.quantity_fulfilled,0),
                'quantity_unfulfilled',COALESCE(h.quantity_unfulfilled,0),
                'items',COALESCE(i.items,'[]'::jsonb)
            )
            ORDER BY h.created_time DESC,h.amazon_order_id
        ) AS open_orders
    FROM open_header h
    LEFT JOIN open_items i USING (amazon_order_id)
    GROUP BY h.marketplace_id
)
SELECT
    r.marketplace_id,
    jsonb_build_object(
        'basis','CURRENT_FULFILLMENT_STATE',
        'open_orders',r.open_orders,
        'pending_orders',r.pending_orders,
        'unshipped_orders',r.unshipped_orders,
        'partially_shipped_orders',r.partially_shipped_orders,
        'problem_orders',r.problem_orders,
        'fba_open_orders',r.fba_open_orders,
        'fbm_open_orders',r.fbm_open_orders,
        'unknown_fulfillment_open_orders',r.unknown_fulfillment_open_orders,
        'shipped_today',r.shipped_today,
        'shipped_today_basis','CURRENT_SHIPPED_STATUS_WITH_AMAZON_LAST_UPDATED_TODAY',
        'state_as_of',r.state_as_of
    ) AS order_flow,
    COALESCE(d.open_orders,'[]'::jsonb) AS open_orders
FROM status_rollup r
LEFT JOIN open_detail d USING (marketplace_id);

COMMENT ON VIEW mart.order_operations_current IS
'Current Amazon fulfillment-state queue across all order dates. Pending/open counts are never scoped to the selected reporting day.';

-- Preserve the canonical shopper-spend Today contract from migration 034 and
-- append the current operational queue. Existing consumers keep the same first
-- six columns; JSON operational fields are additive.
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
            THEN round(100.0*(t.sales_today-b.same_weekday_same_time_avg)/b.same_weekday_same_time_avg,1) END AS pace_vs_same_weekday_pct,
       COALESCE(op.order_flow,jsonb_build_object(
           'basis','CURRENT_FULFILLMENT_STATE',
           'open_orders',0,'pending_orders',0,'unshipped_orders',0,
           'partially_shipped_orders',0,'problem_orders',0,
           'fba_open_orders',0,'fbm_open_orders',0,'unknown_fulfillment_open_orders',0,
           'shipped_today',0
       )) AS order_flow,
       COALESCE(op.open_orders,'[]'::jsonb) AS open_orders
FROM today t
LEFT JOIN baseline b USING(marketplace_id)
LEFT JOIN mart.order_operations_current op USING(marketplace_id);

COMMENT ON VIEW mart.today_operating IS
'Live Today customer product spend including tax plus a date-independent current Amazon fulfillment-state queue. Pending/open status is current state, never selected-day scoped.';
