BEGIN;

INSERT INTO decision.shadow_evaluation(
    evaluator_key,evaluator_version,marketplace_id,evaluation_mode,captured_at,
    fact_fingerprint,source_cutoffs,rule_versions,facts,candidates,
    candidate_count,suppressed_count,expired_count,candidate_snapshot_ids,summary
) VALUES (
    'ADS_INITIAL_SHADOW',1,'A1AM78C64UM0Y8','CURRENT','2026-09-05T01:00:00Z',
    'facts_' || repeat('a',64),
    '{"amazon_ads":"2026-09-05T00:30:00Z"}'::jsonb,
    '{"ADS_DATA_BLOCKER":2}'::jsonb,
    '{"window":{"through":"2026-09-04"},"products":[]}'::jsonb,
    '[]'::jsonb,0,0,0,'[]'::jsonb,'{"status":"success"}'::jsonb
) RETURNING evaluation_id \gset current_

INSERT INTO decision.shadow_evaluation(
    evaluator_key,evaluator_version,marketplace_id,evaluation_mode,captured_at,
    replay_of_evaluation_id,fact_fingerprint,source_cutoffs,rule_versions,facts,candidates,
    candidate_count,suppressed_count,expired_count,candidate_snapshot_ids,summary
) VALUES (
    'ADS_INITIAL_SHADOW',1,'A1AM78C64UM0Y8','POINT_IN_TIME_REPLAY','2026-09-05T01:00:00Z',
    :current_evaluation_id,
    'facts_' || repeat('a',64),
    '{"amazon_ads":"2026-09-05T00:30:00Z"}'::jsonb,
    '{"ADS_DATA_BLOCKER":2}'::jsonb,
    '{"window":{"through":"2026-09-04"},"products":[]}'::jsonb,
    '[]'::jsonb,0,0,0,'[]'::jsonb,'{"status":"success"}'::jsonb
);

DO $history$
BEGIN
    IF (SELECT count(*) FROM decision.shadow_evaluation) <> 2 THEN
        RAISE EXCEPTION 'current and replay evaluations did not survive round trip';
    END IF;
    BEGIN
        UPDATE decision.shadow_evaluation
        SET summary='{"status":"changed"}'::jsonb
        WHERE evaluation_mode='CURRENT';
        RAISE EXCEPTION 'shadow evaluation mutation was not blocked';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'shadow evaluation mutation was not blocked' THEN
            RAISE;
        END IF;
    END;
    BEGIN
        INSERT INTO decision.shadow_evaluation(
            evaluator_key,evaluator_version,marketplace_id,evaluation_mode,captured_at,
            fact_fingerprint,source_cutoffs,rule_versions,facts,candidates,
            candidate_count,suppressed_count,expired_count,candidate_snapshot_ids,summary
        ) VALUES (
            'ADS_INITIAL_SHADOW',1,'A1AM78C64UM0Y8','POINT_IN_TIME_REPLAY','2026-09-05T01:00:00Z',
            'facts_' || repeat('b',64),'{}','{}','{}','[]',0,0,0,'[]','{}'
        );
        RAISE EXCEPTION 'replay without source evaluation was not blocked';
    EXCEPTION WHEN raise_exception OR check_violation THEN
        NULL;
    END;
END
$history$;

ROLLBACK;
