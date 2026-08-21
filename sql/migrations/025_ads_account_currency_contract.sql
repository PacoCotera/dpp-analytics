-- Amazon Ads fact currency belongs to the advertiser account, not the DPP MX
-- deployment default.  Reporting ingestion currently starts with Sponsored
-- Products/Mexico, but facts must remain safe when additional advertiser
-- accounts and marketplaces are enabled.
--
-- Keep the account dimension authoritative: every fact write resolves currency
-- from ads.account. This deliberately overrides any transport/default value so
-- a future non-MXN account cannot silently contaminate spend/ROAS/ACOS marts.

CREATE OR REPLACE FUNCTION ads.apply_account_currency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_currency text;
BEGIN
  SELECT a.currency
    INTO account_currency
    FROM ads.account a
   WHERE a.account_id = NEW.account_id;

  IF account_currency IS NULL OR btrim(account_currency) = '' THEN
    RAISE EXCEPTION 'Ads account % has no currency; refusing fact write to %',
      NEW.account_id, TG_TABLE_NAME;
  END IF;

  NEW.currency := upper(account_currency);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ads_daily_account_currency ON ads.daily_account;
CREATE TRIGGER ads_daily_account_currency
BEFORE INSERT OR UPDATE ON ads.daily_account
FOR EACH ROW EXECUTE FUNCTION ads.apply_account_currency();

DROP TRIGGER IF EXISTS ads_daily_campaign_currency ON ads.daily_campaign;
CREATE TRIGGER ads_daily_campaign_currency
BEFORE INSERT OR UPDATE ON ads.daily_campaign
FOR EACH ROW EXECUTE FUNCTION ads.apply_account_currency();

DROP TRIGGER IF EXISTS ads_daily_product_currency ON ads.daily_advertised_product;
CREATE TRIGGER ads_daily_product_currency
BEFORE INSERT OR UPDATE ON ads.daily_advertised_product
FOR EACH ROW EXECUTE FUNCTION ads.apply_account_currency();

DROP TRIGGER IF EXISTS ads_daily_target_currency ON ads.daily_target;
CREATE TRIGGER ads_daily_target_currency
BEFORE INSERT OR UPDATE ON ads.daily_target
FOR EACH ROW EXECUTE FUNCTION ads.apply_account_currency();

DROP TRIGGER IF EXISTS ads_daily_search_term_currency ON ads.daily_search_term;
CREATE TRIGGER ads_daily_search_term_currency
BEFORE INSERT OR UPDATE ON ads.daily_search_term
FOR EACH ROW EXECUTE FUNCTION ads.apply_account_currency();

-- Repair any pre-existing rows using the same authority. This is idempotent and
-- intentionally does not perform FX conversion: each fact remains denominated
-- in its native advertiser-account currency. Cross-currency consolidation must
-- be explicit at the mart/application layer rather than silently summing money.
UPDATE ads.daily_account f
   SET currency = a.currency
  FROM ads.account a
 WHERE a.account_id = f.account_id
   AND f.currency IS DISTINCT FROM a.currency;

UPDATE ads.daily_campaign f
   SET currency = a.currency
  FROM ads.account a
 WHERE a.account_id = f.account_id
   AND f.currency IS DISTINCT FROM a.currency;

UPDATE ads.daily_advertised_product f
   SET currency = a.currency
  FROM ads.account a
 WHERE a.account_id = f.account_id
   AND f.currency IS DISTINCT FROM a.currency;

UPDATE ads.daily_target f
   SET currency = a.currency
  FROM ads.account a
 WHERE a.account_id = f.account_id
   AND f.currency IS DISTINCT FROM a.currency;

UPDATE ads.daily_search_term f
   SET currency = a.currency
  FROM ads.account a
 WHERE a.account_id = f.account_id
   AND f.currency IS DISTINCT FROM a.currency;
