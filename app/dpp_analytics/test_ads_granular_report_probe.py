from __future__ import annotations

import datetime as dt
import unittest

from .production_probe import _ads_granular_report_evidence


class _Cursor:
    def __init__(self) -> None:
        self._result = 0

    def execute(self, _sql: str) -> None:
        self._result += 1

    def fetchall(self):
        if self._result == 1:
            return [
                {
                    "report_grain": "AD_GROUP",
                    "rows": 42,
                    "accounts": 1,
                    "campaigns": 4,
                    "source_reports": 2,
                    "first_date": dt.date(2026, 8, 1),
                    "through_date": dt.date(2026, 9, 3),
                }
            ]
        return [
            {
                "report_grain": "AD_GROUP",
                "start_date": dt.date(2026, 8, 7),
                "through_date": dt.date(2026, 9, 3),
                "account_days": 28,
                "reconciled_days": 26,
                "incomplete_days": 1,
                "residual_days": 1,
                "campaign_spend": "1000.00",
                "grain_spend": "990.00",
                "unassigned_spend": "10.00",
                "max_abs_daily_unassigned_spend": "8.00",
            }
        ]


class AdsGranularReportEvidenceTests(unittest.TestCase):
    def test_reports_fact_coverage_and_preserves_residuals(self) -> None:
        result = _ads_granular_report_evidence(_Cursor())

        self.assertEqual(result["fact_grains"]["AD_GROUP"]["rows"], 42)
        self.assertEqual(
            result["fact_grains"]["AD_GROUP"]["through_date"], "2026-09-03"
        )
        reconciliation = result["spend_reconciliation"]["AD_GROUP"]
        self.assertEqual(reconciliation["reconciled_days"], 26)
        self.assertEqual(reconciliation["incomplete_days"], 1)
        self.assertEqual(reconciliation["residual_days"], 1)
        self.assertEqual(reconciliation["unassigned_spend"], "10.00")


if __name__ == "__main__":
    unittest.main()
