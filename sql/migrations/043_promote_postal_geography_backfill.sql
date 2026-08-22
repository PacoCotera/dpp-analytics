-- The first RECIPIENT geography run predated postal-code retention and therefore
-- recorded a successful state/country-only backfill under orders_geography_v2026.
-- Preserve that run as historical evidence under an explicit legacy job name so
-- the scheduler sees the postal-capable job as never run and executes it once at
-- the next worker startup. Do not disturb later postal-capable success history.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM core.amazon_order
        WHERE nullif(btrim(destination_postal_code),'') IS NOT NULL
    ) THEN
        UPDATE ops.ingestion_runs
        SET job_name = 'orders_geography_state_v2026'
        WHERE source = 'amazon_spapi'
          AND job_name = 'orders_geography_v2026';
    END IF;
END $$;
