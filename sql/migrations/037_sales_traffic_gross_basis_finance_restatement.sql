-- Production evidence proved Amazon Sales & Traffic orderedProductSales for DPP MX
-- is shopper-facing spend including IVA, not net revenue ex IVA.
--
-- On 2026-08-21, 25 matched days had:
--   Sales & Traffic       16,385.49
--   Orders gross incl IVA 16,396.39
--   Orders ex IVA         14,134.82
-- Therefore operating Sales/Home/Catalog/Product/Trajectory use the Amazon
-- reported gross shopper-spend basis. Finance alone derives net revenue ex IVA.
-- Existing immutable Finance closes were created under the opposite assumption,
-- so this migration APPENDS explicit RESTATED versions. It never mutates v1.

ALTER TABLE core.marketplace_tax_policy
  ADD COLUMN IF NOT EXISTS sales_traffic_amount_basis text
  CHECK (sales_traffic_amount_basis IN ('SHOPPER_SPEND_INCL_TAX','NET_SALES_EX_TAX','UNKNOWN'));

UPDATE core.marketplace_tax_policy p
SET sales_traffic_amount_basis='SHOPPER_SPEND_INCL_TAX',
    policy_note=concat_ws(' ',NULLIF(p.policy_note,''),
      'Production reconciliation confirms Amazon Sales & Traffic orderedProductSales is shopper spend including IVA.'),
    updated_at=now()
FROM core.marketplace m
WHERE m.marketplace_id=p.marketplace_id
  AND m.country_code='MX'
  AND p.sales_traffic_amount_basis IS DISTINCT FROM 'SHOPPER_SPEND_INCL_TAX';

COMMENT ON COLUMN core.marketplace_tax_policy.sales_traffic_amount_basis IS
'Observed monetary basis of Amazon Sales & Traffic orderedProductSales for this marketplace. DPP MX is empirically SHOPPER_SPEND_INCL_TAX; Finance must remove IVA before treating it as revenue.';

-- Preserve exactly which immutable version is being corrected before inserting
-- a new latest version. Only rows not already marked with the corrected basis
-- are candidates.
CREATE TEMP TABLE _finance_basis_restatement ON COMMIT DROP AS
SELECT
  c.*,
  c.version + 1 AS new_version,
  p.standard_vat_rate AS vat_rate,
  round(c.net_sales_ex_vat / (1 + p.standard_vat_rate), 2)::numeric(16,2) AS corrected_net_sales,
  c.net_sales_ex_vat::numeric(16,2) AS corrected_gross_spend
FROM mart.finance_month_close_latest c
JOIN core.marketplace_tax_policy p USING (marketplace_id)
WHERE p.sales_traffic_amount_basis='SHOPPER_SPEND_INCL_TAX'
  AND COALESCE(c.close_basis->>'sales_tax_basis','') <> 'SHOPPER_SPEND_INCL_VAT_SOURCE';

INSERT INTO core.finance_month_close (
  marketplace_id,month,version,state,supersedes_version,restatement_reason,
  net_sales_ex_vat,iva_on_sales,shopper_product_spend,
  amazon_order_net,amazon_order_effect,advertising,other_amazon_postings,
  product_cogs,contribution_after_product_cogs,contribution_margin_pct,
  cash_transferred,close_basis
)
SELECT
  marketplace_id,
  month,
  new_version,
  'RESTATED',
  version,
  'Correct Sales & Traffic tax basis: orderedProductSales is shopper spend including IVA; prior close treated it as net ex IVA.',
  corrected_net_sales,
  round(corrected_gross_spend - corrected_net_sales,2),
  corrected_gross_spend,
  amazon_order_net,
  round(amazon_order_net - corrected_net_sales,2),
  advertising,
  other_amazon_postings,
  product_cogs,
  contribution_after_product_cogs,
  CASE WHEN corrected_net_sales <> 0
       THEN round(100.0 * contribution_after_product_cogs / corrected_net_sales,2)
       ELSE NULL END,
  cash_transferred,
  close_basis || jsonb_build_object(
    'sales_source','Amazon Sales & Traffic orderedProductSales',
    'sales_tax_basis','SHOPPER_SPEND_INCL_VAT_SOURCE',
    'sales_basis_correction',true,
    'sales_basis_restatement_from_version',version,
    'vat_rate',vat_rate
  )
FROM _finance_basis_restatement
ORDER BY marketplace_id,month;

-- A close version and its COGS detail are one immutable artifact. Clone the
-- exact frozen SKU costs into the restatement so product-cost history is not
-- altered by this sales-basis correction.
INSERT INTO core.finance_month_cogs_snapshot (
  marketplace_id,month,version,seller_sku,units,unit_cogs,extended_cogs
)
SELECT
  s.marketplace_id,s.month,r.new_version,s.seller_sku,
  s.units,s.unit_cogs,s.extended_cogs
FROM _finance_basis_restatement r
JOIN core.finance_month_cogs_snapshot s
  ON s.marketplace_id=r.marketplace_id
 AND s.month=r.month
 AND s.version=r.version;

COMMENT ON TABLE core.finance_month_close IS
'Immutable management-close versions. Amazon Sales & Traffic is interpreted according to marketplace tax-basis policy; DPP MX gross orderedProductSales is converted to net ex IVA only inside Finance. Historical corrections append RESTATED versions.';
