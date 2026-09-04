from __future__ import annotations

import unittest
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

from .brand_analytics_market_basket import (
    REPORT_TYPE,
    _create_report,
    _row_values,
    report_rows,
    validate_report_payload,
)
from .settings import settings
from .spapi import SpApiError


def _payload(rows: list[dict]) -> dict:
    return {
        "reportSpecification": {
            "reportType": REPORT_TYPE,
            "dataStartTime": "2026-08-23",
            "dataEndTime": "2026-08-29",
            "marketplaceIds": [settings.marketplace_id],
            "reportOptions": {"reportPeriod": "WEEK"},
        },
        "dataByAsin": rows,
    }


class BrandAnalyticsMarketBasketTests(unittest.TestCase):
    def test_create_report_uses_exact_week_without_asin_filter(self) -> None:
        client = MagicMock()
        client.post.return_value = {"payload": {"reportId": "basket-1"}}

        result = _create_report(client, date(2026, 8, 23), date(2026, 8, 29))

        self.assertEqual(result, "basket-1")
        body = client.post.call_args.kwargs["json_body"]
        self.assertEqual(body["reportType"], REPORT_TYPE)
        self.assertEqual(body["marketplaceIds"], [settings.marketplace_id])
        self.assertEqual(body["reportOptions"], {"reportPeriod": "WEEK"})
        self.assertNotIn("asin", body["reportOptions"])
        self.assertNotIn("asins", body["reportOptions"])

    def test_report_rows_accepts_direct_and_wrapped_payloads(self) -> None:
        rows = [{"asin": "B000000001"}]
        self.assertEqual(report_rows({"dataByAsin": rows}), rows)
        self.assertEqual(report_rows({"payload": {"dataByAsin": rows}}), rows)

    def test_row_mapping_preserves_pair_rank_and_ratio(self) -> None:
        columns, values = _row_values(
            {
                "startDate": "2026-08-23",
                "endDate": "2026-08-29",
                "asin": "B000000001",
                "purchasedWithAsin": "B000000002",
                "purchasedWithRank": 2,
                "combinationPct": 0.0378,
            },
            123,
            "basket-1",
        )
        mapped = dict(zip(columns, values, strict=True))

        self.assertEqual(mapped["asin"], "B000000001")
        self.assertEqual(mapped["purchased_with_asin"], "B000000002")
        self.assertEqual(mapped["purchased_with_rank"], 2)
        self.assertEqual(mapped["combination_ratio"], Decimal("0.0378"))

    def test_reconciliation_requires_exact_week_and_unique_pair(self) -> None:
        row = {
            "startDate": "2026-08-23",
            "endDate": "2026-08-29",
            "asin": "B000000001",
            "purchasedWithAsin": "B000000002",
            "purchasedWithRank": 1,
            "combinationPct": 0.42,
        }
        self.assertEqual(
            validate_report_payload(
                _payload([row]), date(2026, 8, 23), date(2026, 8, 29)
            ),
            [row],
        )
        with self.assertRaisesRegex(SpApiError, "duplicated its canonical pair"):
            validate_report_payload(
                _payload([row, row]), date(2026, 8, 23), date(2026, 8, 29)
            )

    def test_reconciliation_rejects_invalid_ratio_or_period(self) -> None:
        row = {
            "startDate": "2026-08-23",
            "endDate": "2026-08-29",
            "asin": "B000000001",
            "purchasedWithAsin": "B000000002",
            "purchasedWithRank": 1,
            "combinationPct": 1.01,
        }
        with self.assertRaisesRegex(SpApiError, "invalid canonical row"):
            validate_report_payload(
                _payload([row]), date(2026, 8, 23), date(2026, 8, 29)
            )
        payload = _payload([])
        payload["reportSpecification"]["dataEndTime"] = "2026-08-30"
        with self.assertRaisesRegex(SpApiError, "requested period grain"):
            validate_report_payload(
                payload, date(2026, 8, 23), date(2026, 8, 29)
            )

    def test_reconciliation_rejects_wrong_marketplace_contract(self) -> None:
        payload = _payload([])
        payload["reportSpecification"]["marketplaceIds"] = ["ATVPDKIKX0DER"]

        with self.assertRaisesRegex(SpApiError, "source contract"):
            validate_report_payload(
                payload, date(2026, 8, 23), date(2026, 8, 29)
            )


if __name__ == "__main__":
    unittest.main()
