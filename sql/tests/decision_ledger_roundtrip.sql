BEGIN;

INSERT INTO decision.rule_definition(
    rule_key,rule_version,domain,kind,lane,permitted_action_class,
    definition_status,definition,definition_sha256
) VALUES (
    'TEST_DECISION_ROUNDTRIP',1,'ADVERTISING','TEST_DECISION_ROUNDTRIP','PROTECT','INVESTIGATE',
    'COMPLETE','{"test":true}'::jsonb,repeat('a',64)
);

INSERT INTO decision.rule_lifecycle_event(
    rule_key,rule_version,from_lifecycle,to_lifecycle,reason,actor
) VALUES (
    'TEST_DECISION_ROUNDTRIP',1,NULL,'DRAFT','Register migration-chain round-trip fixture','ci'
);

INSERT INTO decision.rule_lifecycle_event(
    rule_key,rule_version,from_lifecycle,to_lifecycle,reason,actor
) VALUES (
    'TEST_DECISION_ROUNDTRIP',1,'DRAFT','SHADOW','Enable migration-chain shadow fixture','ci'
);

DO $test$
DECLARE
    v_candidate_id text := 'decision_' || repeat('1',64);
    first_fingerprint text := 'facts_' || repeat('2',64);
    second_fingerprint text := 'facts_' || repeat('3',64);
    first_candidate jsonb;
    second_candidate jsonb;
    loaded_candidate jsonb;
    first_snapshot bigint;
    second_snapshot bigint;
    experiment_snapshot bigint;
BEGIN
    first_candidate := jsonb_build_object(
        'contract_version',1,
        'id',v_candidate_id,
        'domain','ADVERTISING',
        'lane','PROTECT',
        'kind','TEST_DECISION_ROUNDTRIP',
        'state','SHADOW_CANDIDATE',
        'rule',jsonb_build_object('key','TEST_DECISION_ROUNDTRIP','version',1,'lifecycle','SHADOW'),
        'subject',jsonb_build_object('type','PRODUCT','marketplace_id','A1AM78C64UM0Y8','sku','TEST-1','label','Test product'),
        'recommendation',jsonb_build_object(
            'action_type','INSPECT_DATA','action_class','INVESTIGATE','title','Inspect test evidence',
            'rationale','Migration-chain fixture','parameters',jsonb_build_object(),'execution_state','SHADOW_ONLY'
        ),
        'materiality',jsonb_build_object(
            'type','OBSERVED_EXPOSURE','currency','MXN','amount',0,'low',NULL,'high',NULL,'basis','Fixture'
        ),
        'confidence',jsonb_build_object('band','HIGH','basis','DETERMINISTIC_EVIDENCE','reasons',jsonb_build_array()),
        'window',jsonb_build_object('id','ADS_FINALIZED_T28','start','2026-08-01','through','2026-08-28','state','RECONCILED'),
        'evidence',jsonb_build_array(jsonb_build_object(
            'fact','test.fact','value',1,'unit','COUNT','basis','Fixture','source','ci',
            'window','ADS_FINALIZED_T28','cutoff','2026-08-28T00:00:00Z'
        )),
        'cross_domain_conditions',jsonb_build_array(),
        'guardrails',jsonb_build_array(),
        'blockers',jsonb_build_array(),
        'suppression',NULL,
        'destination',jsonb_build_object('view','decisions'),
        'created_at','2026-08-29T00:00:00Z',
        'valid_until','2026-09-30T00:00:00Z',
        'fact_fingerprint',first_fingerprint
    );

    INSERT INTO decision.candidate_snapshot(
        candidate_id,fact_fingerprint,contract_version,domain,kind,lane,candidate_state,
        rule_key,rule_version,rule_lifecycle,subject_type,marketplace_id,subject_identity,
        window_id,window_start,window_through,valid_until,candidate
    ) VALUES (
        v_candidate_id,first_fingerprint,1,'ADVERTISING','TEST_DECISION_ROUNDTRIP','PROTECT','SHADOW_CANDIDATE',
        'TEST_DECISION_ROUNDTRIP',1,'SHADOW','PRODUCT','A1AM78C64UM0Y8',
        '{"type":"PRODUCT","marketplace_id":"A1AM78C64UM0Y8","sku":"TEST-1"}'::jsonb,
        'ADS_FINALIZED_T28','2026-08-01','2026-08-28','2026-09-30T00:00:00Z',first_candidate
    ) RETURNING snapshot_id INTO first_snapshot;

    SELECT candidate INTO loaded_candidate
    FROM decision.candidate_snapshot
    WHERE snapshot_id=first_snapshot;
    IF loaded_candidate IS DISTINCT FROM first_candidate THEN
        RAISE EXCEPTION 'candidate JSON did not survive round trip';
    END IF;

    second_candidate := jsonb_set(first_candidate,'{fact_fingerprint}',to_jsonb(second_fingerprint));
    INSERT INTO decision.candidate_snapshot(
        candidate_id,fact_fingerprint,contract_version,domain,kind,lane,candidate_state,
        rule_key,rule_version,rule_lifecycle,subject_type,marketplace_id,subject_identity,
        window_id,window_start,window_through,valid_until,supersedes_snapshot_id,state_reason,candidate
    ) VALUES (
        v_candidate_id,second_fingerprint,1,'ADVERTISING','TEST_DECISION_ROUNDTRIP','PROTECT','SHADOW_CANDIDATE',
        'TEST_DECISION_ROUNDTRIP',1,'SHADOW','PRODUCT','A1AM78C64UM0Y8',
        '{"type":"PRODUCT","marketplace_id":"A1AM78C64UM0Y8","sku":"TEST-1"}'::jsonb,
        'ADS_FINALIZED_T28','2026-08-01','2026-08-28','2026-09-30T00:00:00Z',
        first_snapshot,'source restatement',second_candidate
    ) RETURNING snapshot_id INTO second_snapshot;

    IF (SELECT supersedes_snapshot_id FROM decision.candidate_snapshot WHERE snapshot_id=second_snapshot)
       IS DISTINCT FROM first_snapshot THEN
        RAISE EXCEPTION 'candidate supersession link did not survive round trip';
    END IF;

    INSERT INTO decision.disposition(
        disposition_id,candidate_snapshot_id,disposition,operator_note,approved_action,
        actor,idempotency_key
    ) VALUES (
        'disposition_test',second_snapshot,'SNOOZED','Await final attribution',NULL,
        'ci','disposition-roundtrip'
    );

    INSERT INTO decision.experiment_snapshot(
        experiment_id,snapshot_fingerprint,candidate_snapshot_id,lifecycle_state,hypothesis,subject,treatment,
        baseline_window,evaluation_window,attribution_finality_delay_days,primary_outcome,
        guardrail_metrics,comparison_method,planned_spend_cap,currency,confounders,exclusions,actor
    ) VALUES (
        'experiment_test','experiment_' || repeat('4',64),second_snapshot,'ACTIVE','A bounded treatment can be evaluated.',
        '{"type":"QUERY","query_key":"test"}'::jsonb,
        '{"action":"OBSERVE"}'::jsonb,
        '{"start":"2026-08-01","through":"2026-08-28","locked_at":"2026-08-29T00:00:00Z"}'::jsonb,
        '{"start":"2026-09-01","through":"2026-09-14"}'::jsonb,
        7,'{"fact":"visits"}'::jsonb,'[]'::jsonb,'Locked pre/post descriptive comparison',
        100,'MXN','[]'::jsonb,'[]'::jsonb,'ci'
    ) RETURNING experiment_snapshot_id INTO experiment_snapshot;

    INSERT INTO decision.change_event(
        change_event_id,candidate_snapshot_id,experiment_id,experiment_snapshot_id,
        entity_type,entity_identity,before_value,after_value,change_source,
        rollback_state,actor
    ) VALUES (
        'change_test',second_snapshot,'experiment_test',experiment_snapshot,
        'KEYWORD','{"keyword_id":"test"}'::jsonb,'{"state":"PAUSED"}'::jsonb,
        '{"state":"ENABLED"}'::jsonb,'MANUAL_AMAZON_CONSOLE','AVAILABLE','ci'
    );

    INSERT INTO decision.outcome(
        outcome_id,experiment_snapshot_id,eligible_evaluation_at,evaluated_at,
        baseline_facts,treatment_facts,truth_class,result,result_interval,
        guardrail_breaches,conclusion,rule_versions,model_versions,evidence_references,actor
    ) VALUES (
        'outcome_test',experiment_snapshot,'2026-09-21T00:00:00Z','2026-09-22T00:00:00Z',
        '{"visits":10}'::jsonb,'{"visits":12}'::jsonb,'DESCRIPTIVE',
        '{"difference":2}'::jsonb,NULL,'[]'::jsonb,'INCONCLUSIVE',
        '[{"key":"TEST_DECISION_ROUNDTRIP","version":1}]'::jsonb,'[]'::jsonb,
        '["ads.query_day:2026-09-14"]'::jsonb,'ci'
    );

    IF (SELECT count(*) FROM decision.candidate_snapshot WHERE candidate_id=v_candidate_id) <> 2 THEN
        RAISE EXCEPTION 'candidate history did not retain both fact snapshots';
    END IF;
    IF (SELECT count(*) FROM decision.disposition WHERE candidate_snapshot_id=second_snapshot) <> 1
       OR (SELECT count(*) FROM decision.change_event WHERE experiment_snapshot_id=experiment_snapshot) <> 1
       OR (SELECT count(*) FROM decision.outcome WHERE experiment_snapshot_id=experiment_snapshot) <> 1 THEN
        RAISE EXCEPTION 'ledger entities did not survive round trip';
    END IF;

    BEGIN
        UPDATE decision.candidate_snapshot
        SET state_reason='mutation must fail'
        WHERE snapshot_id=second_snapshot;
        RAISE EXCEPTION 'append-only mutation was not blocked';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM = 'append-only mutation was not blocked' THEN
            RAISE;
        END IF;
    END;
END
$test$;

ROLLBACK;
