from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _ads_entity_evidence


class _Cursor:
    def execute(self, _sql: str) -> None:
        return None

    def fetchone(self):
        return {
            "latest_complete_at": dt.datetime(2026, 9, 4, tzinfo=dt.timezone.utc),
            "latest_failed_at": None,
            "campaigns": 4,
            "ad_groups": 12,
            "product_ads": 9,
            "targets": 80,
            "keywords": 20,
            "accounts": 1,
        }


class AdsEntityProductionEvidenceTests(unittest.TestCase):
    def test_exposes_only_freshness_and_aggregate_entity_counts(self) -> None:
        result = _ads_entity_evidence(_Cursor())

        self.assertEqual(result["latest_complete_at"], "2026-09-04T00:00:00+00:00")
        self.assertIsNone(result["latest_failed_at"])
        self.assertEqual(result["accounts"], 1)
        self.assertEqual(result["entity_counts"]["TARGET"], 80)
        self.assertNotIn("entity_id", result)


if __name__ == "__main__":
    unittest.main()
