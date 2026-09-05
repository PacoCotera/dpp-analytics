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

    def execute(self, *_args, **_kwargs):
        return None

    def fetchone(self):
        return self.rows.pop(0)


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


if __name__ == "__main__":
    unittest.main()
