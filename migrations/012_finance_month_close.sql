CREATE TABLE IF NOT EXISTS core.finance_month_close (
    marketplace_id text NOT NULL,
    month date NOT NULL,
    version integer NOT NULL DEFAULT 1,
    state text NOT NULL DEFAULT 'CLOSED' CHECK (state IN ('CLOSED','RESTATED')),
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
    PRIMARY KEY (marketplace_id, month, version)
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

COMMENT ON TABLE core.finance_month_close IS
  'Immutable management close versions. Standard product-cost edits never silently restate historical months.';
COMMENT ON TABLE core.finance_month_cogs_snapshot IS
  'SKU-level COGS frozen at monthly close. Historical changes require an explicit new close/restatement version.';
