from __future__ import annotations

import unittest
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

from .brand_analytics_repeat_purchase import (
    COMPLETE,
    PARTIAL,
    REPORT_TYPE,
    REVENUE_BASIS,
    TAX_BASIS,
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


def _row() -> dict:
    return {
        "startDate": "2026-08-23",
        "endDate": "2026-08-29",
        "asin": "B000000001",
        "orders": 1256,
        "uniqueCustomers": 1201,
        "repeatCustomersPctTotal": 0.0083,
        "repeatPurchaseRevenue": {"amount": 2246.13, "currencyCode": "MXN"},
        "repeatPurchaseRevenuePctTotal": 0.0217,
    }


class BrandAnalyticsRepeatPurchaseTests(unittest.TestCase):
    def test_create_report_uses_exact_week_without_asin_filter(self) -> None:
        client = MagicMock()
        client.post.return_value = {"payload": {"reportId": "repeat-1"}}

        result = _create_report(client, date(2026, 8, 23), date(2026, 8, 29))

        self.assertEqual(result, "repeat-1")
        body = client.post.call_args.kwargs["json_body"]
        self.assertEqual(body["reportType"], REPORT_TYPE)
        self.assertEqual(body["marketplaceIds"], [settings.marketplace_id])
        self.assertEqual(body["reportOptions"], {"reportPeriod": "WEEK"})
        self.assertNotIn("asin", body["reportOptions"])
        self.assertNotIn("asins", body["reportOptions"])

    def test_report_rows_accepts_direct_and_wrapped_payloads(self) -> None:
        rows = [_row()]
        self.assertEqual(report_rows({"dataByAsin": rows}), rows)
        self.assertEqual(report_rows({"payload": {"dataByAsin": rows}}), rows)

    def test_row_mapping_preserves_counts_money_ratios_and_basis(self) -> None:
        columns, values = _row_values(_row(), 123, "repeat-1")
        mapped = dict(zip(columns, values, strict=True))

        self.assertEqual(mapped["orders"], 1256)
        self.assertEqual(mapped["unique_customers"], 1201)
        self.assertEqual(mapped["repeat_customer_ratio"], Decimal("0.0083"))
        self.assertEqual(mapped["repeat_purchase_revenue"], Decimal("2246.13"))
        self.assertEqual(mapped["repeat_purchase_revenue_currency"], "MXN")
        self.assertEqual(mapped["repeat_purchase_revenue_ratio"], Decimal("0.0217"))
        self.assertEqual(mapped["revenue_basis"], REVENUE_BASIS)
        self.assertEqual(mapped["tax_basis"], TAX_BASIS)
        self.assertEqual(mapped["quality_state"], COMPLETE)
        self.assertEqual(mapped["unavailable_fields"], [])

    def test_reconciliation_requires_exact_contract_and_unique_asin(self) -> None:
        row = _row()
        self.assertEqual(
            validate_report_payload(
                _payload([row]), date(2026, 8, 23), date(2026, 8, 29)
            ),
            [row],
        )
        with self.assertRaisesRegex(SpApiError, "duplicated its canonical ASIN"):
            validate_report_payload(
                _payload([row, row]), date(2026, 8, 23), date(2026, 8, 29)
            )

        payload = _payload([])
        payload["reportSpecification"]["marketplaceIds"] = ["ATVPDKIKX0DER"]
        with self.assertRaisesRegex(SpApiError, "source contract"):
            validate_report_payload(
                payload, date(2026, 8, 23), date(2026, 8, 29)
            )

    def test_partial_measures_are_retained_without_inference(self) -> None:
        row = _row()
        row["repeatPurchaseRevenuePctTotal"] = 1.01
        row["repeatPurchaseRevenue"] = {"amount": None, "currencyCode": ""}
        self.assertEqual(
            validate_report_payload(
                _payload([row]), date(2026, 8, 23), date(2026, 8, 29)
            ),
            [row],
        )
        columns, values = _row_values(row, 123, "repeat-1")
        mapped = dict(zip(columns, values, strict=True))
        self.assertEqual(mapped["quality_state"], PARTIAL)
        self.assertIsNone(mapped["repeat_purchase_revenue"])
        self.assertIsNone(mapped["repeat_purchase_revenue_currency"])
        self.assertIsNone(mapped["repeat_purchase_revenue_ratio"])
        self.assertEqual(mapped["unavailable_fields"], [
            "repeatPurchaseRevenue.amount",
            "repeatPurchaseRevenue.currencyCode",
            "repeatPurchaseRevenuePctTotal",
        ])

        row = _row()
        row["startDate"] = "2026-08-24"
        with self.assertRaisesRegex(SpApiError, "invalid canonical identity"):
            validate_report_payload(
                _payload([row]), date(2026, 8, 23), date(2026, 8, 29)
            )

        payload = _payload([])
        payload["reportSpecification"]["dataEndTime"] = "2026-08-30"
        with self.assertRaisesRegex(SpApiError, "requested period grain"):
            validate_report_payload(
                payload, date(2026, 8, 23), date(2026, 8, 29)
            )


if __name__ == "__main__":
    unittest.main()
