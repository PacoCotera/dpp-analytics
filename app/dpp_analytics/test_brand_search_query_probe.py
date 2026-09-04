from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _brand_search_query_evidence


class _Cursor:
    def execute(self, _sql: str) -> None:
        return None

    def fetchall(self):
        return [
            {
                "report_period": "WEEK",
                "rows": 125,
                "periods": 4,
                "asins": 8,
                "normalized_queries": 70,
                "first_period_start": dt.date(2026, 8, 2),
                "through_date": dt.date(2026, 8, 29),
            }
        ]


class BrandSearchQueryEvidenceTests(unittest.TestCase):
    def test_period_grains_remain_separate(self) -> None:
        result = _brand_search_query_evidence(_Cursor())

        self.assertEqual(result["WEEK"]["rows"], 125)
        self.assertEqual(result["WEEK"]["periods"], 4)
        self.assertEqual(result["WEEK"]["through_date"], "2026-08-29")


if __name__ == "__main__":
    unittest.main()
