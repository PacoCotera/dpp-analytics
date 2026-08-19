-- Finances v2024 transactions expose a recursive breakdown tree. Preserve the
-- transaction as the source of truth and flatten the tree into a queryable mart.
-- This view is intentionally generic: Amazon can add new breakdown types without
-- requiring a schema migration.
CREATE OR REPLACE VIEW mart.finance_breakdown_flat AS
WITH RECURSIVE breakdown_tree AS (
    SELECT
        t.transaction_id,
        t.transaction_type,
        t.transaction_status,
        t.posted_date,
        t.marketplace_id,
        t.amazon_order_id,
        1 AS depth,
        ARRAY[COALESCE(b.node->>'breakdownType', 'UNKNOWN')]::text[] AS path,
        b.node
    FROM core.financial_transaction t
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(t.breakdowns) = 'array'
             THEN t.breakdowns ELSE '[]'::jsonb END
    ) AS b(node)

    UNION ALL

    SELECT
        p.transaction_id,
        p.transaction_type,
        p.transaction_status,
        p.posted_date,
        p.marketplace_id,
        p.amazon_order_id,
        p.depth + 1,
        p.path || COALESCE(c.node->>'breakdownType', 'UNKNOWN'),
        c.node
    FROM breakdown_tree p
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(p.node->'breakdowns') = 'array'
             THEN p.node->'breakdowns' ELSE '[]'::jsonb END
    ) AS c(node)
)
SELECT
    transaction_id,
    transaction_type,
    transaction_status,
    posted_date,
    marketplace_id,
    amazon_order_id,
    depth,
    path,
    array_to_string(path, ' > ') AS breakdown_path,
    path[array_length(path, 1)] AS breakdown_type,
    COALESCE(
        NULLIF(node->'breakdownAmount'->>'currencyAmount', '')::numeric,
        NULLIF(node->'breakdownAmount'->>'amount', '')::numeric
    ) AS amount,
    COALESCE(
        node->'breakdownAmount'->>'currencyCode',
        node->'breakdownAmount'->>'currency'
    ) AS currency,
    NOT (
        jsonb_typeof(node->'breakdowns') = 'array'
        AND jsonb_array_length(node->'breakdowns') > 0
    ) AS is_leaf
FROM breakdown_tree;

CREATE OR REPLACE VIEW mart.finance_leaf_breakdown AS
SELECT *
FROM mart.finance_breakdown_flat
WHERE is_leaf;

-- Transaction totals are useful for cash-event classification, while leaf
-- breakdowns are the accounting detail needed for economic analysis.
CREATE OR REPLACE VIEW mart.finance_transaction_daily AS
SELECT
    (posted_date AT TIME ZONE 'America/Mexico_City')::date AS business_date,
    marketplace_id,
    transaction_type,
    count(*)::bigint AS transactions,
    sum(total_amount)::numeric(16,2) AS amount
FROM core.financial_transaction
WHERE posted_date IS NOT NULL
GROUP BY 1,2,3;
