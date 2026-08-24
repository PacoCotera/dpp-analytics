-- Keep one durable identity for the postal-capable geography collector.
UPDATE ops.ingestion_runs
SET job_name = 'orders_geography_state_v2026'
WHERE source = 'amazon_spapi'
  AND job_name = 'orders_geography_v2026';

DELETE FROM ops.ingestion_cursor legacy
WHERE legacy.source = 'amazon_spapi'
  AND legacy.job_name = 'orders_geography_v2026'
  AND EXISTS (
    SELECT 1 FROM ops.ingestion_cursor current
    WHERE current.source = legacy.source
      AND current.job_name = 'orders_geography_state_v2026'
      AND current.cursor_name = legacy.cursor_name
  );

UPDATE ops.ingestion_cursor
SET job_name = 'orders_geography_state_v2026'
WHERE source = 'amazon_spapi'
  AND job_name = 'orders_geography_v2026';
