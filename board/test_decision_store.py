from __future__ import annotations

from copy import deepcopy
import unittest

from decision_contract import finalize_candidate
from decision_store import (
    DecisionStoreError,
    experiment_fingerprint,
    persist_candidate,
    persist_experiment,
    record_disposition,
    record_outcome,
    transition_rule_lifecycle,
)
from test_decision_contract import sample_candidate


class FakeCursor:
    def __init__(self, results):
        self.results = list(results)
        self.executions = []

    def execute(self, sql, params=()):
        self.executions.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self.results.pop(0) if self.results else None


def current_candidate() -> dict:
    candidate = sample_candidate()
    candidate["created_at"] = "2026-09-04T20:00:00Z"
    candidate["valid_until"] = "2027-09-05T20:00:00Z"
    return finalize_candidate(candidate)


class DecisionStoreTests(unittest.TestCase):
    def test_operator_disposition_requires_open_active_candidate_and_cannot_promote_action(self):
        shadow = current_candidate()
        with self.assertRaises(DecisionStoreError) as raised:
            record_disposition(
                FakeCursor([{
                    "candidate_state": "SHADOW_CANDIDATE",
                    "rule_lifecycle": "SHADOW",
                    "candidate": shadow,
                }]),
                candidate_snapshot_id=1,
                disposition="SNOOZED",
                actor="operator@example.com",
                idempotency_key="snooze-1",
            )
        self.assertIn("OPEN candidate from an ACTIVE rule", str(raised.exception))

        active = deepcopy(shadow)
        active["state"] = "OPEN"
        active["rule"]["lifecycle"] = "ACTIVE"
        active["recommendation"]["execution_state"] = "HUMAN_REVIEW_REQUIRED"
        active = finalize_candidate(active)
        with self.assertRaises(DecisionStoreError) as raised:
            record_disposition(
                FakeCursor([{
                    "candidate_state": "OPEN",
                    "rule_lifecycle": "ACTIVE",
                    "candidate": active,
                }]),
                candidate_snapshot_id=2,
                disposition="APPROVED",
                approved_action={"action_class": "CHANGE", "parameters": {}},
                actor="operator@example.com",
                idempotency_key="approve-1",
            )
        self.assertIn("cannot promote", str(raised.exception))

        cursor = FakeCursor([
            {"candidate_state": "OPEN", "rule_lifecycle": "ACTIVE", "candidate": active},
            {"disposition_id": "disposition_ok"},
        ])
        self.assertEqual(
            record_disposition(
                cursor,
                candidate_snapshot_id=2,
                disposition="APPROVED",
                approved_action={"action_class": "INVESTIGATE", "parameters": {}},
                actor="operator@example.com",
                idempotency_key="approve-2",
            ),
            "disposition_ok",
        )

    def test_rule_activation_requires_complete_definition_and_business_approval(self):
        with self.assertRaises(DecisionStoreError) as raised:
            transition_rule_lifecycle(
                FakeCursor([{"lifecycle": "SHADOW", "definition_status": "COMPLETE"}]),
                rule_key="ADS_QUERY_TEST",
                rule_version=1,
                to_lifecycle="ACTIVE",
                reason="Backtest passed.",
                actor="operator@example.com",
            )
        self.assertIn("business approval reference", str(raised.exception))

        cursor = FakeCursor(
            [
                {"lifecycle": "SHADOW", "definition_status": "COMPLETE"},
                {"event_id": 9},
            ]
        )
        event_id = transition_rule_lifecycle(
            cursor,
            rule_key="ADS_QUERY_TEST",
            rule_version=1,
            to_lifecycle="ACTIVE",
            reason="Backtest and operator review passed.",
            actor="operator@example.com",
            approval_reference="issue #449 comment 123",
        )
        self.assertEqual(event_id, 9)
        self.assertEqual(cursor.executions[-1][1][5], "issue #449 comment 123")

    def test_retired_rule_is_immutable(self):
        with self.assertRaises(DecisionStoreError) as raised:
            transition_rule_lifecycle(
                FakeCursor([{"lifecycle": "RETIRED", "definition_status": "COMPLETE"}]),
                rule_key="ADS_QUERY_TEST",
                rule_version=1,
                to_lifecycle="SHADOW",
                reason="Attempted restart.",
                actor="operator@example.com",
            )
        self.assertIn("is not permitted", str(raised.exception))

    def test_candidate_appends_and_round_trips_exact_contract(self):
        candidate = current_candidate()
        cursor = FakeCursor(
            [
                {"lifecycle": "SHADOW", "definition_status": "COMPLETE"},
                None,
                {"snapshot_id": 41},
            ]
        )
        snapshot_id = persist_candidate(cursor, candidate)
        self.assertEqual(snapshot_id, 41)
        insert = cursor.executions[-1]
        self.assertIn("INSERT INTO decision.candidate_snapshot", insert[0])
        self.assertIn(candidate["fact_fingerprint"], insert[1])
        self.assertIsNone(insert[1][17])

        loader = FakeCursor([{"candidate": deepcopy(candidate)}])
        from decision_store import load_candidate

        self.assertEqual(load_candidate(loader, snapshot_id), candidate)

    def test_same_fact_and_state_is_idempotent(self):
        candidate = current_candidate()
        cursor = FakeCursor(
            [
                {"lifecycle": "SHADOW", "definition_status": "COMPLETE"},
                {
                    "snapshot_id": 12,
                    "fact_fingerprint": candidate["fact_fingerprint"],
                    "candidate_state": candidate["state"],
                },
            ]
        )
        self.assertEqual(persist_candidate(cursor, candidate), 12)
        self.assertEqual(len(cursor.executions), 2)

    def test_restatement_appends_with_supersession_link(self):
        candidate = current_candidate()
        cursor = FakeCursor(
            [
                {"lifecycle": "SHADOW", "definition_status": "COMPLETE"},
                {"snapshot_id": 12, "fact_fingerprint": "facts_old", "candidate_state": "SHADOW_CANDIDATE"},
                {"snapshot_id": 13},
            ]
        )
        self.assertEqual(persist_candidate(cursor, candidate), 13)
        self.assertEqual(cursor.executions[-1][1][17], 12)

    def test_persisted_rule_lifecycle_and_definition_are_hard_gates(self):
        candidate = current_candidate()
        for registered, message in (
            ({"lifecycle": "DRAFT", "definition_status": "COMPLETE"}, "does not match"),
            ({"lifecycle": "SHADOW", "definition_status": "SKELETON"}, "complete rule definition"),
        ):
            with self.assertRaises(DecisionStoreError) as raised:
                persist_candidate(FakeCursor([registered]), candidate)
            self.assertIn(message, str(raised.exception))

    def test_expired_candidate_must_say_expired(self):
        candidate = current_candidate()
        candidate["valid_until"] = "2026-09-04T20:00:01Z"
        candidate = finalize_candidate(candidate)
        with self.assertRaises(DecisionStoreError) as raised:
            persist_candidate(
                FakeCursor([{"lifecycle": "SHADOW", "definition_status": "COMPLETE"}]),
                candidate,
            )
        self.assertIn("must be recorded with EXPIRED", str(raised.exception))

    def test_active_experiment_requires_locked_baseline(self):
        experiment = {
            "experiment_id": "experiment_1",
            "lifecycle_state": "ACTIVE",
            "hypothesis": "A bounded query test can increase qualified visits.",
            "subject": {"type": "QUERY", "query_key": "daily planner"},
            "treatment": {"action": "ADD_EXACT_TARGET", "spend_cap": 300},
            "baseline_window": {"start": "2026-08-01", "through": "2026-08-28"},
            "evaluation_window": {"start": "2026-09-05", "through": "2026-09-18"},
            "attribution_finality_delay_days": 7,
            "primary_outcome": {"fact": "qualified_visits"},
            "guardrail_metrics": [{"fact": "contribution_after_ads"}],
            "comparison_method": "Locked pre/post descriptive comparison",
            "confounders": [],
            "exclusions": [],
            "actor": "operator@example.com",
        }
        with self.assertRaises(DecisionStoreError) as raised:
            persist_experiment(FakeCursor([]), experiment)
        self.assertIn("baseline window must be locked", str(raised.exception))

        experiment["baseline_window"]["locked_at"] = "2026-09-04T20:00:00Z"
        cursor = FakeCursor([None, {"experiment_snapshot_id": 7}])
        self.assertEqual(persist_experiment(cursor, experiment), 7)
        self.assertTrue(experiment_fingerprint(experiment).startswith("experiment_"))

        existing = FakeCursor([{"experiment_snapshot_id": 7}])
        self.assertEqual(persist_experiment(existing, deepcopy(experiment)), 7)
        self.assertEqual(len(existing.executions), 1)

    def test_outcome_cannot_precede_attribution_finality(self):
        outcome = {
            "outcome_id": "outcome_1",
            "experiment_snapshot_id": 7,
            "eligible_evaluation_at": "2026-09-20T00:00:00Z",
            "evaluated_at": "2026-09-19T00:00:00Z",
            "baseline_facts": {"visits": 10},
            "treatment_facts": {"visits": 12},
            "truth_class": "DESCRIPTIVE",
            "result": {"difference": 2},
            "guardrail_breaches": [],
            "conclusion": "INCONCLUSIVE",
            "rule_versions": [{"key": "ADS_QUERY_TEST", "version": 1}],
            "model_versions": [],
            "evidence_references": ["ads.query_day:2026-09-18"],
            "actor": "operator@example.com",
        }
        with self.assertRaises(DecisionStoreError) as raised:
            record_outcome(FakeCursor([]), outcome)
        self.assertIn("before its eligible date", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
