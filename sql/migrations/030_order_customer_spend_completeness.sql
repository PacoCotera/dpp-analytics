-- Keep live order-level shopper spend complete even when item detail has not arrived yet.
-- Order grand total is already the preferred gross customer amount, so an order must
-- not disappear merely because its item rows are temporarily absent.

CREATE OR REPLACE VIEW mart.order_customer_spend AS
WITH item_rollup AS (
    SELECT
        marketplace_id,
        amazon_order_id,
        COALESCE(sum(units),0)::bigint AS units,
        COALESCE(sum(customer_spend),0)::numeric(14,2) AS item_customer_spend
    FROM mart.order_item_customer_spend
    GROUP BY marketplace_id,amazon_order_id
)
SELECT
    o.marketplace_id,
    o.amazon_order_id,
    (o.created_time AT TIME ZONE m.timezone)::date AS business_date,
    o.created_time,
    COALESCE(o.grand_total_amount,r.item_customer_spend,0)::numeric(14,2) AS customer_spend,
    COALESCE(r.units,COALESCE(o.quantity_fulfilled,0)+COALESCE(o.quantity_unfulfilled,0),0)::bigint AS units,
    COALESCE(o.fulfillment_status,'') AS fulfillment_status
FROM core.amazon_order o
JOIN core.marketplace m USING (marketplace_id)
LEFT JOIN item_rollup r USING (marketplace_id,amazon_order_id)
WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED';

COMMENT ON VIEW mart.order_customer_spend IS
'Order-level gross customer spend. Includes orders before item detail arrives; prefers Amazon grand total and falls back only to gross item price x quantity, never proceeds.';
