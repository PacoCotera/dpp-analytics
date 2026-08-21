-- Business/product Ads marts aggregate advertiser accounts at marketplace grain.
-- Until an explicit FX layer exists, a marketplace must not silently contain
-- spend in multiple currencies. Reject that condition at the account boundary
-- rather than allowing mathematically valid but commercially meaningless sums.

CREATE OR REPLACE FUNCTION ads.guard_marketplace_currency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conflicting_currency text;
BEGIN
  IF NEW.marketplace_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.currency IS NULL OR btrim(NEW.currency) = '' THEN
    RAISE EXCEPTION 'Ads account % mapped to marketplace % has no currency',
      NEW.account_id, NEW.marketplace_id;
  END IF;

  NEW.currency := upper(NEW.currency);

  SELECT a.currency
    INTO conflicting_currency
    FROM ads.account a
   WHERE a.marketplace_id = NEW.marketplace_id
     AND a.account_id <> NEW.account_id
     AND upper(a.currency) <> NEW.currency
   LIMIT 1;

  IF conflicting_currency IS NOT NULL THEN
    RAISE EXCEPTION
      'Ads marketplace % would mix currencies (% and %). Add an explicit FX/consolidation layer before mapping account %.',
      NEW.marketplace_id, conflicting_currency, NEW.currency, NEW.account_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ads_account_marketplace_currency_guard ON ads.account;
CREATE TRIGGER ads_account_marketplace_currency_guard
BEFORE INSERT OR UPDATE OF marketplace_id, currency ON ads.account
FOR EACH ROW EXECUTE FUNCTION ads.guard_marketplace_currency();

-- Fail migration loudly if historical account metadata already violates the
-- invariant. This is preferable to deploying TACOS/ROAS built from mixed money.
DO $$
DECLARE
  bad record;
BEGIN
  SELECT marketplace_id,
         string_agg(DISTINCT upper(currency), ', ' ORDER BY upper(currency)) AS currencies
    INTO bad
    FROM ads.account
   WHERE marketplace_id IS NOT NULL
   GROUP BY marketplace_id
  HAVING count(DISTINCT upper(currency)) > 1
   LIMIT 1;

  IF bad.marketplace_id IS NOT NULL THEN
    RAISE EXCEPTION 'Existing Ads marketplace % mixes currencies: %',
      bad.marketplace_id, bad.currencies;
  END IF;
END;
$$;
