from __future__ import annotations

from copy import deepcopy
import unittest

from decision_contract import finalize_candidate
from decision_ranking import decision_rank_key, rank_candidates
from test_decision_contract import sample_candidate


def candidate(
    sku: str,
    *,
    kind: str = "ADS_PRODUCT_CONVERSION_GAP",
    lane: str = "ELIMINATE",
    confidence: str = "MEDIUM",
    amount: float = 0,
    valid_until: str = "2026-09-10T00:00:00Z",
    action_class: str = "INVESTIGATE",
) -> dict:
    result = deepcopy(sample_candidate())
    result["kind"] = kind
    result["lane"] = lane
    result["rule"] = {"key": kind, "version": 1, "lifecycle": "ACTIVE"}
    result["state"] = "OPEN"
    result["subject"]["sku"] = sku
    result["subject"]["label"] = f"Product {sku}"
    result["recommendation"]["action_class"] = action_class
    result["recommendation"]["execution_state"] = "HUMAN_REVIEW_REQUIRED"
    result["confidence"]["band"] = confidence
    result["materiality"]["amount"] = amount
    result["valid_until"] = valid_until
    return finalize_candidate(result)


class DecisionRankingTests(unittest.TestCase):
    def test_ranking_is_lexicographic_not_a_weighted_score(self):
        blocker = candidate("D", kind="ADS_DATA_BLOCKER", lane="PROTECT", amount=0)
        downside = candidate("C", confidence="HIGH", amount=10)
        urgent = candidate("B", amount=1, valid_until="2026-09-06T00:00:00Z")
        material = candidate("A", amount=1000, valid_until="2026-09-12T00:00:00Z")

        ranked = rank_candidates(
            [material, urgent, downside, blocker],
            lane_limits={"PROTECT": 2, "ELIMINATE": 3},
        )
        self.assertEqual(
            [row["subject"]["sku"] for row in ranked],
            ["D", "C", "B", "A"],
        )
        self.assertIsInstance(decision_rank_key(blocker), tuple)
        self.assertNotIn("score", blocker)

    def test_lane_allocation_is_explicit_bounded_and_stable(self):
        rows = [
            candidate("B", lane="CAPTURE"),
            candidate("A", lane="CAPTURE"),
            candidate("C", lane="PROTECT", confidence="HIGH"),
        ]
        ranked = rank_candidates(rows, lane_limits={"CAPTURE": 1, "PROTECT": 1})
        self.assertEqual([row["subject"]["sku"] for row in ranked], ["C", "A"])

        with self.assertRaisesRegex(ValueError, "lane allocation missing"):
            rank_candidates(rows, lane_limits={"PROTECT": 1})
        with self.assertRaisesRegex(ValueError, "non-negative"):
            rank_candidates(rows, lane_limits={"CAPTURE": -1, "PROTECT": 1})


if __name__ == "__main__":
    unittest.main()
