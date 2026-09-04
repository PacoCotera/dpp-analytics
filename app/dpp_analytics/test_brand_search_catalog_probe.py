from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _brand_search_catalog_evidence


class _Cursor:
    def execute(self, _sql: str) -> None:
        return None

    def fetchall(self):
        return [{
            "report_period": "WEEK",
            "rows": 125,
            "periods": 4,
            "asins": 8,
            "first_period_start": dt.date(2026, 8, 2),
            "through_date": dt.date(2026, 8, 29),
            "rows_with_impressions": 125,
            "rows_with_clicks": 120,
            "rows_with_purchases": 80,
            "rows_with_search_sales": 80,
        }]


class BrandSearchCatalogEvidenceTests(unittest.TestCase):
    def test_evidence_exposes_period_and_field_coverage(self) -> None:
        result = _brand_search_catalog_evidence(_Cursor())

        self.assertEqual(result["WEEK"]["periods"], 4)
        self.assertEqual(result["WEEK"]["rows_with_search_sales"], 80)
        self.assertEqual(result["WEEK"]["through_date"], "2026-08-29")


if __name__ == "__main__":
    unittest.main()
