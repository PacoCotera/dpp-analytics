-- Finance managers need Amazon's settlement statement shape, not only event totals.
-- Settlement reports are generated automatically by Amazon and expose normalized
-- amount-type / amount-description rows suitable for sales, tax and fee reporting.
CREATE TABLE IF NOT EXISTS core.settlement_report (
    report_id text PRIMARY KEY,
    marketplace_id text NOT NULL,
    report_document_id text NOT NULL,
    created_time timestamptz,
    processing_start_time timestamptz,
    processing_end_time timestamptz,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    row_count integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS core.settlement_line (
    report_id text NOT NULL REFERENCES core.settlement_report(report_id) ON DELETE CASCADE,
    row_number integer NOT NULL,
    marketplace_id text NOT NULL,
    settlement_id text,
    settlement_start_date timestamptz,
    settlement_end_date timestamptz,
    deposit_date timestamptz,
    total_amount numeric(16,2),
    currency text,
    transaction_type text,
    order_id text,
    merchant_order_id text,
    adjustment_id text,
    shipment_id text,
    marketplace_name text,
    amount_type text,
    amount_description text,
    amount numeric(16,2),
    fulfillment_id text,
    posted_date_time timestamptz,
    sku text,
    quantity_purchased numeric(16,4),
    raw_row jsonb NOT NULL,
    PRIMARY KEY (report_id,row_number)
);
CREATE INDEX IF NOT EXISTS settlement_line_market_date_idx
    ON core.settlement_line(marketplace_id,posted_date_time);
CREATE INDEX IF NOT EXISTS settlement_line_settlement_idx
    ON core.settlement_line(marketplace_id,settlement_id);
CREATE INDEX IF NOT EXISTS settlement_line_amount_idx
    ON core.settlement_line(marketplace_id,amount_type,amount_description);

-- A finance-manager-friendly normalization. Keep the raw source rows too because
-- Amazon can add amount descriptions over time.
CREATE OR REPLACE VIEW mart.settlement_finance_line AS
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
FROM core.settlement_line l;
