from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _brand_repeat_purchase_evidence


class _Cursor:
    def execute(self, _sql: str) -> None:
        return None

    def fetchall(self):
        return [
            {
                "report_period": "WEEK",
                "rows": 28,
                "periods": 4,
                "catalog_asins": 7,
                "rows_with_orders": 28,
                "rows_with_unique_customers": 28,
                "rows_with_repeat_customer_ratio": 28,
                "rows_with_repeat_revenue": 28,
                "currencies": 1,
                "first_period_start": dt.date(2026, 8, 2),
                "through_date": dt.date(2026, 8, 29),
            }
        ]


class BrandRepeatPurchaseEvidenceTests(unittest.TestCase):
    def test_evidence_exposes_coverage_and_non_accounting_basis(self) -> None:
        result = _brand_repeat_purchase_evidence(_Cursor())

        self.assertEqual(result["WEEK"]["catalog_asins"], 7)
        self.assertEqual(result["WEEK"]["rows_with_repeat_revenue"], 28)
        self.assertEqual(
            result["WEEK"]["revenue_basis"],
            "ORDERED_REVENUE_RETURNS_EXCLUDED",
        )
        self.assertEqual(result["WEEK"]["tax_basis"], "SOURCE_UNSPECIFIED")
        self.assertEqual(result["WEEK"]["through_date"], "2026-08-29")


if __name__ == "__main__":
    unittest.main()
