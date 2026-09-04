from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _ads_spend_reconciliation_evidence


class _Cursor:
    def execute(self, _sql: str) -> None:
        return None

    def fetchone(self):
        return {
            "start_date": dt.date(2026, 8, 7),
            "through_date": dt.date(2026, 9, 3),
            "account_days": 28,
            "reconciled_days": 26,
            "incomplete_days": 1,
            "residual_days": 1,
            "campaign_spend": "1000.00",
            "product_spend": "990.00",
            "unassigned_product_spend": "10.00",
            "max_abs_daily_unassigned_spend": "8.00",
        }


class AdsSpendReconciliationEvidenceTests(unittest.TestCase):
    def test_preserves_residual_and_state_counts(self) -> None:
        result = _ads_spend_reconciliation_evidence(_Cursor())

        self.assertEqual(result["start_date"], "2026-08-07")
        self.assertEqual(result["through_date"], "2026-09-03")
        self.assertEqual(result["reconciled_days"], 26)
        self.assertEqual(result["incomplete_days"], 1)
        self.assertEqual(result["residual_days"], 1)
        self.assertEqual(result["unassigned_product_spend"], "10.00")


if __name__ == "__main__":
    unittest.main()
