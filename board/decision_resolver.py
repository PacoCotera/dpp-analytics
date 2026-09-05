from __future__ import annotations

from typing import Any, Iterable, Mapping, TypedDict


RESOLUTION_PRECEDENCE = {
    "ALLOW": 0,
    "QUALIFY": 1,
    "TRANSFORM": 2,
    "SUPPRESS": 3,
    "BLOCK_DOMAIN": 4,
}


class ResolutionError(ValueError):
    pass


class ResolutionResult(TypedDict):
    outcome: str
    conditions: list[dict[str, Any]]
    blockers: list[dict[str, Any]]
    suppression: dict[str, Any] | None
    transformed_action: dict[str, Any] | None


def resolve_conditions(conditions: Iterable[Mapping[str, Any]]) -> ResolutionResult:
    """Resolve traceable domain conditions with deterministic safety precedence."""

    normalized: list[dict[str, Any]] = []
    for index, condition in enumerate(conditions):
        item = dict(condition)
        for field in ("domain", "code", "resolution", "rule_key", "reason"):
            if not str(item.get(field) or "").strip():
                raise ResolutionError(f"condition[{index}].{field} is required")
        resolution = str(item["resolution"])
        if resolution not in RESOLUTION_PRECEDENCE:
            raise ResolutionError(f"condition[{index}].resolution is unsupported")
        operands = item.get("operands")
        if not isinstance(operands, list) or not operands:
            raise ResolutionError(f"condition[{index}].operands must identify governing facts")
        if resolution == "TRANSFORM" and not isinstance(item.get("transformed_action"), dict):
            raise ResolutionError("TRANSFORM requires transformed_action")
        normalized.append(item)

    normalized.sort(
        key=lambda item: (
            -RESOLUTION_PRECEDENCE[str(item["resolution"])],
            str(item["domain"]),
            str(item["code"]),
            str(item["rule_key"]),
        )
    )
    dominant = normalized[0] if normalized else None
    outcome = str(dominant["resolution"]) if dominant else "ALLOW"
    blockers = [
        {
            "code": item["code"],
            "domain": item["domain"],
            "resolution": item["resolution"],
            "rule_key": item["rule_key"],
            "reason": item["reason"],
            "operands": item["operands"],
        }
        for item in normalized
        if item["resolution"] in ("SUPPRESS", "BLOCK_DOMAIN")
    ]
    suppression = None
    if outcome in ("SUPPRESS", "BLOCK_DOMAIN") and dominant:
        suppression = {
            "code": dominant["code"],
            "resolution": outcome,
            "reason": dominant["reason"],
            "rule_key": dominant["rule_key"],
            "operands": dominant["operands"],
        }
    transformed_action = (
        dict(dominant["transformed_action"])
        if outcome == "TRANSFORM" and dominant and isinstance(dominant.get("transformed_action"), dict)
        else None
    )
    return {
        "outcome": outcome,
        "conditions": normalized,
        "blockers": blockers,
        "suppression": suppression,
        "transformed_action": transformed_action,
    }
