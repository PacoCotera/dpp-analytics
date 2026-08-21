-- Enforce Finance close immutability in the database, not only by application convention.
-- A closed management month is append-only. Historical correction means inserting
-- a new RESTATED version that explicitly supersedes the latest prior version.

CREATE OR REPLACE FUNCTION core.prevent_finance_close_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Finance close %.% v% is immutable; insert an explicit RESTATED version instead',
    OLD.marketplace_id, OLD.month, OLD.version;
END;
$$;

DROP TRIGGER IF EXISTS finance_month_close_immutable ON core.finance_month_close;
CREATE TRIGGER finance_month_close_immutable
BEFORE UPDATE OR DELETE ON core.finance_month_close
FOR EACH ROW EXECUTE FUNCTION core.prevent_finance_close_mutation();

DROP TRIGGER IF EXISTS finance_month_cogs_snapshot_immutable ON core.finance_month_cogs_snapshot;
CREATE TRIGGER finance_month_cogs_snapshot_immutable
BEFORE UPDATE OR DELETE ON core.finance_month_cogs_snapshot
FOR EACH ROW EXECUTE FUNCTION core.prevent_finance_close_mutation();

CREATE OR REPLACE FUNCTION core.validate_finance_close_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  latest_version integer;
  latest_state text;
BEGIN
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

DROP TRIGGER IF EXISTS finance_month_close_validate_insert ON core.finance_month_close;
CREATE TRIGGER finance_month_close_validate_insert
BEFORE INSERT ON core.finance_month_close
FOR EACH ROW EXECUTE FUNCTION core.validate_finance_close_insert();

CREATE OR REPLACE FUNCTION core.validate_finance_cogs_snapshot_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM core.finance_month_close c
    WHERE c.marketplace_id = NEW.marketplace_id
      AND c.month = NEW.month
      AND c.version = NEW.version
  ) THEN
    RAISE EXCEPTION
      'COGS snapshot %.% v% requires its immutable Finance close version',
      NEW.marketplace_id, NEW.month, NEW.version;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS finance_month_cogs_snapshot_validate_insert ON core.finance_month_cogs_snapshot;
CREATE TRIGGER finance_month_cogs_snapshot_validate_insert
BEFORE INSERT ON core.finance_month_cogs_snapshot
FOR EACH ROW EXECUTE FUNCTION core.validate_finance_cogs_snapshot_insert();

COMMENT ON FUNCTION core.prevent_finance_close_mutation() IS
  'Hard database guardrail: Finance close versions and their SKU COGS snapshots are append-only.';
COMMENT ON FUNCTION core.validate_finance_close_insert() IS
  'Requires a CLOSED v1 followed only by sequential RESTATED versions with explicit reason and superseded version.';
