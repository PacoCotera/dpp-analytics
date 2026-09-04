from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _brand_search_terms_evidence


class _Cursor:
    def __init__(self):
        self.calls = 0

    def execute(self, _sql: str) -> None:
        self.calls += 1
        return None

    def fetchall(self):
        if self.calls == 1:
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
        return [{
            "report_period": "WEEK",
            "source_periods": 4,
            "source_rows": 48_000_000,
            "retained_rows": 300,
            "owned_clicked_rows": 24,
            "tracked_query_rows": 280,
            "first_source_period_start": dt.date(2026, 8, 2),
            "source_through_date": dt.date(2026, 8, 29),
            "retention_basis": "OWNED_CLICKED_ASIN_OR_OBSERVED_DPP_QUERY",
        }]


class BrandSearchTermsEvidenceTests(unittest.TestCase):
    def test_evidence_separates_market_and_current_owned_product_context(self) -> None:
        result = _brand_search_terms_evidence(_Cursor())

        self.assertEqual(result["WEEK"]["normalized_terms"], 100)
        self.assertEqual(result["WEEK"]["clicked_asins"], 80)
        self.assertEqual(result["WEEK"]["current_owned_clicked_asins"], 6)
        self.assertEqual(result["WEEK"]["source_rows"], 48_000_000)
        self.assertEqual(result["WEEK"]["retained_rows"], 300)
        self.assertEqual(result["WEEK"]["through_date"], "2026-08-29")


if __name__ == "__main__":
    unittest.main()
