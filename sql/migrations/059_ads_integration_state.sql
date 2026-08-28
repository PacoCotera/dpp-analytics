CREATE TABLE IF NOT EXISTS ops.integration_state (
    integration text PRIMARY KEY,
    state text NOT NULL CHECK (
        state IN (
            'NOT_CONNECTED',
            'AUTHORIZATION_PENDING',
            'BACKFILL_RUNNING',
            'READY',
            'FAILED'
        )
    ),
    detail_code text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE ops.integration_state IS
'Current non-secret integration lifecycle published by the owning worker. Amazon Ads uses NOT_CONNECTED, AUTHORIZATION_PENDING, BACKFILL_RUNNING, READY, or FAILED; reporting quality remains a separate contract.';

COMMENT ON COLUMN ops.integration_state.detail_code IS
'Non-secret machine-readable reason for the current lifecycle state. Credentials and raw provider errors are never stored here.';
