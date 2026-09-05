from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from hashlib import sha256
import json
import math
from typing import Any, Literal, Mapping, NotRequired, TypedDict, cast


CONTRACT_VERSION = 1
DOMAINS = ("ADVERTISING",)
LANES = ("PROTECT", "ELIMINATE", "CAPTURE", "ALLOCATE", "LEARN")
RULE_LIFECYCLES = ("DRAFT", "SHADOW", "ACTIVE", "PAUSED", "RETIRED")
CANDIDATE_STATES = (
    "SHADOW_CANDIDATE",
    "OPEN",
    "APPROVED",
    "REJECTED",
    "SNOOZED",
    "SUPERSEDED",
    "EXPIRED",
    "IN_PROGRESS",
    "COMPLETED",
    "EVALUATED",
)
ACTION_CLASSES = ("OBSERVE", "INVESTIGATE", "TEST", "CHANGE", "EXECUTE")
MATERIALITY_TYPES = (
    "OBSERVED_EXPOSURE",
    "SENSITIVITY_SCENARIO",
    "FORECAST",
    "CAUSAL_ESTIMATE",
)
CONFIDENCE_BANDS = ("LOW", "MEDIUM", "HIGH")


class RuleContract(TypedDict):
    key: str
    version: int
    lifecycle: Literal["DRAFT", "SHADOW", "ACTIVE", "PAUSED", "RETIRED"]


class SubjectContract(TypedDict):
    type: str
    marketplace_id: str
    label: str
    account_id: NotRequired[str]
    sku: NotRequired[str]
    asin: NotRequired[str]
    query_key: NotRequired[str]
    campaign_id: NotRequired[str]
    ad_group_id: NotRequired[str]
    target_id: NotRequired[str]
    placement: NotRequired[str]


class RecommendationContract(TypedDict):
    action_type: str
    action_class: Literal["OBSERVE", "INVESTIGATE", "TEST", "CHANGE", "EXECUTE"]
    title: str
    rationale: str
    parameters: dict[str, Any]
    execution_state: str


class MaterialityContract(TypedDict):
    type: Literal["OBSERVED_EXPOSURE", "SENSITIVITY_SCENARIO", "FORECAST", "CAUSAL_ESTIMATE"]
    currency: str
    amount: int | float
    low: int | float | None
    high: int | float | None
    basis: str
    assumptions: NotRequired[list[Any]]
    horizon: NotRequired[dict[str, Any] | str]
    eligibility: NotRequired[dict[str, Any] | str]


class ConfidenceContract(TypedDict):
    band: Literal["LOW", "MEDIUM", "HIGH"]
    basis: str
    reasons: list[str]


class WindowContract(TypedDict):
    id: str
    start: str
    through: str
    state: str


class EvidenceContract(TypedDict):
    fact: str
    value: Any
    unit: str
    basis: str
    source: str
    window: str
    cutoff: str


class DecisionCandidate(TypedDict):
    contract_version: Literal[1]
    id: str
    domain: Literal["ADVERTISING"]
    lane: Literal["PROTECT", "ELIMINATE", "CAPTURE", "ALLOCATE", "LEARN"]
    kind: str
    state: str
    rule: RuleContract
    subject: SubjectContract
    recommendation: RecommendationContract
    materiality: MaterialityContract
    confidence: ConfidenceContract
    window: WindowContract
    evidence: list[EvidenceContract]
    cross_domain_conditions: list[dict[str, Any]]
    guardrails: list[Any]
    blockers: list[dict[str, Any]]
    suppression: dict[str, Any] | None
    destination: dict[str, Any]
    created_at: str
    valid_until: str
    fact_fingerprint: str

_REQUIRED_TOP_LEVEL = (
    "contract_version",
    "id",
    "domain",
    "lane",
    "kind",
    "state",
    "rule",
    "subject",
    "recommendation",
    "materiality",
    "confidence",
    "window",
    "evidence",
    "cross_domain_conditions",
    "guardrails",
    "blockers",
    "suppression",
    "destination",
    "created_at",
    "valid_until",
    "fact_fingerprint",
)


class DecisionContractError(ValueError):
    def __init__(self, errors: list[str]):
        self.errors = tuple(errors)
        super().__init__("; ".join(errors))


def _canonical_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _canonical_value(item) for key, item in sorted(value.items(), key=lambda pair: str(pair[0]))}
    if isinstance(value, (list, tuple)):
        return [_canonical_value(item) for item in value]
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("naive datetimes are not canonical")
        return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value, "f")
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("non-finite numbers are not canonical")
    return value


def canonical_json(value: Any) -> str:
    return json.dumps(
        _canonical_value(value),
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _digest(prefix: str, value: Any) -> str:
    return f"{prefix}_{sha256(canonical_json(value).encode('utf-8')).hexdigest()}"


def subject_identity(subject: Mapping[str, Any]) -> dict[str, Any]:
    identity_fields = (
        "type",
        "marketplace_id",
        "account_id",
        "sku",
        "asin",
        "query_key",
        "campaign_id",
        "ad_group_id",
        "target_id",
        "placement",
    )
    return {
        field: subject[field]
        for field in identity_fields
        if subject.get(field) not in (None, "")
    }


def stable_candidate_id(candidate: Mapping[str, Any]) -> str:
    rule = candidate.get("rule") or {}
    window = candidate.get("window") or {}
    identity = {
        "domain": candidate.get("domain"),
        "rule_key": rule.get("key"),
        "rule_version": rule.get("version"),
        "subject": subject_identity(candidate.get("subject") or {}),
        "window": {
            "id": window.get("id"),
            "start": window.get("start"),
            "through": window.get("through"),
        },
    }
    return _digest("decision", identity)


def fact_fingerprint(candidate: Mapping[str, Any]) -> str:
    facts = {
        "window": candidate.get("window"),
        "evidence": candidate.get("evidence"),
        "cross_domain_conditions": candidate.get("cross_domain_conditions"),
        "guardrails": candidate.get("guardrails"),
        "blockers": candidate.get("blockers"),
        "suppression": candidate.get("suppression"),
        "materiality": candidate.get("materiality"),
        "confidence": candidate.get("confidence"),
    }
    return _digest("facts", facts)


def finalize_candidate(candidate: Mapping[str, Any]) -> DecisionCandidate:
    result = json.loads(canonical_json(candidate))
    result["contract_version"] = CONTRACT_VERSION
    result["id"] = stable_candidate_id(result)
    result["fact_fingerprint"] = fact_fingerprint(result)
    validate_candidate(result)
    return cast(DecisionCandidate, result)


def _object(value: Any, path: str, errors: list[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        errors.append(f"{path} must be an object")
        return {}
    return value


def _array(value: Any, path: str, errors: list[str]) -> list[Any]:
    if not isinstance(value, list):
        errors.append(f"{path} must be an array")
        return []
    return value


def _timestamp(value: Any, path: str, errors: list[str]) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        errors.append(f"{path} must be an ISO-8601 timestamp with timezone")
        return None


def _calendar_date(value: Any, path: str, errors: list[str]) -> date | None:
    try:
        return date.fromisoformat(str(value))
    except (TypeError, ValueError):
        errors.append(f"{path} must be an ISO-8601 calendar date")
        return None


def _finite_number(value: Any, path: str, errors: list[str], *, nullable: bool = False) -> float | None:
    if value is None and nullable:
        return None
    if isinstance(value, bool):
        errors.append(f"{path} must be a finite number")
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        errors.append(f"{path} must be a finite number")
        return None
    if not math.isfinite(number):
        errors.append(f"{path} must be a finite number")
        return None
    return number


def validate_candidate(candidate: Mapping[str, Any]) -> None:
    errors: list[str] = []
    for field in _REQUIRED_TOP_LEVEL:
        if field not in candidate:
            errors.append(f"{field} is required")

    if candidate.get("contract_version") != CONTRACT_VERSION:
        errors.append(f"contract_version must be {CONTRACT_VERSION}")
    if candidate.get("domain") not in DOMAINS:
        errors.append("domain is not supported")
    if candidate.get("lane") not in LANES:
        errors.append("lane is not supported")
    if candidate.get("state") not in CANDIDATE_STATES:
        errors.append("state is not supported")

    rule = _object(candidate.get("rule"), "rule", errors)
    if not str(rule.get("key") or "").strip():
        errors.append("rule.key is required")
    if not isinstance(rule.get("version"), int) or rule.get("version", 0) < 1:
        errors.append("rule.version must be a positive integer")
    lifecycle = rule.get("lifecycle")
    if lifecycle not in RULE_LIFECYCLES:
        errors.append("rule.lifecycle is not supported")
    state = candidate.get("state")
    if lifecycle == "DRAFT":
        errors.append("DRAFT rules cannot produce candidates")
    if lifecycle == "SHADOW" and state != "SHADOW_CANDIDATE":
        errors.append("SHADOW rules may only produce SHADOW_CANDIDATE records")
    if lifecycle in ("PAUSED", "RETIRED") and state in ("SHADOW_CANDIDATE", "OPEN"):
        errors.append(f"{lifecycle} rules cannot produce current candidates")

    subject = _object(candidate.get("subject"), "subject", errors)
    if not str(subject.get("type") or "").strip():
        errors.append("subject.type is required")
    if not str(subject.get("marketplace_id") or "").strip():
        errors.append("subject.marketplace_id is required")
    if len(subject_identity(subject)) < 3:
        errors.append("subject requires a business or technical identity in addition to type and marketplace")
    if not str(subject.get("label") or "").strip():
        errors.append("subject.label is required")

    recommendation = _object(candidate.get("recommendation"), "recommendation", errors)
    for field in ("action_type", "action_class", "title", "rationale", "execution_state"):
        if not str(recommendation.get(field) or "").strip():
            errors.append(f"recommendation.{field} is required")
    if recommendation.get("action_class") not in ACTION_CLASSES:
        errors.append("recommendation.action_class is not supported")
    if not isinstance(recommendation.get("parameters"), dict):
        errors.append("recommendation.parameters must be an object")
    if lifecycle == "SHADOW" and recommendation.get("execution_state") != "SHADOW_ONLY":
        errors.append("shadow recommendations must use SHADOW_ONLY execution_state")
    if recommendation.get("action_class") == "EXECUTE":
        errors.append("contract version 1 does not authorize Amazon execution")

    blockers = _array(candidate.get("blockers"), "blockers", errors)
    if blockers and recommendation.get("execution_state") not in ("BLOCKED", "SHADOW_ONLY", "NOT_EXECUTABLE"):
        errors.append("a candidate with blockers cannot expose an executable action")

    materiality = _object(candidate.get("materiality"), "materiality", errors)
    if materiality.get("type") not in MATERIALITY_TYPES:
        errors.append("materiality.type is not supported")
    for field in ("currency", "basis"):
        if not str(materiality.get(field) or "").strip():
            errors.append(f"materiality.{field} is required")
    _finite_number(materiality.get("amount"), "materiality.amount", errors)
    low = _finite_number(materiality.get("low"), "materiality.low", errors, nullable=True)
    high = _finite_number(materiality.get("high"), "materiality.high", errors, nullable=True)
    if low is not None and high is not None and low > high:
        errors.append("materiality.low cannot exceed materiality.high")
    if materiality.get("type") == "SENSITIVITY_SCENARIO" and (low is None or high is None):
        errors.append("sensitivity materiality requires a range")
    if materiality.get("type") == "FORECAST":
        for field in ("assumptions", "horizon", "eligibility"):
            if not materiality.get(field):
                errors.append(f"forecast materiality requires {field}")
        if materiality.get("low") is None or materiality.get("high") is None:
            errors.append("forecast materiality requires a range")

    confidence = _object(candidate.get("confidence"), "confidence", errors)
    if confidence.get("band") not in CONFIDENCE_BANDS:
        errors.append("confidence.band is not supported")
    if not str(confidence.get("basis") or "").strip():
        errors.append("confidence.basis is required")
    _array(confidence.get("reasons"), "confidence.reasons", errors)

    window = _object(candidate.get("window"), "window", errors)
    for field in ("id", "start", "through", "state"):
        if not str(window.get(field) or "").strip():
            errors.append(f"window.{field} is required")
    window_start = _calendar_date(window.get("start"), "window.start", errors)
    window_through = _calendar_date(window.get("through"), "window.through", errors)
    if window_start and window_through and window_through < window_start:
        errors.append("window.through cannot precede window.start")

    evidence = _array(candidate.get("evidence"), "evidence", errors)
    if not evidence:
        errors.append("evidence must contain at least one canonical fact")
    for index, raw_entry in enumerate(evidence):
        entry = _object(raw_entry, f"evidence[{index}]", errors)
        for field in ("fact", "unit", "basis", "source", "window", "cutoff"):
            if entry.get(field) in (None, ""):
                errors.append(f"evidence[{index}].{field} is required")
        if "value" not in entry:
            errors.append(f"evidence[{index}].value is required")

    conditions = _array(candidate.get("cross_domain_conditions"), "cross_domain_conditions", errors)
    guardrails = _array(candidate.get("guardrails"), "guardrails", errors)
    if candidate.get("suppression") is not None and not isinstance(candidate.get("suppression"), dict):
        errors.append("suppression must be null or an object")
    _object(candidate.get("destination"), "destination", errors)

    action_class = recommendation.get("action_class")
    if action_class in ("TEST", "CHANGE"):
        parameters = recommendation.get("parameters") or {}
        if not str(parameters.get("operator_policy_version") or "").strip():
            errors.append(f"{action_class} requires a versioned operator policy")
        if not guardrails:
            errors.append(f"{action_class} requires explicit guardrails")
        economics_ready = any(
            isinstance(condition, dict)
            and condition.get("domain") == "FINANCE"
            and condition.get("economic_state") == "RECONCILED"
            and condition.get("resolution") in ("ALLOW", "QUALIFY")
            for condition in conditions
        )
        if not economics_ready:
            errors.append(f"{action_class} requires reconciled Finance economics")
    if action_class == "TEST":
        parameters = recommendation.get("parameters") or {}
        for field in ("hypothesis", "spend_cap", "duration_days", "evaluation"):
            if parameters.get(field) in (None, ""):
                errors.append(f"TEST requires recommendation.parameters.{field}")
    if action_class == "CHANGE" and materiality.get("type") != "CAUSAL_ESTIMATE":
        errors.append("CHANGE requires sufficient causal materiality evidence")

    created = _timestamp(candidate.get("created_at"), "created_at", errors)
    valid_until = _timestamp(candidate.get("valid_until"), "valid_until", errors)
    if created and valid_until and valid_until <= created:
        errors.append("valid_until must be after created_at")

    try:
        if candidate.get("id") != stable_candidate_id(candidate):
            errors.append("id does not match the stable rule/subject/window identity")
        if candidate.get("fact_fingerprint") != fact_fingerprint(candidate):
            errors.append("fact_fingerprint does not match the canonical evidence")
    except (TypeError, ValueError) as exc:
        errors.append(f"candidate cannot be canonicalized: {exc}")

    if errors:
        raise DecisionContractError(errors)
