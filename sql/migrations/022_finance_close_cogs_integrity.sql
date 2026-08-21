-- A management close and its SKU COGS detail are one accounting artifact.
-- Validate the pair at transaction commit so callers can insert the close header first
-- and then its SKU rows without exposing a committed half-close.

CREATE OR REPLACE FUNCTION core.validate_finance_close_cogs_integrity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  close_marketplace text;
  close_month date;
  close_version integer;
  expected_cogs numeric(16,2);
  snapshot_cogs numeric(16,2);
  snapshot_rows integer;
BEGIN
  close_marketplace := COALESCE(NEW.marketplace_id, OLD.marketplace_id);
  close_month := COALESCE(NEW.month, OLD.month);
  close_version := COALESCE(NEW.version, OLD.version);

  SELECT c.product_cogs
    INTO expected_cogs
  FROM core.finance_month_close c
  WHERE c.marketplace_id = close_marketplace
    AND c.month = close_month
    AND c.version = close_version;

  -- A COGS-row trigger can run after a transaction that removed its parent only
  -- during rollback/cascade paths. There is no surviving close to validate then.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(round(sum(s.extended_cogs), 2), 0), count(*)::int
    INTO snapshot_cogs, snapshot_rows
  FROM core.finance_month_cogs_snapshot s
  WHERE s.marketplace_id = close_marketplace
    AND s.month = close_month
    AND s.version = close_version;

  IF snapshot_cogs IS DISTINCT FROM round(expected_cogs, 2) THEN
    RAISE EXCEPTION
      'Finance close %.% v% COGS mismatch: header %, SKU snapshot % across % rows',
      close_marketplace, close_month, close_version,
      expected_cogs, snapshot_cogs, snapshot_rows;
  END IF;

  IF expected_cogs <> 0 AND snapshot_rows = 0 THEN
    RAISE EXCEPTION
      'Finance close %.% v% has product COGS % but no SKU-level COGS snapshot',
      close_marketplace, close_month, close_version, expected_cogs;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS finance_close_cogs_integrity_from_close ON core.finance_month_close;
CREATE CONSTRAINT TRIGGER finance_close_cogs_integrity_from_close
AFTER INSERT ON core.finance_month_close
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.validate_finance_close_cogs_integrity();

DROP TRIGGER IF EXISTS finance_close_cogs_integrity_from_snapshot ON core.finance_month_cogs_snapshot;
CREATE CONSTRAINT TRIGGER finance_close_cogs_integrity_from_snapshot
AFTER INSERT ON core.finance_month_cogs_snapshot
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION core.validate_finance_close_cogs_integrity();

COMMENT ON FUNCTION core.validate_finance_close_cogs_integrity() IS
  'Commit-time guardrail: immutable Finance close product_cogs must equal the frozen SKU-level COGS snapshot; non-zero COGS requires snapshot rows.';
