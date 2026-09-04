from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _ads_invalid_traffic_evidence


class _Cursor:
    def execute(self, _sql: str) -> None:
        return None

    def fetchone(self):
        return {
            "retained_reports": 12,
            "retained_source_rows": 48,
            "first_window_start": dt.date(2025, 9, 5),
            "through_date": dt.date(2026, 9, 3),
            "identity_reconciled_reports": 10,
            "identity_unresolved_reports": 2,
            "latest_gross_impressions": 1000,
            "latest_invalid_impressions": 20,
            "latest_gross_click_throughs": 100,
            "latest_invalid_click_throughs": 3,
        }


class AdsInvalidTrafficEvidenceTests(unittest.TestCase):
    def test_preserves_coverage_identity_and_latest_counts(self) -> None:
        result = _ads_invalid_traffic_evidence(_Cursor())

        self.assertEqual(result["retained_source_rows"], 48)
        self.assertEqual(result["through_date"], "2026-09-03")
        self.assertEqual(result["identity_unresolved_reports"], 2)
        self.assertEqual(result["latest_invalid_impressions"], 20)
        self.assertEqual(result["latest_invalid_click_throughs"], 3)


if __name__ == "__main__":
    unittest.main()
