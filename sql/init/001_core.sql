CREATE SCHEMA IF NOT EXISTS raw;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS mart;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE TABLE IF NOT EXISTS ops.ingestion_runs (
    id bigserial PRIMARY KEY,
    source text NOT NULL,
    job_name text NOT NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    status text NOT NULL DEFAULT 'running',
    records_read bigint,
    records_written bigint,
    error_message text,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ingestion_runs_source_started_idx
    ON ops.ingestion_runs (source, started_at DESC);

CREATE TABLE IF NOT EXISTS core.sku (
    sku text PRIMARY KEY,
    asin text,
    title text,
    collection text,
    product_line text,
    launch_date date,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS core.sku_cost_history (
    id bigserial PRIMARY KEY,
    sku text NOT NULL REFERENCES core.sku(sku),
    effective_from date NOT NULL,
    effective_to date,
    unit_cogs numeric(12,4) NOT NULL,
    currency char(3) NOT NULL DEFAULT 'MXN',
    notes text,
    UNIQUE (sku, effective_from)
);

CREATE VIEW ops.data_health AS
SELECT
    source,
    job_name,
    max(started_at) AS last_started_at,
    max(finished_at) FILTER (WHERE status = 'success') AS last_success_at,
    (array_agg(status ORDER BY started_at DESC))[1] AS latest_status
FROM ops.ingestion_runs
GROUP BY source, job_name;
