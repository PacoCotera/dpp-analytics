from __future__ import annotations

import unittest
from datetime import date

from ads_api import _empty, _readiness_contract, _search_opportunities_contract


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

    def test_empty_ads_payload_keeps_search_opportunity_contract_explicit(self):
        result = _empty("not_initialized", {"state": "NOT_CONNECTED"})
        search = result["search_opportunities"]
        self.assertEqual(search["status"], "UNAVAILABLE")
        self.assertEqual(search["items"], [])
        self.assertTrue(search["rules"])

    def test_missing_brand_relation_does_not_require_a_database_query(self):
        search = _search_opportunities_contract(None, "A1AM78C64UM0Y8", {})
        self.assertEqual(search["status"], "UNAVAILABLE")
        self.assertEqual(search["items"], [])
        self.assertIn("does not separate organic and paid", search["basis"])

    def test_search_opportunities_use_the_canonical_short_product_decorator(self):
        class Cursor:
            def __init__(self):
                self.one = {"start_date": date(2026, 8, 1)}
                self.rows = [
                    {
                        "start_date": date(2026, 8, 1),
                        "end_date": date(2026, 8, 31),
                        "asin": "B012345678",
                        "sku": "SKU-ONE",
                        "product": "Long Amazon catalog title",
                        "search_query": "daily planner",
                        "search_query_key": "daily planner",
                        "search_query_volume": 5000,
                        "total_query_impression_count": 10000,
                        "asin_impression_count": 400,
                        "asin_impression_share": 0.04,
                        "total_click_count": 1000,
                        "asin_click_count": 10,
                        "total_cart_add_count": 400,
                        "asin_cart_add_count": 4,
                        "total_purchase_count": 200,
                        "asin_purchase_count": 2,
                        "image_url": None,
                    }
                ]

            def execute(self, _sql, _params):
                return None

            def fetchone(self):
                return self.one

            def fetchall(self):
                return self.rows

        def decorate(rows):
            for row in rows:
                row["product"] = "Daily planning notebook"
            return rows

        search = _search_opportunities_contract(
            Cursor(),
            "A1AM78C64UM0Y8",
            {"search_query_rel": True, "search_term_rel": False},
            decorate,
        )
        self.assertEqual(search["status"], "READY")
        self.assertEqual(search["items"][0]["product"], "Daily planning notebook")


if __name__ == "__main__":
    unittest.main()
