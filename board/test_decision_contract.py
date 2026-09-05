from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import unittest

from decision_contract import (
    DecisionContractError,
    fact_fingerprint,
    finalize_candidate,
    stable_candidate_id,
    validate_candidate,
)


def sample_candidate() -> dict:
    return {
        "domain": "ADVERTISING",
        "lane": "PROTECT",
        "kind": "ADS_INVENTORY_CONFLICT",
        "state": "SHADOW_CANDIDATE",
        "rule": {
            "key": "ADS_INVENTORY_CONFLICT",
            "version": 1,
            "lifecycle": "SHADOW",
        },
        "subject": {
            "type": "PRODUCT",
            "marketplace_id": "A1AM78C64UM0Y8",
            "sku": "PNC-001",
            "asin": "B012345678",
            "label": "Pocket notebook",
        },
        "recommendation": {
            "action_type": "REVIEW_EXPOSURE",
            "action_class": "INVESTIGATE",
            "title": "Protect limited stock from paid demand",
            "rationale": "Paid support overlaps a current inventory constraint.",
            "parameters": {},
            "execution_state": "SHADOW_ONLY",
        },
        "materiality": {
            "type": "OBSERVED_EXPOSURE",
            "currency": "MXN",
            "amount": 120,
            "low": None,
            "high": None,
            "basis": "Finalized attributed advertising spend in the selected window.",
        },
        "confidence": {
            "band": "HIGH",
            "basis": "DETERMINISTIC_EVIDENCE",
            "reasons": ["Ads and Inventory facts are current."],
        },
        "window": {
            "id": "ADS_FINALIZED_T28",
            "start": "2026-08-01",
            "through": "2026-08-28",
            "state": "RECONCILED",
        },
        "evidence": [
            {
                "fact": "ads.product.spend",
                "value": 120,
                "unit": "MXN",
                "basis": "Sponsored Products product allocation",
                "source": "ads.product_day",
                "window": "ADS_FINALIZED_T28",
                "cutoff": "2026-08-28T23:59:59-06:00",
            },
            {
                "fact": "inventory.action",
                "value": "PRODUCE",
                "unit": "STATE",
                "basis": "Current inventory planning snapshot",
                "source": "inventory.current_product",
                "window": "CURRENT",
                "cutoff": "2026-08-29T08:00:00-06:00",
            },
        ],
        "cross_domain_conditions": [
            {"domain": "INVENTORY", "condition": "PRODUCE", "resolution": "QUALIFY"}
        ],
        "guardrails": ["Do not increase paid support while inventory is constrained."],
        "blockers": [],
        "suppression": None,
        "destination": {"route": "/ads", "view": "decisions", "sku": "PNC-001"},
        "created_at": "2026-08-29T14:00:00Z",
        "valid_until": "2026-08-30T14:00:00Z",
    }


class DecisionCandidateContractTests(unittest.TestCase):
    def test_published_api_fixture_validates_without_reinterpretation(self):
        fixture = json.loads(
            (Path(__file__).parent / "fixtures" / "decision_candidate_v1.json").read_text()
        )
        validate_candidate(fixture)
        self.assertEqual(finalize_candidate(fixture), fixture)

    def test_complete_sample_validates_and_is_deterministic(self):
        first = finalize_candidate(sample_candidate())
        second = finalize_candidate(deepcopy(sample_candidate()))
        self.assertEqual(first, second)
        self.assertEqual(first["id"], stable_candidate_id(first))
        self.assertEqual(first["fact_fingerprint"], fact_fingerprint(first))
        validate_candidate(first)

    def test_identity_survives_copy_change_but_facts_do_not(self):
        first = finalize_candidate(sample_candidate())
        changed = sample_candidate()
        changed["subject"]["label"] = "Renamed pocket notebook"
        changed["recommendation"]["title"] = "Review paid support for limited stock"
        changed["evidence"][0]["value"] = 135
        second = finalize_candidate(changed)
        self.assertEqual(first["id"], second["id"])
        self.assertNotEqual(first["fact_fingerprint"], second["fact_fingerprint"])

    def test_rule_or_source_window_change_creates_a_new_identity(self):
        first = finalize_candidate(sample_candidate())
        revised = sample_candidate()
        revised["rule"]["version"] = 2
        self.assertNotEqual(first["id"], finalize_candidate(revised)["id"])
        new_window = sample_candidate()
        new_window["window"]["through"] = "2026-08-29"
        self.assertNotEqual(first["id"], finalize_candidate(new_window)["id"])

    def test_draft_paused_and_retired_rules_cannot_create_current_candidates(self):
        for lifecycle in ("DRAFT", "PAUSED", "RETIRED"):
            candidate = sample_candidate()
            candidate["rule"]["lifecycle"] = lifecycle
            with self.assertRaises(DecisionContractError, msg=lifecycle):
                finalize_candidate(candidate)

    def test_shadow_candidates_are_never_operator_actions(self):
        candidate = sample_candidate()
        candidate["state"] = "OPEN"
        candidate["recommendation"]["execution_state"] = "HUMAN_REVIEW_REQUIRED"
        with self.assertRaises(DecisionContractError) as raised:
            finalize_candidate(candidate)
        self.assertIn("SHADOW rules may only produce", str(raised.exception))

    def test_shadow_candidate_can_expire_without_becoming_an_operator_action(self):
        candidate = sample_candidate()
        candidate["state"] = "EXPIRED"
        candidate["valid_until"] = "2026-08-30T14:00:00Z"
        validate_candidate(finalize_candidate(candidate))

    def test_blockers_prevent_executable_action(self):
        candidate = sample_candidate()
        candidate["blockers"] = [{"code": "ECONOMICS_UNRECONCILED"}]
        candidate["recommendation"]["execution_state"] = "HUMAN_REVIEW_REQUIRED"
        with self.assertRaises(DecisionContractError) as raised:
            finalize_candidate(candidate)
        self.assertIn("cannot expose an executable action", str(raised.exception))

    def test_contract_v1_rejects_direct_amazon_execution(self):
        candidate = sample_candidate()
        candidate["recommendation"]["action_class"] = "EXECUTE"
        with self.assertRaises(DecisionContractError) as raised:
            finalize_candidate(candidate)
        self.assertIn("does not authorize Amazon execution", str(raised.exception))

    def test_forecast_requires_range_assumptions_horizon_and_eligibility(self):
        candidate = sample_candidate()
        candidate["materiality"] = {
            "type": "FORECAST",
            "currency": "MXN",
            "amount": 500,
            "low": None,
            "high": None,
            "basis": "Model output",
        }
        with self.assertRaises(DecisionContractError) as raised:
            finalize_candidate(candidate)
        self.assertIn("forecast materiality requires assumptions", str(raised.exception))
        self.assertIn("forecast materiality requires a range", str(raised.exception))

    def test_capital_actions_require_policy_economics_and_bounded_test_plan(self):
        candidate = sample_candidate()
        candidate["rule"]["lifecycle"] = "ACTIVE"
        candidate["state"] = "OPEN"
        candidate["recommendation"]["execution_state"] = "HUMAN_REVIEW_REQUIRED"
        candidate["recommendation"]["action_class"] = "TEST"
        with self.assertRaises(DecisionContractError) as raised:
            finalize_candidate(candidate)
        self.assertIn("TEST requires a versioned operator policy", str(raised.exception))
        self.assertIn("TEST requires reconciled Finance economics", str(raised.exception))
        self.assertIn("recommendation.parameters.spend_cap", str(raised.exception))

        candidate["recommendation"]["parameters"] = {
            "operator_policy_version": "ads-learning-policy-v1",
            "hypothesis": "A bounded exact-query test can improve qualified visits.",
            "spend_cap": 300,
            "duration_days": 14,
            "evaluation": {"primary_outcome": "qualified_visits"},
        }
        candidate["cross_domain_conditions"].append(
            {
                "domain": "FINANCE",
                "economic_state": "RECONCILED",
                "resolution": "QUALIFY",
            }
        )
        validate_candidate(finalize_candidate(candidate))

    def test_change_requires_causal_not_attributed_or_forecast_materiality(self):
        candidate = sample_candidate()
        candidate["rule"]["lifecycle"] = "ACTIVE"
        candidate["state"] = "OPEN"
        candidate["recommendation"].update(
            {
                "action_class": "CHANGE",
                "execution_state": "HUMAN_REVIEW_REQUIRED",
                "parameters": {"operator_policy_version": "ads-change-policy-v1"},
            }
        )
        candidate["cross_domain_conditions"].append(
            {"domain": "FINANCE", "economic_state": "RECONCILED", "resolution": "ALLOW"}
        )
        with self.assertRaises(DecisionContractError) as raised:
            finalize_candidate(candidate)
        self.assertIn("CHANGE requires sufficient causal", str(raised.exception))

    def test_window_and_materiality_boundaries_are_ordered(self):
        candidate = sample_candidate()
        candidate["window"]["start"] = "2026-08-29"
        candidate["window"]["through"] = "2026-08-28"
        candidate["materiality"]["low"] = 20
        candidate["materiality"]["high"] = 10
        with self.assertRaises(DecisionContractError) as raised:
            finalize_candidate(candidate)
        self.assertIn("window.through cannot precede", str(raised.exception))
        self.assertIn("materiality.low cannot exceed", str(raised.exception))

    def test_evidence_requires_traceable_fact_metadata(self):
        candidate = sample_candidate()
        del candidate["evidence"][0]["source"]
        with self.assertRaises(DecisionContractError) as raised:
            finalize_candidate(candidate)
        self.assertIn("evidence[0].source is required", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
