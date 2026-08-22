-- Hard guard for every future immutable Finance close.
--
-- DPP Mexico production evidence establishes Amazon Sales & Traffic
-- orderedProductSales as shopper-facing spend including IVA. Finance must remove
-- IVA before storing management revenue. Migration 037 restates legacy closes;
-- this migration prevents a future worker or manual close from reintroducing the
-- old tax-basis error.

CREATE OR REPLACE FUNCTION core.validate_finance_close_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest_version integer;
  latest_state text;
  source_basis text;
  vat_rate numeric;
  expected_net numeric(16,2);
  expected_iva numeric(16,2);
BEGIN
  SELECT p.sales_traffic_amount_basis, p.standard_vat_rate
    INTO source_basis, vat_rate
  FROM core.marketplace_tax_policy p
  WHERE p.marketplace_id = NEW.marketplace_id;

  IF source_basis = 'SHOPPER_SPEND_INCL_TAX' THEN
    expected_net := round(NEW.shopper_product_spend / (1 + vat_rate), 2);
    expected_iva := round(NEW.shopper_product_spend - expected_net, 2);

    IF abs(COALESCE(NEW.net_sales_ex_vat,0) - expected_net) > 0.02 THEN
      RAISE EXCEPTION
        'Finance close %.% v% tax basis invalid: net sales % must equal gross % / (1 + VAT %%) = %',
        NEW.marketplace_id, NEW.month, NEW.version,
        NEW.net_sales_ex_vat, NEW.shopper_product_spend, vat_rate, expected_net;
    END IF;

    IF abs(COALESCE(NEW.iva_on_sales,0) - expected_iva) > 0.02 THEN
      RAISE EXCEPTION
        'Finance close %.% v% tax basis invalid: IVA % must equal gross % - net % = %',
        NEW.marketplace_id, NEW.month, NEW.version,
        NEW.iva_on_sales, NEW.shopper_product_spend, NEW.net_sales_ex_vat, expected_iva;
    END IF;

    NEW.close_basis := COALESCE(NEW.close_basis, '{}'::jsonb) || jsonb_build_object(
      'sales_source', 'Amazon Sales & Traffic orderedProductSales',
      'sales_traffic_amount_basis', source_basis,
      'sales_tax_basis', 'SHOPPER_SPEND_INCL_VAT_SOURCE',
      'sales_tax_transform', 'net=gross/(1+vat); iva=gross-net',
      'vat_rate', vat_rate
    );
  END IF;

  SELECT version, state
    INTO latest_version, latest_state
  FROM core.finance_month_close
  WHERE marketplace_id = NEW.marketplace_id
    AND month = NEW.month
  ORDER BY version DESC
  LIMIT 1;

  IF latest_version IS NULL THEN
    IF NEW.version <> 1 OR NEW.state <> 'CLOSED' OR NEW.supersedes_version IS NOT NULL THEN
      RAISE EXCEPTION
        'First Finance close for %.% must be CLOSED version 1 with no supersedes_version',
        NEW.marketplace_id, NEW.month;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state <> 'RESTATED' THEN
    RAISE EXCEPTION
      'Finance close %.% already exists; subsequent versions must be RESTATED',
      NEW.marketplace_id, NEW.month;
  END IF;

  IF NEW.version <> latest_version + 1 THEN
    RAISE EXCEPTION
      'Finance restatement %.% must be version %, got %',
      NEW.marketplace_id, NEW.month, latest_version + 1, NEW.version;
  END IF;

  IF NEW.supersedes_version IS DISTINCT FROM latest_version THEN
    RAISE EXCEPTION
      'Finance restatement %.% v% must supersede latest version %',
      NEW.marketplace_id, NEW.month, NEW.version, latest_version;
  END IF;

  IF NULLIF(btrim(NEW.restatement_reason), '') IS NULL THEN
    RAISE EXCEPTION
      'Finance restatement %.% v% requires a non-empty restatement_reason',
      NEW.marketplace_id, NEW.month, NEW.version;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION core.validate_finance_close_insert() IS
  'Enforces immutable close version sequencing and marketplace tax-basis arithmetic before a Finance close is inserted. DPP MX gross Sales & Traffic must be translated to net revenue + IVA explicitly.';
