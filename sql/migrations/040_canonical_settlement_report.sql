-- Canonical Amazon settlement report selection.
--
-- Amazon can expose more than one report_id for the same settlement_id. Raw
-- reports remain immutable evidence, but cash/accounting consumers must choose
-- exactly one report copy per marketplace + settlement. Prefer a report whose
-- signed detail lines reconcile to Amazon's own report total, then the newest
-- successfully processed copy. This prevents duplicate/revised reports from
-- being double-counted when grouped only by settlement_id.

CREATE OR REPLACE VIEW mart.settlement_report_candidate AS
WITH report_settlement AS (
    SELECT
        l.marketplace_id,
        l.settlement_id,
        l.report_id,
        min(l.settlement_start_date) AS settlement_start_date,
        max(l.settlement_end_date) AS settlement_end_date,
        max(l.deposit_date) AS deposit_date,
        max(l.currency) AS currency,
        min(l.total_amount)::numeric(16,2) AS min_report_total,
        max(l.total_amount)::numeric(16,2) AS max_report_total,
        COALESCE(sum(l.amount),0)::numeric(16,2) AS line_sum,
        count(*)::integer AS line_count,
        r.created_time,
        r.processing_start_time,
        r.processing_end_time,
        r.fetched_at
    FROM core.settlement_line l
    JOIN core.settlement_report r USING (report_id)
    WHERE l.settlement_id IS NOT NULL
    GROUP BY
        l.marketplace_id,
        l.settlement_id,
        l.report_id,
        r.created_time,
        r.processing_start_time,
        r.processing_end_time,
        r.fetched_at
), scored AS (
    SELECT
        rs.*,
        (
            abs(COALESCE(rs.max_report_total,0) - COALESCE(rs.min_report_total,0)) <= 0.02
            AND rs.max_report_total IS NOT NULL
            AND abs(rs.line_sum - rs.max_report_total) <= 0.02
        ) AS is_reconciled,
        count(*) OVER (
            PARTITION BY rs.marketplace_id,rs.settlement_id
        )::integer AS report_versions
    FROM report_settlement rs
)
SELECT
    s.*,
    row_number() OVER (
        PARTITION BY s.marketplace_id,s.settlement_id
        ORDER BY
            s.is_reconciled DESC,
            s.processing_end_time DESC NULLS LAST,
            s.created_time DESC NULLS LAST,
            s.fetched_at DESC NULLS LAST,
            s.report_id DESC
    )::integer AS canonical_rank
FROM scored s;

COMMENT ON VIEW mart.settlement_report_candidate IS
'One row per report_id + settlement_id with reconciliation evidence. canonical_rank=1 selects one canonical report copy per marketplace + settlement, preferring a report whose signed lines reconcile to Amazon total and then the newest processed copy.';

CREATE OR REPLACE VIEW mart.settlement_canonical_report AS
SELECT *
FROM mart.settlement_report_candidate
WHERE canonical_rank=1;

COMMENT ON VIEW mart.settlement_canonical_report IS
'Exactly one canonical Amazon report copy per marketplace + settlement_id. Raw duplicate/revised reports remain in core.settlement_* for audit evidence but are not double-counted by trusted cash consumers.';

CREATE OR REPLACE VIEW mart.settlement_line_canonical AS
SELECT l.*
FROM core.settlement_line l
JOIN mart.settlement_canonical_report c
  ON c.marketplace_id=l.marketplace_id
 AND c.settlement_id=l.settlement_id
 AND c.report_id=l.report_id;

COMMENT ON VIEW mart.settlement_line_canonical IS
'Canonical settlement detail lines from exactly one selected Amazon report copy per marketplace + settlement_id.';

CREATE OR REPLACE VIEW mart.settlement_finance_line_canonical AS
SELECT l.*,
       CASE
         WHEN lower(COALESCE(amount_type,''))='itemprice'
              AND lower(COALESCE(amount_description,''))='principal' THEN 'product_sales'
         WHEN lower(COALESCE(amount_type,''))='itemprice'
              AND lower(COALESCE(amount_description,'')) LIKE '%tax%' THEN 'tax_collected'
         WHEN lower(COALESCE(amount_type,''))='itemwithheldtax'
              OR lower(COALESCE(amount_description,'')) LIKE '%withheld%tax%' THEN 'tax_withheld'
         WHEN lower(COALESCE(amount_type,''))='promotion' THEN 'promotions'
         WHEN lower(COALESCE(amount_type,''))='itemfees'
              AND lower(COALESCE(amount_description,'')) IN ('commission','referralfee') THEN 'selling_fees'
         WHEN lower(COALESCE(amount_type,''))='itemfees'
              AND (lower(COALESCE(amount_description,'')) LIKE '%fba%'
                   OR lower(COALESCE(amount_description,'')) LIKE '%fulfillment%') THEN 'fba_fees'
         WHEN lower(COALESCE(amount_type,''))='cost of advertising'
              OR lower(COALESCE(amount_description,'')) LIKE '%advertis%' THEN 'advertising'
         WHEN lower(COALESCE(amount_type,'')) LIKE '%fee%' THEN 'other_amazon_fees'
         WHEN lower(COALESCE(transaction_type,''))='refund' THEN 'refunds_other'
         ELSE 'other'
       END AS finance_category
FROM mart.settlement_line_canonical l;

COMMENT ON VIEW mart.settlement_finance_line_canonical IS
'Finance classification over canonical one-report-per-settlement detail. Use for trusted settlement cash analysis; raw mart.settlement_finance_line remains full ingestion evidence.';
