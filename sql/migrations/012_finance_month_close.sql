CREATE TABLE IF NOT EXISTS core.finance_month_close (
    marketplace_id text NOT NULL,
    month date NOT NULL,
    version integer NOT NULL DEFAULT 1,
    state text NOT NULL DEFAULT 'CLOSED' CHECK (state IN ('CLOSED','RESTATED')),
    supersedes_version integer,
    restatement_reason text,
    net_sales_ex_vat numeric(16,2) NOT NULL,
    iva_on_sales numeric(16,2) NOT NULL,
    shopper_product_spend numeric(16,2) NOT NULL,
    amazon_order_net numeric(16,2) NOT NULL,
    amazon_order_effect numeric(16,2) NOT NULL,
    advertising numeric(16,2) NOT NULL,
    other_amazon_postings numeric(16,2) NOT NULL DEFAULT 0,
    product_cogs numeric(16,2) NOT NULL,
    contribution_after_product_cogs numeric(16,2) NOT NULL,
    contribution_margin_pct numeric(8,2),
    cash_transferred numeric(16,2) NOT NULL DEFAULT 0,
    closed_at timestamptz NOT NULL DEFAULT now(),
    close_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (marketplace_id, month, version),
    CHECK ((state='CLOSED' AND supersedes_version IS NULL) OR state='RESTATED')
);

CREATE TABLE IF NOT EXISTS core.finance_month_cogs_snapshot (
    marketplace_id text NOT NULL,
    month date NOT NULL,
    version integer NOT NULL DEFAULT 1,
    seller_sku text NOT NULL,
    units bigint NOT NULL,
    unit_cogs numeric(16,4) NOT NULL,
    extended_cogs numeric(16,2) NOT NULL,
    snapshotted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (marketplace_id, month, version, seller_sku),
    FOREIGN KEY (marketplace_id, month, version)
      REFERENCES core.finance_month_close (marketplace_id, month, version)
      ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS finance_month_close_latest_idx
  ON core.finance_month_close (marketplace_id, month, version DESC);

CREATE VIEW mart.finance_month_close_latest AS
SELECT DISTINCT ON (marketplace_id, month)
       marketplace_id, month, version, state, supersedes_version, restatement_reason,
       net_sales_ex_vat, iva_on_sales, shopper_product_spend,
       amazon_order_net, amazon_order_effect, advertising, other_amazon_postings,
       product_cogs, contribution_after_product_cogs, contribution_margin_pct,
       cash_transferred, closed_at, close_basis
FROM core.finance_month_close
ORDER BY marketplace_id, month, version DESC;

COMMENT ON TABLE core.finance_month_close IS
  'Immutable management-close versions. Standard product-cost edits never silently restate historical months.';
COMMENT ON TABLE core.finance_month_cogs_snapshot IS
  'SKU-level COGS frozen at monthly close. Historical changes require an explicit new RESTATED close version.';
COMMENT ON VIEW mart.finance_month_close_latest IS
  'Latest immutable management-close version per marketplace and month.';
