-- Preserve the exact cross-domain facts and outputs used by each Advertising V2
-- shadow evaluation. This is separate from candidate_current: historical replay
-- must never append an old result as the current operator candidate or read facts
-- that arrived after the declared cutoff.

CREATE TABLE decision.shadow_evaluation (
    evaluation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    evaluator_key text NOT NULL CHECK (btrim(evaluator_key) <> ''),
    evaluator_version integer NOT NULL CHECK (evaluator_version > 0),
    marketplace_id text NOT NULL,
    evaluation_mode text NOT NULL CHECK (evaluation_mode IN ('CURRENT','POINT_IN_TIME_REPLAY')),
    captured_at timestamptz NOT NULL,
    replay_of_evaluation_id bigint REFERENCES decision.shadow_evaluation(evaluation_id),
    fact_fingerprint text NOT NULL CHECK (fact_fingerprint ~ '^facts_[0-9a-f]{64}$'),
    source_cutoffs jsonb NOT NULL CHECK (jsonb_typeof(source_cutoffs) = 'object'),
    rule_versions jsonb NOT NULL CHECK (jsonb_typeof(rule_versions) = 'object'),
    facts jsonb NOT NULL CHECK (jsonb_typeof(facts) = 'object'),
    candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
    candidate_count integer NOT NULL CHECK (candidate_count >= 0),
    suppressed_count integer NOT NULL CHECK (suppressed_count >= 0),
    expired_count integer NOT NULL CHECK (expired_count >= 0),
    candidate_snapshot_ids jsonb NOT NULL CHECK (jsonb_typeof(candidate_snapshot_ids) = 'array'),
    summary jsonb NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    CHECK (candidate_count = jsonb_array_length(candidates)),
    CHECK (suppressed_count <= candidate_count),
    CHECK (
        (evaluation_mode='CURRENT' AND replay_of_evaluation_id IS NULL)
        OR
        (evaluation_mode='POINT_IN_TIME_REPLAY' AND replay_of_evaluation_id IS NOT NULL)
    )
);

CREATE INDEX shadow_evaluation_capture_idx
    ON decision.shadow_evaluation(evaluator_key,marketplace_id,captured_at DESC,evaluation_id DESC)
    WHERE evaluation_mode='CURRENT';

CREATE INDEX shadow_evaluation_fingerprint_idx
    ON decision.shadow_evaluation(fact_fingerprint,evaluator_key,evaluator_version);

CREATE FUNCTION decision.validate_shadow_evaluation_replay()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    source decision.shadow_evaluation%ROWTYPE;
BEGIN
    IF NEW.evaluation_mode='CURRENT' THEN
        RETURN NEW;
    END IF;
    SELECT * INTO source
    FROM decision.shadow_evaluation
    WHERE evaluation_id=NEW.replay_of_evaluation_id;
    IF source.evaluation_id IS NULL OR source.evaluation_mode <> 'CURRENT' THEN
        RAISE EXCEPTION 'point-in-time replay must reference a CURRENT fact capture';
    END IF;
    IF source.evaluator_key IS DISTINCT FROM NEW.evaluator_key
       OR source.marketplace_id IS DISTINCT FROM NEW.marketplace_id
       OR source.captured_at IS DISTINCT FROM NEW.captured_at
       OR source.fact_fingerprint IS DISTINCT FROM NEW.fact_fingerprint
       OR source.source_cutoffs IS DISTINCT FROM NEW.source_cutoffs
       OR source.facts IS DISTINCT FROM NEW.facts THEN
        RAISE EXCEPTION 'point-in-time replay facts must exactly match the referenced CURRENT capture';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER validate_shadow_evaluation_replay
BEFORE INSERT ON decision.shadow_evaluation
FOR EACH ROW EXECUTE FUNCTION decision.validate_shadow_evaluation_replay();

CREATE TRIGGER shadow_evaluation_append_only
BEFORE UPDATE OR DELETE ON decision.shadow_evaluation
FOR EACH ROW EXECUTE FUNCTION decision.reject_ledger_mutation();

COMMENT ON TABLE decision.shadow_evaluation IS
'Immutable exact evaluator inputs and outputs. Historical replay selects a CURRENT capture at or before its requested cutoff and records a separate POINT_IN_TIME_REPLAY row without changing live candidates.';

COMMENT ON COLUMN decision.shadow_evaluation.captured_at IS
'For CURRENT rows, when DPP read and froze the cross-domain facts. For replay rows, the original CURRENT capture time represented by the replay.';

COMMENT ON COLUMN decision.shadow_evaluation.source_cutoffs IS
'Per-source availability timestamps; facts with different windows are preserved rather than silently aligned or back-projected.';
