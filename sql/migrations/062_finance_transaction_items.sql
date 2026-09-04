-- Finance API v2024 contains product identity and recursive economics below the
-- transaction grain. Retain those source structures as canonical evidence before
-- Advertising V2 is allowed to calculate product contribution or recommendations.

CREATE TABLE core.financial_transaction_identifier (
    transaction_id text NOT NULL
        REFERENCES core.financial_transaction(transaction_id) ON DELETE CASCADE,
    identifier_ordinal integer NOT NULL CHECK (identifier_ordinal > 0),
    identifier_name text NOT NULL,
    identifier_value text NOT NULL,
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    PRIMARY KEY (transaction_id, identifier_ordinal)
);

CREATE INDEX financial_transaction_identifier_lookup_idx
    ON core.financial_transaction_identifier(identifier_name, identifier_value);

CREATE TABLE core.financial_transaction_item (
    transaction_id text NOT NULL
        REFERENCES core.financial_transaction(transaction_id) ON DELETE CASCADE,
    item_ordinal integer NOT NULL CHECK (item_ordinal > 0),
    description text,
    total_amount numeric(18,4),
    currency char(3),
    contexts jsonb NOT NULL DEFAULT '[]'::jsonb,
    related_identifiers jsonb NOT NULL DEFAULT '[]'::jsonb,
    breakdowns jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    PRIMARY KEY (transaction_id, item_ordinal),
    CHECK (jsonb_typeof(contexts) = 'array'),
    CHECK (jsonb_typeof(related_identifiers) = 'array'),
    CHECK (jsonb_typeof(breakdowns) = 'array')
);

CREATE INDEX financial_transaction_item_source_idx
    ON core.financial_transaction_item(source_payload_id);

CREATE TABLE core.financial_transaction_item_context (
    transaction_id text NOT NULL,
    item_ordinal integer NOT NULL,
    context_ordinal integer NOT NULL CHECK (context_ordinal > 0),
    context_type text,
    seller_sku text,
    asin text,
    fulfillment_network text,
    quantity_shipped numeric(18,4),
    raw_context jsonb NOT NULL,
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    PRIMARY KEY (transaction_id, item_ordinal, context_ordinal),
    FOREIGN KEY (transaction_id, item_ordinal)
        REFERENCES core.financial_transaction_item(transaction_id, item_ordinal)
        ON DELETE CASCADE
);

CREATE INDEX financial_transaction_item_context_sku_idx
    ON core.financial_transaction_item_context(seller_sku)
    WHERE seller_sku IS NOT NULL;

CREATE INDEX financial_transaction_item_context_asin_idx
    ON core.financial_transaction_item_context(asin)
    WHERE asin IS NOT NULL;

CREATE TABLE core.financial_transaction_item_identifier (
    transaction_id text NOT NULL,
    item_ordinal integer NOT NULL,
    identifier_ordinal integer NOT NULL CHECK (identifier_ordinal > 0),
    identifier_name text NOT NULL,
    identifier_value text NOT NULL,
    source_payload_id bigint NOT NULL REFERENCES raw.api_payload(id),
    PRIMARY KEY (transaction_id, item_ordinal, identifier_ordinal),
    FOREIGN KEY (transaction_id, item_ordinal)
        REFERENCES core.financial_transaction_item(transaction_id, item_ordinal)
        ON DELETE CASCADE
);

CREATE INDEX financial_transaction_item_identifier_lookup_idx
    ON core.financial_transaction_item_identifier(identifier_name, identifier_value);

-- Recover the latest item evidence from every retained raw transaction. The raw
-- payload referenced by core.financial_transaction is the exact version currently
-- represented by that normalized parent row.
INSERT INTO core.financial_transaction_identifier(
    transaction_id, identifier_ordinal, identifier_name, identifier_value,
    source_payload_id
)
SELECT
    ft.transaction_id,
    identifier.ordinality::integer,
    identifier.node->>'relatedIdentifierName',
    identifier.node->>'relatedIdentifierValue',
    ft.source_payload_id
FROM core.financial_transaction ft
JOIN raw.api_payload payload ON payload.id=ft.source_payload_id
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(payload.payload->'relatedIdentifiers')='array'
         THEN payload.payload->'relatedIdentifiers' ELSE '[]'::jsonb END
) WITH ORDINALITY AS identifier(node, ordinality)
WHERE NULLIF(identifier.node->>'relatedIdentifierName','') IS NOT NULL
  AND NULLIF(identifier.node->>'relatedIdentifierValue','') IS NOT NULL;

INSERT INTO core.financial_transaction_item(
    transaction_id, item_ordinal, description, total_amount, currency, contexts,
    related_identifiers, breakdowns, source_payload_id
)
SELECT
    ft.transaction_id,
    item.ordinality::integer,
    item.node->>'description',
    COALESCE(
        NULLIF(item.node->'totalAmount'->>'currencyAmount','')::numeric,
        NULLIF(item.node->'totalAmount'->>'amount','')::numeric
    ),
    COALESCE(
        item.node->'totalAmount'->>'currencyCode',
        item.node->'totalAmount'->>'currency'
    ),
    CASE WHEN jsonb_typeof(item.node->'contexts')='array'
         THEN item.node->'contexts' ELSE '[]'::jsonb END,
    CASE WHEN jsonb_typeof(item.node->'relatedIdentifiers')='array'
         THEN item.node->'relatedIdentifiers' ELSE '[]'::jsonb END,
    CASE WHEN jsonb_typeof(item.node->'breakdowns')='array'
         THEN item.node->'breakdowns' ELSE '[]'::jsonb END,
    ft.source_payload_id
FROM core.financial_transaction ft
JOIN raw.api_payload payload ON payload.id=ft.source_payload_id
CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(payload.payload->'items')='array'
         THEN payload.payload->'items' ELSE '[]'::jsonb END
) WITH ORDINALITY AS item(node, ordinality);

INSERT INTO core.financial_transaction_item_context(
    transaction_id, item_ordinal, context_ordinal, context_type, seller_sku, asin,
    fulfillment_network, quantity_shipped, raw_context, source_payload_id
)
SELECT
    item.transaction_id,
    item.item_ordinal,
    context.ordinality::integer,
    context.node->>'contextType',
    context.node->>'sku',
    context.node->>'asin',
    context.node->>'fulfillmentNetwork',
    NULLIF(context.node->>'quantityShipped','')::numeric,
    context.node,
    item.source_payload_id
FROM core.financial_transaction_item item
CROSS JOIN LATERAL jsonb_array_elements(item.contexts)
    WITH ORDINALITY AS context(node, ordinality);

INSERT INTO core.financial_transaction_item_identifier(
    transaction_id, item_ordinal, identifier_ordinal, identifier_name,
    identifier_value, source_payload_id
)
SELECT
    item.transaction_id,
    item.item_ordinal,
    identifier.ordinality::integer,
    identifier.node->>'itemRelatedIdentifierName',
    identifier.node->>'itemRelatedIdentifierValue',
    item.source_payload_id
FROM core.financial_transaction_item item
CROSS JOIN LATERAL jsonb_array_elements(item.related_identifiers)
    WITH ORDINALITY AS identifier(node, ordinality)
WHERE NULLIF(identifier.node->>'itemRelatedIdentifierName','') IS NOT NULL
  AND NULLIF(identifier.node->>'itemRelatedIdentifierValue','') IS NOT NULL;

CREATE OR REPLACE VIEW mart.finance_item_breakdown_flat AS
WITH RECURSIVE breakdown_tree AS (
    SELECT
        item.transaction_id,
        item.item_ordinal,
        transaction.transaction_type,
        transaction.transaction_status,
        transaction.posted_date,
        transaction.marketplace_id,
        transaction.amazon_order_id,
        1 AS depth,
        ARRAY[COALESCE(node.value->>'breakdownType','UNKNOWN')]::text[] AS path,
        node.value AS node
    FROM core.financial_transaction_item item
    JOIN core.financial_transaction transaction USING (transaction_id)
    CROSS JOIN LATERAL jsonb_array_elements(item.breakdowns) AS node(value)

    UNION ALL

    SELECT
        parent.transaction_id,
        parent.item_ordinal,
        parent.transaction_type,
        parent.transaction_status,
        parent.posted_date,
        parent.marketplace_id,
        parent.amazon_order_id,
        parent.depth + 1,
        parent.path || COALESCE(child.value->>'breakdownType','UNKNOWN'),
        child.value
    FROM breakdown_tree parent
    CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(parent.node->'breakdowns')='array'
             THEN parent.node->'breakdowns' ELSE '[]'::jsonb END
    ) AS child(value)
)
SELECT
    transaction_id,
    item_ordinal,
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
        NULLIF(node->'breakdownAmount'->>'currencyAmount','')::numeric,
        NULLIF(node->'breakdownAmount'->>'amount','')::numeric
    ) AS amount,
    COALESCE(
        node->'breakdownAmount'->>'currencyCode',
        node->'breakdownAmount'->>'currency'
    ) AS currency,
    NOT (
        jsonb_typeof(node->'breakdowns')='array'
        AND jsonb_array_length(node->'breakdowns') > 0
    ) AS is_leaf
FROM breakdown_tree;

CREATE OR REPLACE VIEW mart.finance_item_leaf_breakdown AS
SELECT * FROM mart.finance_item_breakdown_flat WHERE is_leaf;

CREATE OR REPLACE VIEW mart.finance_transaction_item_identity AS
WITH candidates AS (
    SELECT transaction_id, item_ordinal, NULLIF(seller_sku,'') AS seller_sku,
           NULLIF(asin,'') AS asin
    FROM core.financial_transaction_item_context
    UNION ALL
    SELECT
        transaction_id,
        item_ordinal,
        CASE WHEN upper(regexp_replace(identifier_name,'[^A-Za-z0-9]','','g'))
                       IN ('SKU','SELLERSKU')
             THEN NULLIF(identifier_value,'') END,
        CASE WHEN upper(regexp_replace(identifier_name,'[^A-Za-z0-9]','','g'))='ASIN'
             THEN NULLIF(identifier_value,'') END
    FROM core.financial_transaction_item_identifier
), identity_counts AS (
    SELECT
        item.transaction_id,
        item.item_ordinal,
        count(DISTINCT candidates.seller_sku)
            FILTER (WHERE candidates.seller_sku IS NOT NULL) AS sku_count,
        count(DISTINCT candidates.asin)
            FILTER (WHERE candidates.asin IS NOT NULL) AS asin_count,
        min(candidates.seller_sku)
            FILTER (WHERE candidates.seller_sku IS NOT NULL) AS only_sku,
        min(candidates.asin)
            FILTER (WHERE candidates.asin IS NOT NULL) AS only_asin
    FROM core.financial_transaction_item item
    LEFT JOIN candidates USING (transaction_id, item_ordinal)
    GROUP BY item.transaction_id, item.item_ordinal
)
SELECT
    transaction_id,
    item_ordinal,
    CASE WHEN sku_count=1 THEN only_sku END AS seller_sku,
    CASE WHEN asin_count=1 THEN only_asin END AS asin,
    sku_count,
    asin_count,
    CASE
        WHEN sku_count > 1 OR asin_count > 1 THEN 'CONFLICT'
        WHEN sku_count = 1 AND asin_count = 1 THEN 'EXACT'
        WHEN sku_count = 1 THEN 'SKU_ONLY'
        WHEN asin_count = 1 THEN 'ASIN_ONLY'
        ELSE 'MISSING'
    END AS identity_state
FROM identity_counts;

CREATE OR REPLACE VIEW mart.finance_item_coverage_daily AS
SELECT
    (transaction.posted_date AT TIME ZONE 'America/Mexico_City')::date AS business_date,
    transaction.marketplace_id,
    count(DISTINCT transaction.transaction_id)::bigint AS transactions_with_items,
    count(*)::bigint AS item_rows,
    count(*) FILTER (WHERE identity.identity_state='EXACT')::bigint AS exact_items,
    count(*) FILTER (WHERE identity.identity_state='SKU_ONLY')::bigint AS sku_only_items,
    count(*) FILTER (WHERE identity.identity_state='ASIN_ONLY')::bigint AS asin_only_items,
    count(*) FILTER (WHERE identity.identity_state='CONFLICT')::bigint AS conflicting_items,
    count(*) FILTER (WHERE identity.identity_state='MISSING')::bigint AS missing_items
FROM core.financial_transaction_item item
JOIN core.financial_transaction transaction USING (transaction_id)
JOIN mart.finance_transaction_item_identity identity
    USING (transaction_id, item_ordinal)
GROUP BY 1,2;

COMMENT ON TABLE core.financial_transaction_item IS
'Latest normalized Finance API v2024 item evidence. Raw payloads remain immutable in raw.api_payload; no item total is assumed to equal transaction total.';

COMMENT ON VIEW mart.finance_transaction_item_identity IS
'Conservative product identity resolution. CONFLICT and MISSING rows are ineligible for authoritative product economics until reconciled.';

COMMENT ON VIEW mart.finance_item_breakdown_flat IS
'Recursive Finance API item breakdown evidence. Values preserve Amazon source semantics and are not contribution classifications.';

COMMENT ON VIEW mart.finance_item_coverage_daily IS
'Structural product-identity coverage only. It deliberately does not assert an accounting identity between item totals, item breakdowns and transaction totals.';
