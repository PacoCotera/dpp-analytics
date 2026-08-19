CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE SCHEMA IF NOT EXISTS ops;

-- Generic immutable-ish raw capture. Do not ingest customer PII into this project.
CREATE TABLE IF NOT EXISTS raw.api_payload (
    id bigserial PRIMARY KEY,
    source text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    marketplace_id text,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    request_window_start timestamptz,
    request_window_end timestamptz,
    payload jsonb NOT NULL,
    payload_sha256 text,
    ingestion_run_id bigint REFERENCES ops.ingestion_runs(id)
);
CREATE INDEX IF NOT EXISTS api_payload_source_fetched_idx
    ON raw.api_payload (source, resource_type, fetched_at DESC);
CREATE INDEX IF NOT EXISTS api_payload_resource_idx
    ON raw.api_payload (source, resource_type, resource_id)
    WHERE resource_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops.ingestion_cursor (
    source text NOT NULL,
    job_name text NOT NULL,
    cursor_name text NOT NULL DEFAULT 'default',
    cursor_value text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, job_name, cursor_name)
);

CREATE TABLE IF NOT EXISTS core.marketplace (
    marketplace_id text PRIMARY KEY,
    country_code char(2) NOT NULL,
    name text NOT NULL,
    currency char(3) NOT NULL,
    timezone text NOT NULL,
    region text NOT NULL
);

INSERT INTO core.marketplace (marketplace_id, country_code, name, currency, timezone, region)
VALUES ('A1AM78C64UM0Y8', 'MX', 'Amazon.com.mx', 'MXN', 'America/Mexico_City', 'NA')
ON CONFLICT (marketplace_id) DO UPDATE
SET country_code = EXCLUDED.country_code,
    name = EXCLUDED.name,
    currency = EXCLUDED.currency,
    timezone = EXCLUDED.timezone,
    region = EXCLUDED.region;

ALTER TABLE core.sku ADD COLUMN IF NOT EXISTS marketplace_id text REFERENCES core.marketplace(marketplace_id);
ALTER TABLE core.sku ADD COLUMN IF NOT EXISTS parent_asin text;
ALTER TABLE core.sku ADD COLUMN IF NOT EXISTS binding text;
ALTER TABLE core.sku ADD COLUMN IF NOT EXISTS size text;
ALTER TABLE core.sku ADD COLUMN IF NOT EXISTS lining text;
ALTER TABLE core.sku ADD COLUMN IF NOT EXISTS cover_type text;
ALTER TABLE core.sku ADD COLUMN IF NOT EXISTS list_price numeric(12,2);
ALTER TABLE core.sku ADD COLUMN IF NOT EXISTS currency char(3) DEFAULT 'MXN';

CREATE UNIQUE INDEX IF NOT EXISTS sku_marketplace_asin_idx
    ON core.sku (marketplace_id, asin)
    WHERE asin IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.amazon_order (
    amazon_order_id text PRIMARY KEY,
    marketplace_id text NOT NULL REFERENCES core.marketplace(marketplace_id),
    created_time timestamptz NOT NULL,
    last_updated_time timestamptz,
    fulfillment_status text,
    fulfilled_by text,
    channel_name text,
    programs text[] NOT NULL DEFAULT '{}',
    grand_total_amount numeric(14,2),
    currency char(3),
    quantity_fulfilled integer,
    quantity_unfulfilled integer,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    source_payload_id bigint REFERENCES raw.api_payload(id)
);
CREATE INDEX IF NOT EXISTS amazon_order_created_idx
    ON core.amazon_order (created_time DESC);
CREATE INDEX IF NOT EXISTS amazon_order_updated_idx
    ON core.amazon_order (last_updated_time DESC);
CREATE INDEX IF NOT EXISTS amazon_order_status_idx
    ON core.amazon_order (fulfillment_status);

CREATE TABLE IF NOT EXISTS core.amazon_order_item (
    amazon_order_id text NOT NULL REFERENCES core.amazon_order(amazon_order_id) ON DELETE CASCADE,
    order_item_id text NOT NULL,
    seller_sku text,
    asin text,
    title text,
    quantity_ordered integer NOT NULL DEFAULT 0,
    quantity_fulfilled integer,
    quantity_unfulfilled integer,
    unit_price_amount numeric(14,4),
    proceeds_item_amount numeric(14,4),
    proceeds_shipping_amount numeric(14,4),
    proceeds_tax_amount numeric(14,4),
    proceeds_total_amount numeric(14,4),
    currency char(3),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    source_payload_id bigint REFERENCES raw.api_payload(id),
    PRIMARY KEY (amazon_order_id, order_item_id)
);
CREATE INDEX IF NOT EXISTS amazon_order_item_sku_idx
    ON core.amazon_order_item (seller_sku);
CREATE INDEX IF NOT EXISTS amazon_order_item_asin_idx
    ON core.amazon_order_item (asin);

CREATE TABLE IF NOT EXISTS core.inventory_snapshot (
    snapshot_at timestamptz NOT NULL,
    marketplace_id text NOT NULL REFERENCES core.marketplace(marketplace_id),
    seller_sku text NOT NULL,
    asin text,
    fnsku text,
    condition text,
    fulfillable_quantity integer NOT NULL DEFAULT 0,
    inbound_working_quantity integer NOT NULL DEFAULT 0,
    inbound_shipped_quantity integer NOT NULL DEFAULT 0,
    inbound_receiving_quantity integer NOT NULL DEFAULT 0,
    reserved_quantity integer NOT NULL DEFAULT 0,
    unfulfillable_quantity integer NOT NULL DEFAULT 0,
    researching_quantity integer NOT NULL DEFAULT 0,
    total_quantity integer NOT NULL DEFAULT 0,
    source_payload_id bigint REFERENCES raw.api_payload(id),
    PRIMARY KEY (snapshot_at, marketplace_id, seller_sku)
);
CREATE INDEX IF NOT EXISTS inventory_snapshot_sku_time_idx
    ON core.inventory_snapshot (seller_sku, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS core.financial_transaction (
    transaction_id text PRIMARY KEY,
    transaction_type text,
    transaction_status text,
    posted_date timestamptz,
    marketplace_id text,
    amazon_order_id text,
    total_amount numeric(14,4),
    currency char(3),
    description text,
    related_identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
    breakdowns jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_payload_id bigint REFERENCES raw.api_payload(id),
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS financial_transaction_posted_idx
    ON core.financial_transaction (posted_date DESC);
CREATE INDEX IF NOT EXISTS financial_transaction_order_idx
    ON core.financial_transaction (amazon_order_id)
    WHERE amazon_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.sales_traffic_daily (
    business_date date NOT NULL,
    marketplace_id text NOT NULL REFERENCES core.marketplace(marketplace_id),
    ordered_product_sales numeric(14,2),
    units_ordered integer,
    total_order_items integer,
    sessions bigint,
    page_views bigint,
    unit_session_percentage numeric(10,4),
    source_payload_id bigint REFERENCES raw.api_payload(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_date, marketplace_id)
);

CREATE TABLE IF NOT EXISTS core.sku_sales_traffic_daily (
    business_date date NOT NULL,
    marketplace_id text NOT NULL REFERENCES core.marketplace(marketplace_id),
    seller_sku text NOT NULL,
    asin text,
    ordered_product_sales numeric(14,2),
    units_ordered integer,
    total_order_items integer,
    sessions bigint,
    page_views bigint,
    unit_session_percentage numeric(10,4),
    source_payload_id bigint REFERENCES raw.api_payload(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (business_date, marketplace_id, seller_sku)
);
CREATE INDEX IF NOT EXISTS sku_sales_traffic_sku_date_idx
    ON core.sku_sales_traffic_daily (seller_sku, business_date DESC);

CREATE TABLE IF NOT EXISTS core.calendar_event (
    event_date date NOT NULL,
    event_name text NOT NULL,
    event_type text NOT NULL DEFAULT 'seasonal',
    start_date date,
    end_date date,
    notes text,
    PRIMARY KEY (event_date, event_name)
);

-- Order-derived operational sales. Data Kiosk will be the canonical daily business-report source
-- once loaded; this view exists for near-real-time intraday monitoring.
CREATE OR REPLACE VIEW mart.order_sales_daily AS
WITH item_units AS (
    SELECT amazon_order_id, COALESCE(sum(quantity_ordered), 0)::bigint AS units
    FROM core.amazon_order_item
    GROUP BY amazon_order_id
)
SELECT
    (o.created_time AT TIME ZONE m.timezone)::date AS business_date,
    o.marketplace_id,
    COALESCE(sum(o.grand_total_amount), 0)::numeric(14,2) AS sales,
    count(*)::bigint AS orders,
    COALESCE(sum(i.units), 0)::bigint AS units,
    CASE WHEN count(*) > 0
         THEN (COALESCE(sum(o.grand_total_amount),0) / count(*))::numeric(14,2)
         ELSE 0::numeric
    END AS aov
FROM core.amazon_order o
JOIN core.marketplace m USING (marketplace_id)
LEFT JOIN item_units i USING (amazon_order_id)
WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
GROUP BY 1, 2;

CREATE OR REPLACE VIEW mart.business_daily AS
WITH bounds AS (
    SELECT COALESCE(min(business_date), CURRENT_DATE - 120) AS min_date
    FROM mart.order_sales_daily
),
calendar AS (
    SELECT generate_series((SELECT min_date FROM bounds), CURRENT_DATE, interval '1 day')::date AS business_date
),
market AS (
    SELECT marketplace_id FROM core.marketplace
),
spine AS (
    SELECT c.business_date, m.marketplace_id FROM calendar c CROSS JOIN market m
)
SELECT
    s.business_date,
    s.marketplace_id,
    COALESCE(k.ordered_product_sales, o.sales, 0)::numeric(14,2) AS sales,
    COALESCE(k.total_order_items, o.orders, 0)::bigint AS orders,
    COALESCE(k.units_ordered, o.units, 0)::bigint AS units,
    CASE WHEN COALESCE(k.total_order_items, o.orders, 0) > 0
         THEN (COALESCE(k.ordered_product_sales, o.sales, 0) / COALESCE(k.total_order_items, o.orders, 0))::numeric(14,2)
         ELSE 0::numeric
    END AS aov,
    k.sessions,
    k.page_views,
    k.unit_session_percentage,
    (k.business_date IS NOT NULL) AS reconciled_daily_report
FROM spine s
LEFT JOIN core.sales_traffic_daily k
  ON k.business_date = s.business_date AND k.marketplace_id = s.marketplace_id
LEFT JOIN mart.order_sales_daily o
  ON o.business_date = s.business_date AND o.marketplace_id = s.marketplace_id;

CREATE OR REPLACE VIEW mart.business_rolling AS
SELECT
    business_date,
    marketplace_id,
    sales,
    orders,
    units,
    aov,
    sessions,
    page_views,
    unit_session_percentage,
    reconciled_daily_report,
    sum(sales) OVER w7 AS sales_t7,
    sum(sales) OVER w28 AS sales_t28,
    sum(sales) OVER w56 AS sales_t56,
    sum(sales) OVER w90 AS sales_t90,
    sum(orders) OVER w28 AS orders_t28,
    sum(units) OVER w28 AS units_t28,
    avg(sales) OVER w28 AS sales_daily_avg_t28,
    avg(sales) OVER w56 AS sales_daily_avg_t56
FROM mart.business_daily
WINDOW
    w7 AS (PARTITION BY marketplace_id ORDER BY business_date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW),
    w28 AS (PARTITION BY marketplace_id ORDER BY business_date ROWS BETWEEN 27 PRECEDING AND CURRENT ROW),
    w56 AS (PARTITION BY marketplace_id ORDER BY business_date ROWS BETWEEN 55 PRECEDING AND CURRENT ROW),
    w90 AS (PARTITION BY marketplace_id ORDER BY business_date ROWS BETWEEN 89 PRECEDING AND CURRENT ROW);

CREATE OR REPLACE VIEW mart.sku_daily AS
SELECT
    (o.created_time AT TIME ZONE m.timezone)::date AS business_date,
    o.marketplace_id,
    i.seller_sku,
    max(i.asin) AS asin,
    COALESCE(sum(i.proceeds_total_amount), sum(i.proceeds_item_amount), sum(i.unit_price_amount * i.quantity_ordered), 0)::numeric(14,2) AS sales,
    COALESCE(sum(i.quantity_ordered),0)::bigint AS units,
    count(DISTINCT i.amazon_order_id)::bigint AS orders,
    max(k.sessions) AS sessions,
    max(k.page_views) AS page_views,
    max(k.unit_session_percentage) AS unit_session_percentage
FROM core.amazon_order_item i
JOIN core.amazon_order o USING (amazon_order_id)
JOIN core.marketplace m USING (marketplace_id)
LEFT JOIN core.sku_sales_traffic_daily k
  ON k.business_date = (o.created_time AT TIME ZONE m.timezone)::date
 AND k.marketplace_id = o.marketplace_id
 AND k.seller_sku = i.seller_sku
WHERE i.seller_sku IS NOT NULL
  AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
GROUP BY 1,2,3;

CREATE OR REPLACE VIEW mart.inventory_current AS
SELECT DISTINCT ON (marketplace_id, seller_sku)
    marketplace_id,
    seller_sku,
    asin,
    fnsku,
    snapshot_at,
    fulfillable_quantity,
    inbound_working_quantity,
    inbound_shipped_quantity,
    inbound_receiving_quantity,
    reserved_quantity,
    unfulfillable_quantity,
    researching_quantity,
    total_quantity
FROM core.inventory_snapshot
ORDER BY marketplace_id, seller_sku, snapshot_at DESC;

CREATE OR REPLACE VIEW ops.data_health AS
WITH latest AS (
    SELECT DISTINCT ON (source, job_name)
        source,
        job_name,
        started_at,
        finished_at,
        status,
        records_read,
        records_written,
        error_message
    FROM ops.ingestion_runs
    ORDER BY source, job_name, started_at DESC
)
SELECT
    source,
    job_name,
    started_at AS last_started_at,
    finished_at AS last_finished_at,
    status AS latest_status,
    records_read,
    records_written,
    error_message,
    now() - COALESCE(finished_at, started_at) AS age
FROM latest;
