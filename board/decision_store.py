from __future__ import annotations

from datetime import datetime, timezone
from hashlib import sha256
from typing import Any, Mapping

from decision_contract import canonical_json, subject_identity, validate_candidate


DECIDED_STATES = ("APPROVED", "REJECTED", "SNOOZED")
EXPERIMENT_STATES = ("DRAFT", "APPROVED", "ACTIVE", "PAUSED", "COMPLETED", "CANCELLED", "EVALUATED")
OUTCOME_TRUTH_CLASSES = ("DESCRIPTIVE", "SENSITIVITY", "FORECAST", "QUASI_EXPERIMENTAL", "CONTROLLED")
OUTCOME_CONCLUSIONS = ("CONTINUE", "REVERT", "EXTEND", "INCONCLUSIVE")
RULE_TRANSITIONS = {
    "DRAFT": ("SHADOW", "RETIRED"),
    "SHADOW": ("ACTIVE", "PAUSED", "RETIRED"),
    "ACTIVE": ("PAUSED", "RETIRED"),
    "PAUSED": ("SHADOW", "ACTIVE", "RETIRED"),
    "RETIRED": (),
}


class DecisionStoreError(ValueError):
    pass


def _row_value(row: Any, key: str, index: int = 0) -> Any:
    if row is None:
        return None
    if isinstance(row, Mapping):
        return row.get(key)
    return row[index]


def _timestamp(value: Any, name: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError) as exc:
        raise DecisionStoreError(f"{name} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise DecisionStoreError(f"{name} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _stable_event_id(prefix: str, idempotency_key: str) -> str:
    material = f"{prefix}|{idempotency_key}".encode("utf-8")
    return f"{prefix}_{sha256(material).hexdigest()}"


def experiment_fingerprint(experiment: Mapping[str, Any]) -> str:
    facts = {
        key: experiment.get(key)
        for key in (
            "hypothesis",
            "subject",
            "treatment",
            "baseline_window",
            "evaluation_window",
            "attribution_finality_delay_days",
            "primary_outcome",
            "guardrail_metrics",
            "comparison_method",
            "planned_spend_cap",
            "currency",
            "confounders",
            "exclusions",
        )
    }
    return f"experiment_{sha256(canonical_json(facts).encode('utf-8')).hexdigest()}"


def transition_rule_lifecycle(
    cur,
    *,
    rule_key: str,
    rule_version: int,
    to_lifecycle: str,
    reason: str,
    actor: str,
    approval_reference: str | None = None,
) -> int:
    if not reason.strip() or not actor.strip():
        raise DecisionStoreError("rule lifecycle reason and actor are required")
    cur.execute(
        """
        SELECT lifecycle,definition_status
        FROM decision.rule_current
        WHERE rule_key=%s AND rule_version=%s
        """,
        (rule_key, rule_version),
    )
    current = cur.fetchone()
    if not current:
        raise DecisionStoreError("rule version is not registered")
    from_lifecycle = str(_row_value(current, "lifecycle", 0))
    definition_status = str(_row_value(current, "definition_status", 1))
    if to_lifecycle not in RULE_TRANSITIONS.get(from_lifecycle, ()):
        raise DecisionStoreError(f"rule transition {from_lifecycle} -> {to_lifecycle} is not permitted")
    if to_lifecycle in ("SHADOW", "ACTIVE") and definition_status != "COMPLETE":
        raise DecisionStoreError("a complete rule definition is required before evaluation")
    if to_lifecycle == "ACTIVE" and not str(approval_reference or "").strip():
        raise DecisionStoreError("ACTIVE requires a recorded business approval reference")
    cur.execute(
        """
        INSERT INTO decision.rule_lifecycle_event(
            rule_key,rule_version,from_lifecycle,to_lifecycle,reason,approval_reference,actor
        ) VALUES (%s,%s,%s,%s,%s,%s,%s)
        RETURNING event_id
        """,
        (rule_key, rule_version, from_lifecycle, to_lifecycle, reason, approval_reference, actor),
    )
    return int(_row_value(cur.fetchone(), "event_id", 0))


def persist_candidate(cur, candidate: Mapping[str, Any], *, state_reason: str | None = None) -> int:
    """Append one validated fact/state snapshot and return its immutable row ID."""
    validate_candidate(candidate)
    rule = candidate["rule"]
    cur.execute(
        """
        SELECT lifecycle,definition_status
        FROM decision.rule_current
        WHERE rule_key=%s AND rule_version=%s
        """,
        (rule["key"], rule["version"]),
    )
    registered = cur.fetchone()
    if not registered:
        raise DecisionStoreError("candidate rule version is not registered")
    recorded_lifecycle = _row_value(registered, "lifecycle", 0)
    definition_status = _row_value(registered, "definition_status", 1)
    if recorded_lifecycle != rule["lifecycle"]:
        raise DecisionStoreError("candidate rule lifecycle does not match the persisted catalog")
    if recorded_lifecycle in ("SHADOW", "ACTIVE") and definition_status != "COMPLETE":
        raise DecisionStoreError("a complete rule definition is required before evaluation")

    valid_until = _timestamp(candidate["valid_until"], "valid_until")
    if valid_until <= datetime.now(timezone.utc) and candidate["state"] != "EXPIRED":
        raise DecisionStoreError("an expired candidate must be recorded with EXPIRED state")

    cur.execute(
        """
        SELECT snapshot_id,fact_fingerprint,candidate_state
        FROM decision.candidate_snapshot
        WHERE candidate_id=%s
        ORDER BY snapshot_id DESC
        LIMIT 1
        """,
        (candidate["id"],),
    )
    latest = cur.fetchone()
    if (
        latest
        and _row_value(latest, "fact_fingerprint", 1) == candidate["fact_fingerprint"]
        and _row_value(latest, "candidate_state", 2) == candidate["state"]
    ):
        return int(_row_value(latest, "snapshot_id", 0))

    window = candidate["window"]
    subject = candidate["subject"]
    cur.execute(
        """
        INSERT INTO decision.candidate_snapshot(
            candidate_id,fact_fingerprint,contract_version,domain,kind,lane,candidate_state,
            rule_key,rule_version,rule_lifecycle,subject_type,marketplace_id,subject_identity,
            window_id,window_start,window_through,valid_until,supersedes_snapshot_id,state_reason,candidate
        ) VALUES (
            %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,%s,%s::jsonb
        )
        RETURNING snapshot_id
        """,
        (
            candidate["id"],
            candidate["fact_fingerprint"],
            candidate["contract_version"],
            candidate["domain"],
            candidate["kind"],
            candidate["lane"],
            candidate["state"],
            rule["key"],
            rule["version"],
            rule["lifecycle"],
            subject["type"],
            subject["marketplace_id"],
            canonical_json(subject_identity(subject)),
            window["id"],
            window["start"],
            window["through"],
            candidate["valid_until"],
            _row_value(latest, "snapshot_id", 0),
            state_reason,
            canonical_json(candidate),
        ),
    )
    inserted = cur.fetchone()
    if not inserted:
        raise DecisionStoreError("candidate snapshot was not persisted")
    return int(_row_value(inserted, "snapshot_id", 0))


def load_candidate(cur, snapshot_id: int) -> dict[str, Any] | None:
    cur.execute(
        "SELECT candidate FROM decision.candidate_snapshot WHERE snapshot_id=%s",
        (snapshot_id,),
    )
    row = cur.fetchone()
    return _row_value(row, "candidate", 0) if row else None


def record_disposition(
    cur,
    *,
    candidate_snapshot_id: int,
    disposition: str,
    actor: str,
    idempotency_key: str,
    operator_note: str | None = None,
    approved_action: Mapping[str, Any] | None = None,
    owner: str | None = None,
    due_at: str | None = None,
    evaluation_at: str | None = None,
) -> str:
    if disposition not in DECIDED_STATES:
        raise DecisionStoreError("unsupported operator disposition")
    if not actor.strip() or not idempotency_key.strip():
        raise DecisionStoreError("actor and idempotency_key are required")
    cur.execute(
        """
        SELECT candidate_state,rule_lifecycle,candidate
        FROM decision.candidate_snapshot
        WHERE snapshot_id=%s
        """,
        (candidate_snapshot_id,),
    )
    snapshot = cur.fetchone()
    if not snapshot:
        raise DecisionStoreError("candidate snapshot does not exist")
    candidate_state = _row_value(snapshot, "candidate_state", 0)
    rule_lifecycle = _row_value(snapshot, "rule_lifecycle", 1)
    candidate = _row_value(snapshot, "candidate", 2) or {}
    if candidate_state != "OPEN" or rule_lifecycle != "ACTIVE":
        raise DecisionStoreError("only an OPEN candidate from an ACTIVE rule can receive an operator disposition")
    if disposition == "APPROVED":
        if not approved_action:
            raise DecisionStoreError("APPROVED requires the exact approved action and parameters")
        permitted = ((candidate.get("recommendation") or {}).get("action_class"))
        approved_class = approved_action.get("action_class")
        action_strength = {"OBSERVE": 0, "INVESTIGATE": 1, "TEST": 2, "CHANGE": 3, "EXECUTE": 4}
        if approved_class not in action_strength or permitted not in action_strength:
            raise DecisionStoreError("approved action class is invalid")
        if action_strength[approved_class] > action_strength[permitted]:
            raise DecisionStoreError("operator disposition cannot promote the candidate action class")
        if approved_class == "EXECUTE":
            raise DecisionStoreError("contract version 1 cannot approve Amazon execution")
    disposition_id = _stable_event_id("disposition", idempotency_key)
    cur.execute(
        """
        INSERT INTO decision.disposition(
            disposition_id,candidate_snapshot_id,disposition,operator_note,approved_action,
            owner,due_at,evaluation_at,actor,idempotency_key
        ) VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s)
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING disposition_id
        """,
        (
            disposition_id,
            candidate_snapshot_id,
            disposition,
            operator_note,
            canonical_json(approved_action) if approved_action is not None else None,
            owner,
            due_at,
            evaluation_at,
            actor,
            idempotency_key,
        ),
    )
    inserted = cur.fetchone()
    if inserted:
        return str(_row_value(inserted, "disposition_id", 0))
    cur.execute(
        "SELECT disposition_id FROM decision.disposition WHERE idempotency_key=%s",
        (idempotency_key,),
    )
    return str(_row_value(cur.fetchone(), "disposition_id", 0))


def record_change_event(cur, event: Mapping[str, Any]) -> str:
    required = (
        "entity_type",
        "entity_identity",
        "before_value",
        "after_value",
        "change_source",
        "rollback_state",
        "actor",
        "idempotency_key",
    )
    missing = [field for field in required if event.get(field) in (None, "")]
    if missing:
        raise DecisionStoreError(f"change event missing: {', '.join(missing)}")
    if event["change_source"] not in ("DPP", "MANUAL_AMAZON_CONSOLE", "EXTERNAL_UNKNOWN"):
        raise DecisionStoreError("unsupported change source")
    change_event_id = _stable_event_id("change", str(event["idempotency_key"]))
    cur.execute(
        """
        INSERT INTO decision.change_event(
            change_event_id,candidate_snapshot_id,experiment_id,experiment_snapshot_id,
            entity_type,entity_identity,before_value,after_value,change_source,
            request_idempotency_key,amazon_confirmation,rollback_value,rollback_state,actor,occurred_at
        ) VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s,%s,%s::jsonb,%s::jsonb,%s,%s,%s)
        ON CONFLICT (change_event_id) DO NOTHING
        RETURNING change_event_id
        """,
        (
            change_event_id,
            event.get("candidate_snapshot_id"),
            event.get("experiment_id"),
            event.get("experiment_snapshot_id"),
            event["entity_type"],
            canonical_json(event["entity_identity"]),
            canonical_json(event["before_value"]),
            canonical_json(event["after_value"]),
            event["change_source"],
            event.get("request_idempotency_key"),
            canonical_json(event.get("amazon_confirmation")) if event.get("amazon_confirmation") is not None else None,
            canonical_json(event.get("rollback_value")) if event.get("rollback_value") is not None else None,
            event["rollback_state"],
            event["actor"],
            event.get("occurred_at") or datetime.now(timezone.utc).isoformat(),
        ),
    )
    row = cur.fetchone()
    return str(_row_value(row, "change_event_id", 0) or change_event_id)


def persist_experiment(cur, experiment: Mapping[str, Any]) -> int:
    required = (
        "experiment_id",
        "lifecycle_state",
        "hypothesis",
        "subject",
        "treatment",
        "baseline_window",
        "evaluation_window",
        "attribution_finality_delay_days",
        "primary_outcome",
        "guardrail_metrics",
        "comparison_method",
        "confounders",
        "exclusions",
        "actor",
    )
    missing = [field for field in required if field not in experiment or experiment[field] in (None, "")]
    if missing:
        raise DecisionStoreError(f"experiment missing: {', '.join(missing)}")
    if experiment["lifecycle_state"] not in EXPERIMENT_STATES:
        raise DecisionStoreError("unsupported experiment lifecycle")
    baseline = experiment["baseline_window"]
    if experiment["lifecycle_state"] in ("ACTIVE", "COMPLETED", "EVALUATED") and not baseline.get("locked_at"):
        raise DecisionStoreError("the baseline window must be locked before experiment activation")
    fingerprint = experiment_fingerprint(experiment)
    cur.execute(
        """
        SELECT experiment_snapshot_id
        FROM decision.experiment_snapshot
        WHERE experiment_id=%s AND snapshot_fingerprint=%s AND lifecycle_state=%s
        """,
        (experiment["experiment_id"], fingerprint, experiment["lifecycle_state"]),
    )
    existing = cur.fetchone()
    if existing:
        return int(_row_value(existing, "experiment_snapshot_id", 0))
    cur.execute(
        """
        INSERT INTO decision.experiment_snapshot(
            experiment_id,snapshot_fingerprint,candidate_snapshot_id,lifecycle_state,hypothesis,subject,treatment,
            baseline_window,evaluation_window,attribution_finality_delay_days,primary_outcome,
            guardrail_metrics,comparison_method,planned_spend_cap,currency,confounders,exclusions,actor
        ) VALUES (%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s::jsonb,%s,%s::jsonb,%s::jsonb,%s,%s,%s,%s::jsonb,%s::jsonb,%s)
        RETURNING experiment_snapshot_id
        """,
        (
            experiment["experiment_id"],
            fingerprint,
            experiment.get("candidate_snapshot_id"),
            experiment["lifecycle_state"],
            experiment["hypothesis"],
            canonical_json(experiment["subject"]),
            canonical_json(experiment["treatment"]),
            canonical_json(baseline),
            canonical_json(experiment["evaluation_window"]),
            experiment["attribution_finality_delay_days"],
            canonical_json(experiment["primary_outcome"]),
            canonical_json(experiment["guardrail_metrics"]),
            experiment["comparison_method"],
            experiment.get("planned_spend_cap"),
            experiment.get("currency"),
            canonical_json(experiment["confounders"]),
            canonical_json(experiment["exclusions"]),
            experiment["actor"],
        ),
    )
    return int(_row_value(cur.fetchone(), "experiment_snapshot_id", 0))


def record_outcome(cur, outcome: Mapping[str, Any]) -> str:
    required = (
        "outcome_id",
        "experiment_snapshot_id",
        "eligible_evaluation_at",
        "evaluated_at",
        "baseline_facts",
        "treatment_facts",
        "truth_class",
        "result",
        "guardrail_breaches",
        "conclusion",
        "rule_versions",
        "model_versions",
        "evidence_references",
        "actor",
    )
    missing = [field for field in required if field not in outcome or outcome[field] in (None, "")]
    if missing:
        raise DecisionStoreError(f"outcome missing: {', '.join(missing)}")
    if outcome["truth_class"] not in OUTCOME_TRUTH_CLASSES:
        raise DecisionStoreError("unsupported outcome truth class")
    if outcome["conclusion"] not in OUTCOME_CONCLUSIONS:
        raise DecisionStoreError("unsupported outcome conclusion")
    if _timestamp(outcome["evaluated_at"], "evaluated_at") < _timestamp(
        outcome["eligible_evaluation_at"], "eligible_evaluation_at"
    ):
        raise DecisionStoreError("outcome cannot be evaluated before its eligible date")
    cur.execute(
        """
        INSERT INTO decision.outcome(
            outcome_id,experiment_snapshot_id,eligible_evaluation_at,evaluated_at,
            baseline_facts,treatment_facts,truth_class,result,result_interval,
            guardrail_breaches,conclusion,rule_versions,model_versions,evidence_references,actor
        ) VALUES (%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s,%s::jsonb,%s::jsonb,%s::jsonb,%s)
        RETURNING outcome_id
        """,
        (
            outcome["outcome_id"],
            outcome["experiment_snapshot_id"],
            outcome["eligible_evaluation_at"],
            outcome["evaluated_at"],
            canonical_json(outcome["baseline_facts"]),
            canonical_json(outcome["treatment_facts"]),
            outcome["truth_class"],
            canonical_json(outcome["result"]),
            canonical_json(outcome.get("result_interval")) if outcome.get("result_interval") is not None else None,
            canonical_json(outcome["guardrail_breaches"]),
            outcome["conclusion"],
            canonical_json(outcome["rule_versions"]),
            canonical_json(outcome["model_versions"]),
            canonical_json(outcome["evidence_references"]),
            outcome["actor"],
        ),
    )
    return str(_row_value(cur.fetchone(), "outcome_id", 0))
