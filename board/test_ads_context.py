from __future__ import annotations

import unittest

from ads_context import decision_availability


class AdsDecisionAvailabilityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.connection = {"state": "READY"}
        self.business = {
            "through_date": "2026-09-02",
            "observed_ads_days": 28,
            "expected_ads_days": 28,
            "missing_ads_days": 0,
            "coverage_state": "COMPLETE",
            "trusted_for_operating_decisions": True,
            "quality": {"trusted": True, "issue_days": 0, "issues": {}},
        }

    def test_ready_window_explains_that_no_threshold_was_crossed(self):
        result = decision_availability(self.business, self.connection)

        self.assertEqual(result["code"], "READY")
        self.assertEqual(result["headline"], "No advertising action needs review")
        self.assertIn("review thresholds", result["detail"])

    def test_missing_seller_sales_names_the_recommendation_blocker(self):
        self.business["trusted_for_operating_decisions"] = False
        self.business["quality"] = {
            "trusted": False,
            "issue_days": 1,
            "issues": {"SELLER_SALES_DENOMINATOR_MISSING": 1},
        }

        result = decision_availability(self.business, self.connection)

        self.assertEqual(result["code"], "DATA_QUALITY_BLOCKED")
        self.assertEqual(result["headline"], "1 data issue is blocking recommendations")
        self.assertIn("Seller-sales data is missing for 1 day", result["detail"])

    def test_incomplete_window_names_missing_reporting_days(self):
        self.business.update(
            {
                "observed_ads_days": 26,
                "missing_ads_days": 2,
                "coverage_state": "PARTIAL",
                "trusted_for_operating_decisions": False,
            }
        )

        result = decision_availability(self.business, self.connection)

        self.assertEqual(result["code"], "REPORTING_INCOMPLETE")
        self.assertIn("2 reporting days", result["detail"])

    def test_connection_contract_supplies_plain_blocking_copy(self):
        connection = {
            "state": "FAILED",
            "headline": "Amazon Ads reporting needs attention.",
            "detail": "The latest connection attempt failed.",
        }

        result = decision_availability(self.business, connection)

        self.assertEqual(result["code"], "CONNECTION_NOT_READY")
        self.assertEqual(result["headline"], connection["headline"])
        self.assertEqual(result["detail"], connection["detail"])


if __name__ == "__main__":
    unittest.main()
