from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _brand_search_terms_evidence


class _Cursor:
    def execute(self, _sql: str) -> None:
        return None

    def fetchall(self):
        return [{
            "report_period": "WEEK",
            "rows": 300,
            "periods": 4,
            "departments": 2,
            "normalized_terms": 100,
            "clicked_asins": 80,
            "rows_with_click_share": 300,
            "rows_with_conversion_share": 260,
            "current_owned_clicked_asins": 6,
            "first_period_start": dt.date(2026, 8, 2),
            "through_date": dt.date(2026, 8, 29),
        }]


class BrandSearchTermsEvidenceTests(unittest.TestCase):
    def test_evidence_separates_market_and_current_owned_product_context(self) -> None:
        result = _brand_search_terms_evidence(_Cursor())

        self.assertEqual(result["WEEK"]["normalized_terms"], 100)
        self.assertEqual(result["WEEK"]["clicked_asins"], 80)
        self.assertEqual(result["WEEK"]["current_owned_clicked_asins"], 6)
        self.assertEqual(result["WEEK"]["through_date"], "2026-08-29")


if __name__ == "__main__":
    unittest.main()
