CREATE TABLE IF NOT EXISTS ops.manual_sync_request (
    id bigserial PRIMARY KEY,
    job_name text NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT now(),
    requested_by text,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','success','error')),
    started_at timestamptz,
    finished_at timestamptz,
    error_message text
);

CREATE UNIQUE INDEX IF NOT EXISTS manual_sync_single_flight_idx
    ON ops.manual_sync_request(job_name)
    WHERE status IN ('pending','running');

CREATE INDEX IF NOT EXISTS manual_sync_recent_idx
    ON ops.manual_sync_request(requested_at DESC);
