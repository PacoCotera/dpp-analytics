from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _brand_market_basket_evidence


class _Cursor:
    def execute(self, _sql: str) -> None:
        return None

    def fetchall(self):
        return [
            {
                "report_period": "WEEK",
                "rows": 48,
                "periods": 4,
                "catalog_asins": 7,
                "companion_asins": 31,
                "current_owned_companion_asins": 4,
                "rows_with_combination_ratio": 48,
                "first_period_start": dt.date(2026, 8, 2),
                "through_date": dt.date(2026, 8, 29),
            }
        ]


class BrandMarketBasketEvidenceTests(unittest.TestCase):
    def test_evidence_separates_catalog_and_companion_ownership(self) -> None:
        result = _brand_market_basket_evidence(_Cursor())

        self.assertEqual(result["WEEK"]["catalog_asins"], 7)
        self.assertEqual(result["WEEK"]["companion_asins"], 31)
        self.assertEqual(result["WEEK"]["current_owned_companion_asins"], 4)
        self.assertEqual(result["WEEK"]["rows_with_combination_ratio"], 48)
        self.assertEqual(result["WEEK"]["through_date"], "2026-08-29")


if __name__ == "__main__":
    unittest.main()
