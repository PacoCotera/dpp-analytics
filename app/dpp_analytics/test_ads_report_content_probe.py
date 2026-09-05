from __future__ import annotations

from datetime import datetime, timezone
import unittest

from .production_probe import _ads_report_content_evidence


class _Cursor:
    def execute(self, sql: str) -> None:
        self.sql = sql

    def fetchall(self):
        return [
            {
                "report_grain": "product",
                "observations": 4,
                "content_versions": 3,
                "report_rows_observed": 240,
                "stored_compressed_bytes": 12000,
                "represented_uncompressed_bytes": 96000,
                "capture_started_at": datetime(2026, 9, 5, tzinfo=timezone.utc),
                "latest_observed_at": datetime(2026, 9, 5, 18, tzinfo=timezone.utc),
            }
        ]


class AdsReportContentEvidenceTests(unittest.TestCase):
    def test_reports_capture_boundary_versions_and_storage(self) -> None:
        cursor = _Cursor()
        result = _ads_report_content_evidence(cursor)
        self.assertIn("ads.report_content_observation", cursor.sql)
        self.assertEqual(result["product"]["observations"], 4)
        self.assertEqual(result["product"]["content_versions"], 3)
        self.assertEqual(result["product"]["stored_compressed_bytes"], 12000)
        self.assertEqual(result["product"]["capture_started_at"], "2026-09-05T00:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
