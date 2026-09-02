-- Normalize the Sponsored Products target fact after historical migration drift.
--
-- Production originally created ads.daily_target in migration 013 with the
-- account/target/date primary key. A later edit added a different definition to
-- already-applied migration 010, so clean databases inherited a wider key while
-- production kept the original one. Forward migrations, not edits to applied
-- history, must make both paths converge.

DO $$
DECLARE
    target_relation regclass := to_regclass('ads.daily_target');
    primary_key_name text;
    primary_key_columns text[];
BEGIN
    IF target_relation IS NULL THEN
        RAISE EXCEPTION 'ads.daily_target must exist before migration 060';
    END IF;

    SELECT
        constraint_row.conname,
        array_agg(attribute_row.attname ORDER BY key_column.ordinality)
    INTO primary_key_name, primary_key_columns
    FROM pg_constraint constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey)
        WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute attribute_row
      ON attribute_row.attrelid = constraint_row.conrelid
     AND attribute_row.attnum = key_column.attnum
    WHERE constraint_row.conrelid = target_relation
      AND constraint_row.contype = 'p'
    GROUP BY constraint_row.conname;

    IF primary_key_columns IS DISTINCT FROM ARRAY['account_id', 'target_id', 'business_date']::text[] THEN
        IF primary_key_name IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE ads.daily_target DROP CONSTRAINT %I',
                primary_key_name
            );
        END IF;

        ALTER TABLE ads.daily_target
            ADD CONSTRAINT daily_target_pkey
            PRIMARY KEY (account_id, target_id, business_date);
    END IF;
END
$$;

COMMENT ON TABLE ads.daily_target IS
'Daily Sponsored Products targeting facts keyed by account, stable target identifier and business date. Campaign, ad group and ad product remain reported dimensions rather than conflict-key columns.';
