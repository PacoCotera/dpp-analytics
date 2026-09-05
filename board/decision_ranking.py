from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable, Mapping

from decision_contract import canonical_json, subject_identity, validate_candidate


_TRUTH_ORDER = {
    "OBSERVED_EXPOSURE": 0,
    "CAUSAL_ESTIMATE": 1,
    "FORECAST": 2,
    "SENSITIVITY_SCENARIO": 3,
}


def _timestamp(value: Any) -> float:
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()


def _priority_tier(candidate: Mapping[str, Any]) -> int:
    recommendation = candidate["recommendation"]
    materiality = candidate["materiality"]
    confidence = candidate["confidence"]
    if candidate["kind"] == "ADS_DATA_BLOCKER" or any(
        isinstance(blocker, dict) and blocker.get("resolution") == "BLOCK_DOMAIN"
        for blocker in candidate["blockers"]
    ):
        return 0
    if (
        confidence["band"] == "HIGH"
        and materiality["type"] == "OBSERVED_EXPOSURE"
        and candidate["lane"] in ("PROTECT", "ELIMINATE")
    ):
        return 1
    if recommendation["action_class"] == "TEST":
        return 4
    if recommendation["action_class"] == "OBSERVE":
        return 5
    return 2


def decision_rank_key(candidate: Mapping[str, Any]) -> tuple[Any, ...]:
    """Return the documented lexicographic order; never collapse it to a score."""
    validate_candidate(candidate)
    materiality = candidate["materiality"]
    amount = float(materiality.get("amount") or 0)
    stable_subject = canonical_json(subject_identity(candidate["subject"]))
    return (
        _priority_tier(candidate),
        _timestamp(candidate["valid_until"]),
        _TRUTH_ORDER[materiality["type"]],
        -amount,
        stable_subject,
        candidate["id"],
    )


def rank_candidates(
    candidates: Iterable[Mapping[str, Any]],
    *,
    lane_limits: Mapping[str, int],
) -> list[Mapping[str, Any]]:
    """Rank deterministically and apply caller-owned, explicit lane allocations."""
    candidate_list = list(candidates)
    missing = {candidate["lane"] for candidate in candidate_list} - set(lane_limits)
    if missing:
        raise ValueError(f"lane allocation missing for: {', '.join(sorted(missing))}")
    if any(not isinstance(limit, int) or limit < 0 for limit in lane_limits.values()):
        raise ValueError("lane allocations must be non-negative integers")
    counts = {lane: 0 for lane in lane_limits}
    ranked = []
    for candidate in sorted(candidate_list, key=decision_rank_key):
        lane = candidate["lane"]
        if counts[lane] >= lane_limits[lane]:
            continue
        counts[lane] += 1
        ranked.append(candidate)
    return ranked
