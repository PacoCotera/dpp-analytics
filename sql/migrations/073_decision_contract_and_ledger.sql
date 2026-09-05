CREATE SCHEMA IF NOT EXISTS decision;

CREATE TABLE decision.rule_definition (
    rule_key text NOT NULL,
    rule_version integer NOT NULL CHECK (rule_version > 0),
    domain text NOT NULL,
    kind text NOT NULL,
    lane text NOT NULL CHECK (lane IN ('PROTECT','ELIMINATE','CAPTURE','ALLOCATE','LEARN')),
    permitted_action_class text NOT NULL CHECK (permitted_action_class IN ('OBSERVE','INVESTIGATE','TEST','CHANGE','EXECUTE')),
    definition_status text NOT NULL CHECK (definition_status IN ('SKELETON','COMPLETE')),
    definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
    definition_sha256 text NOT NULL CHECK (definition_sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rule_key, rule_version),
    UNIQUE (domain, kind, rule_version)
);

COMMENT ON TABLE decision.rule_definition IS
'Immutable versioned rule catalog. SKELETON definitions remain DRAFT and cannot evaluate facts; COMPLETE is required before a SHADOW transition.';

CREATE TABLE decision.rule_lifecycle_event (
    event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    rule_key text NOT NULL,
    rule_version integer NOT NULL,
    from_lifecycle text,
    to_lifecycle text NOT NULL CHECK (to_lifecycle IN ('DRAFT','SHADOW','ACTIVE','PAUSED','RETIRED')),
    reason text NOT NULL,
    approval_reference text,
    actor text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (rule_key, rule_version)
        REFERENCES decision.rule_definition(rule_key, rule_version),
    CHECK (from_lifecycle IS NULL OR from_lifecycle IN ('DRAFT','SHADOW','ACTIVE','PAUSED','RETIRED')),
    CHECK (from_lifecycle IS DISTINCT FROM to_lifecycle),
    CHECK (to_lifecycle <> 'ACTIVE' OR NULLIF(btrim(approval_reference),'') IS NOT NULL)
);

CREATE INDEX rule_lifecycle_event_latest_idx
    ON decision.rule_lifecycle_event(rule_key, rule_version, occurred_at DESC, event_id DESC);

CREATE FUNCTION decision.validate_rule_lifecycle_event()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_lifecycle text;
    current_definition_status text;
    transition_allowed boolean := false;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW.rule_key || ':' || NEW.rule_version::text, 0)
    );
    SELECT definition_status INTO current_definition_status
    FROM decision.rule_definition
    WHERE rule_key=NEW.rule_key AND rule_version=NEW.rule_version;
    SELECT to_lifecycle INTO current_lifecycle
    FROM decision.rule_lifecycle_event
    WHERE rule_key=NEW.rule_key AND rule_version=NEW.rule_version
    ORDER BY occurred_at DESC,event_id DESC
    LIMIT 1;

    IF NEW.from_lifecycle IS DISTINCT FROM current_lifecycle THEN
        RAISE EXCEPTION 'stale rule lifecycle: expected %, recorded %',
            NEW.from_lifecycle,current_lifecycle;
    END IF;

    transition_allowed :=
        (current_lifecycle IS NULL AND NEW.to_lifecycle='DRAFT') OR
        (current_lifecycle='DRAFT' AND NEW.to_lifecycle IN ('SHADOW','RETIRED')) OR
        (current_lifecycle='SHADOW' AND NEW.to_lifecycle IN ('ACTIVE','PAUSED','RETIRED')) OR
        (current_lifecycle='ACTIVE' AND NEW.to_lifecycle IN ('PAUSED','RETIRED')) OR
        (current_lifecycle='PAUSED' AND NEW.to_lifecycle IN ('SHADOW','ACTIVE','RETIRED'));
    IF NOT transition_allowed THEN
        RAISE EXCEPTION 'rule lifecycle transition % -> % is not permitted',
            current_lifecycle,NEW.to_lifecycle;
    END IF;
    IF NEW.to_lifecycle IN ('SHADOW','ACTIVE')
       AND current_definition_status <> 'COMPLETE' THEN
        RAISE EXCEPTION 'complete rule definition required for %',NEW.to_lifecycle;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER validate_rule_lifecycle_event
BEFORE INSERT ON decision.rule_lifecycle_event
FOR EACH ROW EXECUTE FUNCTION decision.validate_rule_lifecycle_event();

CREATE VIEW decision.rule_current AS
SELECT definition.*,
       lifecycle.to_lifecycle AS lifecycle,
       lifecycle.reason AS lifecycle_reason,
       lifecycle.approval_reference AS lifecycle_approval_reference,
       lifecycle.actor AS lifecycle_actor,
       lifecycle.occurred_at AS lifecycle_changed_at
FROM decision.rule_definition AS definition
JOIN LATERAL (
    SELECT event.to_lifecycle,event.reason,event.approval_reference,event.actor,event.occurred_at
    FROM decision.rule_lifecycle_event AS event
    WHERE event.rule_key=definition.rule_key
      AND event.rule_version=definition.rule_version
    ORDER BY event.occurred_at DESC,event.event_id DESC
    LIMIT 1
) AS lifecycle ON true;

CREATE TABLE decision.candidate_snapshot (
    snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    candidate_id text NOT NULL CHECK (candidate_id ~ '^decision_[0-9a-f]{64}$'),
    fact_fingerprint text NOT NULL CHECK (fact_fingerprint ~ '^facts_[0-9a-f]{64}$'),
    contract_version integer NOT NULL CHECK (contract_version = 1),
    domain text NOT NULL,
    kind text NOT NULL,
    lane text NOT NULL CHECK (lane IN ('PROTECT','ELIMINATE','CAPTURE','ALLOCATE','LEARN')),
    candidate_state text NOT NULL CHECK (candidate_state IN (
        'SHADOW_CANDIDATE','OPEN','APPROVED','REJECTED','SNOOZED',
        'SUPERSEDED','EXPIRED','IN_PROGRESS','COMPLETED','EVALUATED'
    )),
    rule_key text NOT NULL,
    rule_version integer NOT NULL,
    rule_lifecycle text NOT NULL CHECK (rule_lifecycle IN ('SHADOW','ACTIVE','PAUSED','RETIRED')),
    subject_type text NOT NULL,
    marketplace_id text NOT NULL,
    subject_identity jsonb NOT NULL CHECK (jsonb_typeof(subject_identity) = 'object'),
    window_id text NOT NULL,
    window_start date NOT NULL,
    window_through date NOT NULL CHECK (window_through >= window_start),
    valid_until timestamptz NOT NULL,
    supersedes_snapshot_id bigint REFERENCES decision.candidate_snapshot(snapshot_id),
    state_reason text,
    candidate jsonb NOT NULL CHECK (jsonb_typeof(candidate) = 'object'),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (rule_key, rule_version)
        REFERENCES decision.rule_definition(rule_key, rule_version),
    UNIQUE (candidate_id, fact_fingerprint, candidate_state),
    CHECK (candidate ?& ARRAY[
        'contract_version','id','domain','lane','kind','state','rule','subject',
        'recommendation','materiality','confidence','window','evidence',
        'cross_domain_conditions','guardrails','blockers','suppression','destination',
        'created_at','valid_until','fact_fingerprint'
    ]),
    CHECK (candidate->>'id' = candidate_id),
    CHECK (candidate->>'fact_fingerprint' = fact_fingerprint),
    CHECK ((candidate->>'contract_version')::integer = contract_version),
    CHECK (candidate->>'state' = candidate_state),
    CHECK (candidate->'rule'->>'key' = rule_key),
    CHECK ((candidate->'rule'->>'version')::integer = rule_version),
    CHECK (candidate->'rule'->>'lifecycle' = rule_lifecycle)
);

CREATE INDEX candidate_snapshot_history_idx
    ON decision.candidate_snapshot(candidate_id, recorded_at DESC, snapshot_id DESC);
CREATE INDEX candidate_snapshot_queue_idx
    ON decision.candidate_snapshot(candidate_state, lane, valid_until);

CREATE FUNCTION decision.validate_candidate_snapshot_rule()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    current_lifecycle text;
    current_definition_status text;
BEGIN
    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW.rule_key || ':' || NEW.rule_version::text, 0)
    );
    SELECT lifecycle,definition_status
    INTO current_lifecycle,current_definition_status
    FROM decision.rule_current
    WHERE rule_key=NEW.rule_key AND rule_version=NEW.rule_version;
    IF current_lifecycle IS NULL THEN
        RAISE EXCEPTION 'candidate rule version is not registered';
    END IF;
    IF NEW.rule_lifecycle IS DISTINCT FROM current_lifecycle THEN
        RAISE EXCEPTION 'candidate lifecycle % does not match current rule lifecycle %',
            NEW.rule_lifecycle,current_lifecycle;
    END IF;
    IF current_lifecycle IN ('SHADOW','ACTIVE')
       AND current_definition_status <> 'COMPLETE' THEN
        RAISE EXCEPTION 'complete rule definition required for candidate evaluation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER validate_candidate_snapshot_rule
BEFORE INSERT ON decision.candidate_snapshot
FOR EACH ROW EXECUTE FUNCTION decision.validate_candidate_snapshot_rule();

CREATE VIEW decision.candidate_current AS
SELECT snapshot.*
FROM decision.candidate_snapshot AS snapshot
JOIN (
    SELECT candidate_id,max(snapshot_id) AS snapshot_id
    FROM decision.candidate_snapshot
    GROUP BY candidate_id
) AS latest USING (candidate_id,snapshot_id);

CREATE TABLE decision.disposition (
    disposition_id text PRIMARY KEY,
    candidate_snapshot_id bigint NOT NULL REFERENCES decision.candidate_snapshot(snapshot_id),
    disposition text NOT NULL CHECK (disposition IN ('APPROVED','REJECTED','SNOOZED')),
    operator_note text,
    approved_action jsonb CHECK (approved_action IS NULL OR jsonb_typeof(approved_action) = 'object'),
    owner text,
    due_at timestamptz,
    evaluation_at timestamptz,
    actor text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key text NOT NULL UNIQUE
);

CREATE TABLE decision.change_event (
    change_event_id text PRIMARY KEY,
    candidate_snapshot_id bigint REFERENCES decision.candidate_snapshot(snapshot_id),
    experiment_id text,
    entity_type text NOT NULL,
    entity_identity jsonb NOT NULL CHECK (jsonb_typeof(entity_identity) = 'object'),
    before_value jsonb NOT NULL,
    after_value jsonb NOT NULL,
    change_source text NOT NULL CHECK (change_source IN ('DPP','MANUAL_AMAZON_CONSOLE','EXTERNAL_UNKNOWN')),
    request_idempotency_key text,
    amazon_confirmation jsonb,
    rollback_value jsonb,
    rollback_state text NOT NULL CHECK (rollback_state IN ('NOT_REQUIRED','AVAILABLE','REQUESTED','COMPLETE','FAILED')),
    actor text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX change_event_idempotency_idx
    ON decision.change_event(request_idempotency_key)
    WHERE request_idempotency_key IS NOT NULL;

CREATE TABLE decision.experiment_snapshot (
    experiment_snapshot_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    experiment_id text NOT NULL,
    snapshot_fingerprint text NOT NULL CHECK (snapshot_fingerprint ~ '^experiment_[0-9a-f]{64}$'),
    candidate_snapshot_id bigint REFERENCES decision.candidate_snapshot(snapshot_id),
    lifecycle_state text NOT NULL CHECK (lifecycle_state IN (
        'DRAFT','APPROVED','ACTIVE','PAUSED','COMPLETED','CANCELLED','EVALUATED'
    )),
    hypothesis text NOT NULL,
    subject jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object'),
    treatment jsonb NOT NULL CHECK (jsonb_typeof(treatment) = 'object'),
    baseline_window jsonb NOT NULL CHECK (jsonb_typeof(baseline_window) = 'object'),
    evaluation_window jsonb NOT NULL CHECK (jsonb_typeof(evaluation_window) = 'object'),
    attribution_finality_delay_days integer NOT NULL CHECK (attribution_finality_delay_days >= 0),
    primary_outcome jsonb NOT NULL CHECK (jsonb_typeof(primary_outcome) = 'object'),
    guardrail_metrics jsonb NOT NULL CHECK (jsonb_typeof(guardrail_metrics) = 'array'),
    comparison_method text NOT NULL,
    planned_spend_cap numeric(18,4) CHECK (planned_spend_cap IS NULL OR planned_spend_cap >= 0),
    currency text,
    confounders jsonb NOT NULL CHECK (jsonb_typeof(confounders) = 'array'),
    exclusions jsonb NOT NULL CHECK (jsonb_typeof(exclusions) = 'array'),
    actor text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (experiment_id, snapshot_fingerprint, lifecycle_state)
);

CREATE INDEX experiment_snapshot_history_idx
    ON decision.experiment_snapshot(experiment_id, recorded_at DESC, experiment_snapshot_id DESC);

ALTER TABLE decision.change_event
    ADD COLUMN experiment_snapshot_id bigint,
    ADD CONSTRAINT change_event_experiment_snapshot_fk
    FOREIGN KEY (experiment_snapshot_id) REFERENCES decision.experiment_snapshot(experiment_snapshot_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE decision.outcome (
    outcome_id text PRIMARY KEY,
    experiment_snapshot_id bigint NOT NULL REFERENCES decision.experiment_snapshot(experiment_snapshot_id),
    eligible_evaluation_at timestamptz NOT NULL,
    evaluated_at timestamptz NOT NULL,
    baseline_facts jsonb NOT NULL CHECK (jsonb_typeof(baseline_facts) = 'object'),
    treatment_facts jsonb NOT NULL CHECK (jsonb_typeof(treatment_facts) = 'object'),
    truth_class text NOT NULL CHECK (truth_class IN (
        'DESCRIPTIVE','SENSITIVITY','FORECAST','QUASI_EXPERIMENTAL','CONTROLLED'
    )),
    result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
    result_interval jsonb,
    guardrail_breaches jsonb NOT NULL CHECK (jsonb_typeof(guardrail_breaches) = 'array'),
    conclusion text NOT NULL CHECK (conclusion IN ('CONTINUE','REVERT','EXTEND','INCONCLUSIVE')),
    rule_versions jsonb NOT NULL CHECK (jsonb_typeof(rule_versions) = 'array'),
    model_versions jsonb NOT NULL CHECK (jsonb_typeof(model_versions) = 'array'),
    evidence_references jsonb NOT NULL CHECK (jsonb_typeof(evidence_references) = 'array'),
    actor text NOT NULL,
    CHECK (evaluated_at >= eligible_evaluation_at)
);

CREATE FUNCTION decision.reject_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION '%.% is append-only',TG_TABLE_SCHEMA,TG_TABLE_NAME;
END
$$;

CREATE TRIGGER rule_definition_append_only
BEFORE UPDATE OR DELETE ON decision.rule_definition
FOR EACH ROW EXECUTE FUNCTION decision.reject_ledger_mutation();
CREATE TRIGGER rule_lifecycle_event_append_only
BEFORE UPDATE OR DELETE ON decision.rule_lifecycle_event
FOR EACH ROW EXECUTE FUNCTION decision.reject_ledger_mutation();
CREATE TRIGGER candidate_snapshot_append_only
BEFORE UPDATE OR DELETE ON decision.candidate_snapshot
FOR EACH ROW EXECUTE FUNCTION decision.reject_ledger_mutation();
CREATE TRIGGER disposition_append_only
BEFORE UPDATE OR DELETE ON decision.disposition
FOR EACH ROW EXECUTE FUNCTION decision.reject_ledger_mutation();
CREATE TRIGGER change_event_append_only
BEFORE UPDATE OR DELETE ON decision.change_event
FOR EACH ROW EXECUTE FUNCTION decision.reject_ledger_mutation();
CREATE TRIGGER experiment_snapshot_append_only
BEFORE UPDATE OR DELETE ON decision.experiment_snapshot
FOR EACH ROW EXECUTE FUNCTION decision.reject_ledger_mutation();
CREATE TRIGGER outcome_append_only
BEFORE UPDATE OR DELETE ON decision.outcome
FOR EACH ROW EXECUTE FUNCTION decision.reject_ledger_mutation();

WITH catalog(kind,lane,decision_question,minimum_evidence,action_class) AS (
    VALUES
      ('ADS_DATA_BLOCKER','PROTECT','Can any recommendation be trusted?','API-owned source/reconciliation state','INVESTIGATE'),
      ('ADS_INVENTORY_CONFLICT','PROTECT','Is paid support creating demand DPP cannot fulfill?','current offer, active spend, Inventory action, finalized Ads evidence','INVESTIGATE'),
      ('ADS_ECONOMIC_LEAKAGE','PROTECT','Is Ads consuming reconciled product contribution?','reconciled product economics and spend','INVESTIGATE'),
      ('ADS_QUERY_LEAKAGE','ELIMINATE','Is a mature paid query consuming meaningful spend without sufficient response?','finalized query spend/clicks plus economic guardrail','INVESTIGATE'),
      ('ADS_PRODUCT_CONVERSION_GAP','ELIMINATE','Does paid traffic fail at the product conversion stage?','paid traffic plus product/session/listing context','INVESTIGATE'),
      ('ADS_SQP_VISIBILITY_GAP','CAPTURE','Is DPP materially absent from relevant marketplace demand?','completed SQP period and current product','INVESTIGATE'),
      ('ADS_SQP_CLICK_GAP','CAPTURE','Are impressions failing to earn clicks?','current SQP evidence threshold','INVESTIGATE'),
      ('ADS_SQP_CART_GAP','CAPTURE','Are clicks failing to create cart intent?','current SQP evidence threshold','INVESTIGATE'),
      ('ADS_SQP_PURCHASE_GAP','CAPTURE','Are carts failing to become purchases?','current SQP evidence threshold','INVESTIGATE'),
      ('ADS_QUERY_TEST','CAPTURE','Does a query merit a dedicated controlled test?','repeated finalized response, current product, inventory and economics guardrails','TEST'),
      ('ADS_BUDGET_CONSTRAINT','ALLOCATE','Is an eligible campaign losing supported demand because it exhausts budget?','budget usage/recommendation plus economic and marginal evidence','TEST'),
      ('ADS_PRODUCT_ALLOCATION_TEST','ALLOCATE','Which product merits the next controlled peso?','reconciled economics, stock, demand, and prior outcomes','TEST'),
      ('ADS_EXPERIMENT_EVALUATION','LEARN','Did an intervention meet its declared success and guardrail criteria?','locked baseline, mature evaluation window, change evidence','INVESTIGATE')
), definitions AS (
    SELECT kind,
           lane,
           action_class,
           jsonb_build_object(
               'operator_problem',decision_question,
               'permitted_action_class',action_class,
               'subject_grains',jsonb_build_array('PENDING_RULE_SPECIFICATION'),
               'source_grains',jsonb_build_array('PENDING_RULE_SPECIFICATION'),
               'compatible_windows',jsonb_build_array('PENDING_RULE_SPECIFICATION'),
               'exact_inputs',jsonb_build_object(
                   'approval_state','NOT_APPROVED',
                   'minimum_governing_evidence',minimum_evidence
               ),
               'monetary_bases',jsonb_build_object('approval_state','NOT_APPROVED'),
               'eligibility',jsonb_build_object('approval_state','NOT_APPROVED'),
               'exclusions',jsonb_build_object('approval_state','NOT_APPROVED'),
               'thresholds',jsonb_build_object('approval_state','NOT_APPROVED'),
               'maturity_finality',jsonb_build_object('approval_state','NOT_APPROVED'),
               'economic_state_requirement',jsonb_build_object('approval_state','NOT_APPROVED'),
               'cross_domain_guardrails',jsonb_build_object('approval_state','NOT_APPROVED'),
               'materiality',jsonb_build_object('approval_state','NOT_APPROVED'),
               'confidence',jsonb_build_object('approval_state','NOT_APPROVED'),
               'conflict_priority',jsonb_build_object('approval_state','NOT_APPROVED'),
               'expiration_policy',jsonb_build_object('approval_state','NOT_APPROVED'),
               'destination',jsonb_build_object('view','decisions'),
               'outcome_metric',jsonb_build_object('approval_state','NOT_APPROVED'),
               'evaluation_window',jsonb_build_object('approval_state','NOT_APPROVED'),
               'rationale','Pending approved rule specification and production backtest.',
               'prohibited_claims',jsonb_build_array(
                   'incremental sales without causal evidence',
                   'profit or contribution without reconciled economics',
                   'forecast stated as fact'
               )
           ) AS definition
    FROM catalog
), inserted AS (
    INSERT INTO decision.rule_definition(
        rule_key,rule_version,domain,kind,lane,permitted_action_class,
        definition_status,definition,definition_sha256
    )
    SELECT kind,1,'ADVERTISING',kind,lane,action_class,'SKELETON',definition,
           encode(sha256(convert_to(definition::text,'UTF8')),'hex')
    FROM definitions
    RETURNING rule_key,rule_version
)
INSERT INTO decision.rule_lifecycle_event(
    rule_key,rule_version,from_lifecycle,to_lifecycle,reason,actor
)
SELECT rule_key,rule_version,NULL,'DRAFT',
       'Batch 2 catalog registration; thresholds and business policy are not approved.',
       'migration:073'
FROM inserted;

COMMENT ON TABLE decision.candidate_snapshot IS
'Append-only DecisionCandidate snapshots. Fact restatements append a fingerprinted snapshot and never rewrite decided history.';
COMMENT ON TABLE decision.disposition IS
'Immutable operator disposition against the exact candidate snapshot and fact fingerprint seen at decision time.';
COMMENT ON TABLE decision.change_event IS
'Observed or requested before/after changes. Contract version 1 records evidence but does not authorize Amazon mutation.';
COMMENT ON TABLE decision.experiment_snapshot IS
'Append-only experiment intent and lifecycle snapshots with a baseline locked before activation.';
COMMENT ON TABLE decision.outcome IS
'Immutable mature evaluation facts and conclusion for an experiment snapshot.';
