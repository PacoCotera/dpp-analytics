from __future__ import annotations

import unittest

from .production_probe import _ads_shadow_evaluation_evidence


class Cursor:
    def __init__(self):
        self.rows = [
            {
                "current_captures": 4,
                "point_in_time_replays": 1,
                "distinct_current_fact_states": 3,
                "capture_started_at": "2026-09-05T01:00:00Z",
                "latest_captured_at": "2026-09-05T02:30:00Z",
                "candidates_observed": 9,
                "suppressed_observed": 2,
                "stored_bytes": 32768,
            },
            {
                "evaluation_id": 5,
                "fact_fingerprint": "facts_" + "a" * 64,
                "source_cutoffs": {"amazon_ads": "2026-09-05T02:00:00Z"},
                "summary": {"candidates": 2},
            },
        ]
        self.row_sets = [
            [
                {
                    "rule_key": "ADS_PRODUCT_CONVERSION_GAP",
                    "emissions": 6,
                    "captures_with_candidate": 3,
                    "distinct_fact_states": 2,
                    "distinct_candidates": 2,
                    "suppressed": 3,
                    "high_confidence": 3,
                    "low_confidence": 3,
                    "materiality_types": ["OBSERVED_EXPOSURE"],
                    "materiality_currencies": ["MXN"],
                    "materiality_min": "80.00",
                    "materiality_median": "120.00",
                    "materiality_p90": "180.00",
                    "materiality_max": "200.00",
                    "materiality_total": "720.00",
                    "suppression_codes": ["PRODUCT_CONTEXT_MISSING"],
                    "hard_safety_violations": 0,
                },
                {
                    "rule_key": "ADS_INVENTORY_CONFLICT",
                    "emissions": 2,
                    "captures_with_candidate": 2,
                    "distinct_fact_states": 1,
                    "distinct_candidates": 1,
                    "suppressed": 0,
                    "high_confidence": 2,
                    "low_confidence": 0,
                    "materiality_types": ["OBSERVED_EXPOSURE"],
                    "materiality_currencies": ["MXN"],
                    "materiality_min": "100.00",
                    "materiality_median": "110.00",
                    "materiality_p90": "118.00",
                    "materiality_max": "120.00",
                    "materiality_total": "220.00",
                    "suppression_codes": [],
                    "hard_safety_violations": 1,
                },
                {
                    "rule_key": "ADS_DATA_BLOCKER",
                    "emissions": 0,
                    "captures_with_candidate": 0,
                    "distinct_fact_states": 0,
                    "distinct_candidates": 0,
                    "suppressed": 0,
                    "high_confidence": 0,
                    "low_confidence": 0,
                    "materiality_types": [],
                    "materiality_currencies": [],
                    "materiality_min": None,
                    "materiality_median": None,
                    "materiality_p90": None,
                    "materiality_max": None,
                    "materiality_total": "0",
                    "suppression_codes": [],
                    "hard_safety_violations": 0,
                },
            ],
            [
                {
                    "source_key": "amazon_ads",
                    "distinct_cutoffs": 2,
                    "first_cutoff": "2026-09-05T01:00:00Z",
                    "latest_cutoff": "2026-09-05T02:00:00Z",
                }
            ],
        ]

    def execute(self, *_args, **_kwargs):
        return None

    def fetchone(self):
        return self.rows.pop(0)

    def fetchall(self):
        return self.row_sets.pop(0)


class AdvertisingShadowEvaluationProbeTests(unittest.TestCase):
    def test_probe_exposes_volume_growth_and_latest_non_secret_evidence(self):
        result = _ads_shadow_evaluation_evidence(Cursor())
        self.assertEqual(result["current_captures"], 4)
        self.assertEqual(result["point_in_time_replays"], 1)
        self.assertEqual(result["distinct_current_fact_states"], 3)
        self.assertEqual(result["candidates_observed"], 9)
        self.assertEqual(result["suppressed_observed"], 2)
        self.assertEqual(result["stored_bytes"], 32768)
        self.assertEqual(result["latest_evaluation_id"], 5)
        self.assertEqual(result["latest_summary"]["candidates"], 2)
        self.assertEqual(result["hard_safety_violations"], 1)
        self.assertFalse(result["automatic_activation_permitted"])
        self.assertEqual(
            result["rules"]["ADS_PRODUCT_CONVERSION_GAP"]["review_state"],
            "MANUAL_REVIEW_REQUIRED",
        )
        self.assertEqual(
            result["rules"]["ADS_INVENTORY_CONFLICT"]["review_state"],
            "AWAITING_FACT_VARIATION",
        )
        self.assertEqual(
            result["rules"]["ADS_DATA_BLOCKER"]["review_state"],
            "NO_PRODUCTION_EMISSIONS",
        )
        self.assertEqual(
            result["rules"]["ADS_PRODUCT_CONVERSION_GAP"]["materiality_distribution"],
            {
                "min": "80.00",
                "median": "120.00",
                "p90": "180.00",
                "max": "200.00",
                "total": "720.00",
            },
        )
        self.assertEqual(result["source_progression"]["amazon_ads"]["distinct_cutoffs"], 2)


if __name__ == "__main__":
    unittest.main()
