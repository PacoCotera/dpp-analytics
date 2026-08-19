CREATE TABLE IF NOT EXISTS core.asin_sales_traffic_daily (
    business_date date NOT NULL,
    marketplace_id text NOT NULL REFERENCES core.marketplace(marketplace_id),
    asin text NOT NULL,
    parent_asin text,
    ordered_product_sales numeric(14,2),
    units_ordered integer,
    total_order_items integer,
    units_refunded integer,
    sessions bigint,
    page_views bigint,
    browser_sessions bigint,
    browser_page_views bigint,
    unit_session_percentage numeric(10,4),
    session_percentage numeric(10,4),
    source_payload_id bigint REFERENCES raw.api_payload(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_date, marketplace_id, asin)
);

CREATE INDEX IF NOT EXISTS asin_sales_traffic_asin_date_idx
    ON core.asin_sales_traffic_daily (asin, business_date DESC);

-- Canonical catalog-performance view. Sales/order units remain seller-SKU specific
-- from Orders, while traffic metrics are joined at the child-ASIN level because
-- Data Kiosk salesAndTrafficTrends currently supports CHILD aggregation only.
CREATE OR REPLACE VIEW mart.sku_daily AS
WITH order_sku AS (
    SELECT
        (o.created_time AT TIME ZONE m.timezone)::date AS business_date,
        o.marketplace_id,
        i.seller_sku,
        max(i.asin) AS asin,
        COALESCE(sum(i.proceeds_total_amount), sum(i.proceeds_item_amount), sum(i.unit_price_amount * i.quantity_ordered), 0)::numeric(14,2) AS sales,
        COALESCE(sum(i.quantity_ordered),0)::bigint AS units,
        count(DISTINCT i.amazon_order_id)::bigint AS orders
    FROM core.amazon_order_item i
    JOIN core.amazon_order o USING (amazon_order_id)
    JOIN core.marketplace m USING (marketplace_id)
    WHERE i.seller_sku IS NOT NULL
      AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
    GROUP BY 1,2,3
)
SELECT
    o.business_date,
    o.marketplace_id,
    o.seller_sku,
    o.asin,
    o.sales,
    o.units,
    o.orders,
    a.sessions,
    a.page_views,
    a.unit_session_percentage,
    a.session_percentage,
    a.units_refunded
FROM order_sku o
LEFT JOIN core.asin_sales_traffic_daily a
  ON a.business_date = o.business_date
 AND a.marketplace_id = o.marketplace_id
 AND a.asin = o.asin;
