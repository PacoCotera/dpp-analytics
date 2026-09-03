from __future__ import annotations

import unittest

from ads_api import _readiness_contract


class AdsApiReadinessContractTest(unittest.TestCase):
    def setUp(self) -> None:
        self.quality = {
            "trusted_for_operating_decisions": True,
            "issue_days": 0,
            "basis": "reconciled",
        }
        self.freshness = {
            "period_observed_days": 28,
            "period_expected_days": 28,
            "mature_days": 21,
        }

    def test_failed_refresh_preserves_stored_data_with_degraded_readiness(self):
        result = _readiness_contract(
            {"badge": "Ads refresh delayed", "degraded": True},
            self.quality,
            self.freshness,
            "2026-09-01",
        )

        self.assertEqual(result["state"], "DEGRADED")
        self.assertEqual(result["label"], "Ads refresh delayed")
        self.assertIn("Stored data through 2026-09-01", result["summary"])

    def test_active_refresh_preserves_stored_data_with_refreshing_readiness(self):
        result = _readiness_contract(
            {"badge": "Ads refresh running", "refreshing": True},
            self.quality,
            self.freshness,
            "2026-09-01",
        )

        self.assertEqual(result["state"], "REFRESHING")
        self.assertEqual(result["label"], "Ads refresh running")
        self.assertIn("28/28 days observed", result["summary"])


if __name__ == "__main__":
    unittest.main()
