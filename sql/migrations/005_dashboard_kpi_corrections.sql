-- Dashboard KPI corrections:
-- 1) operational Orders sales fall back to item prices when order grand total is not yet populated
-- 2) deployment-interrupted collectors do not masquerade as broken feeds when a recent success exists

CREATE OR REPLACE VIEW mart.order_sales_daily AS
WITH item_rollup AS (
    SELECT
        amazon_order_id,
        COALESCE(sum(quantity_ordered), 0)::bigint AS units,
        COALESCE(
            sum(proceeds_total_amount),
            sum(proceeds_item_amount),
            sum(unit_price_amount * quantity_ordered),
            0
        )::numeric(14,2) AS item_sales
    FROM core.amazon_order_item
    GROUP BY amazon_order_id
)
SELECT
    (o.created_time AT TIME ZONE m.timezone)::date AS business_date,
    o.marketplace_id,
    COALESCE(sum(COALESCE(o.grand_total_amount, i.item_sales, 0)), 0)::numeric(14,2) AS sales,
    count(*)::bigint AS orders,
    COALESCE(sum(i.units), 0)::bigint AS units,
    CASE WHEN count(*) > 0
         THEN (
             COALESCE(sum(COALESCE(o.grand_total_amount, i.item_sales, 0)), 0)
             / count(*)
         )::numeric(14,2)
         ELSE 0::numeric
    END AS aov
FROM core.amazon_order o
JOIN core.marketplace m USING (marketplace_id)
LEFT JOIN item_rollup i USING (amazon_order_id)
WHERE o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
GROUP BY 1, 2;

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
),
last_success AS (
    SELECT DISTINCT ON (source, job_name)
        source,
        job_name,
        finished_at AS success_at,
        records_read AS success_records_read,
        records_written AS success_records_written
    FROM ops.ingestion_runs
    WHERE status='success' AND finished_at IS NOT NULL
    ORDER BY source, job_name, finished_at DESC
)
SELECT
    l.source,
    l.job_name,
    l.started_at AS last_started_at,
    l.finished_at AS last_finished_at,
    CASE
        WHEN l.status='interrupted' AND s.success_at IS NOT NULL THEN 'success'
        ELSE l.status
    END AS latest_status,
    CASE
        WHEN l.status='interrupted' AND s.success_at IS NOT NULL THEN s.success_records_read
        ELSE l.records_read
    END AS records_read,
    CASE
        WHEN l.status='interrupted' AND s.success_at IS NOT NULL THEN s.success_records_written
        ELSE l.records_written
    END AS records_written,
    CASE
        WHEN l.status='interrupted' AND s.success_at IS NOT NULL THEN NULL
        ELSE l.error_message
    END AS error_message,
    now() - COALESCE(
        CASE WHEN l.status='interrupted' THEN s.success_at ELSE l.finished_at END,
        s.success_at,
        l.started_at
    ) AS age
FROM latest l
LEFT JOIN last_success s USING (source, job_name);
