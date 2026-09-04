from __future__ import annotations

import unittest
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock

from .brand_analytics_search_catalog import (
    REPORT_TYPE,
    _create_report,
    _row_values,
    report_rows,
    validate_report_rows,
)
from .settings import settings
from .spapi import SpApiError


class BrandAnalyticsSearchCatalogTests(unittest.TestCase):
    def test_create_report_uses_production_verified_plural_asins_option(self) -> None:
        client = MagicMock()
        client.post.return_value = {"payload": {"reportId": "catalog-1"}}

        result = _create_report(
            client, ["B000000001", "B000000002"],
            date(2026, 8, 23), date(2026, 8, 29),
        )

        self.assertEqual(result, "catalog-1")
        body = client.post.call_args.kwargs["json_body"]
        self.assertEqual(body["reportType"], REPORT_TYPE)
        self.assertEqual(body["marketplaceIds"], [settings.marketplace_id])
        self.assertEqual(
            body["reportOptions"],
            {"reportPeriod": "WEEK", "asins": "B000000001 B000000002"},
        )

    def test_report_rows_accepts_direct_and_wrapped_payloads(self) -> None:
        rows = [{"asin": "B000000001"}]
        self.assertEqual(report_rows({"dataByAsin": rows}), rows)
        self.assertEqual(report_rows({"payload": {"dataByAsin": rows}}), rows)

    def test_row_mapping_preserves_complete_production_observed_contract(self) -> None:
        mapped = _row_values(
            {
                "startDate": "2026-08-23",
                "endDate": "2026-08-29",
                "asin": "B000000001",
                "impressionData": {
                    "impressionCount": 1000,
                    "impressionMedianPrice": {"amount": 249.5, "currencyCode": "MXN"},
                    "sameDayShippingImpressionCount": 100,
                    "oneDayShippingImpressionCount": 200,
                    "twoDayShippingImpressionCount": 300,
                },
                "clickData": {
                    "clickCount": 100,
                    "clickRate": 0.1,
                    "clickedMedianPrice": {"amount": 245, "currencyCode": "MXN"},
                    "sameDayShippingClickCount": 10,
                    "oneDayShippingClickCount": 20,
                    "twoDayShippingClickCount": 30,
                },
                "cartAddData": {
                    "cartAddCount": 30,
                    "cartAddedMedianPrice": {"amount": 240, "currencyCode": "MXN"},
                    "sameDayShippingCartAddCount": 3,
                    "oneDayShippingCartAddCount": 6,
                    "twoDayShippingCartAddCount": 9,
                },
                "purchaseData": {
                    "purchaseCount": 12,
                    "conversionRate": 0.12,
                    "purchaseMedianPrice": {"amount": 235, "currencyCode": "MXN"},
                    "searchTrafficSales": {"amount": 2820, "currencyCode": "MXN"},
                    "sameDayShippingPurchaseCount": 1,
                    "oneDayShippingPurchaseCount": 2,
                    "twoDayShippingPurchaseCount": 3,
                },
            },
            123,
            "catalog-1",
        )

        columns, values = mapped or ([], [])
        row = dict(zip(columns, values, strict=True))
        self.assertEqual(row["report_period"], "WEEK")
        self.assertEqual(row["asin"], "B000000001")
        self.assertEqual(row["click_rate"], Decimal("0.1"))
        self.assertEqual(row["conversion_rate"], Decimal("0.12"))
        self.assertEqual(row["search_traffic_sales"], Decimal("2820"))
        self.assertEqual(row["search_traffic_sales_currency"], "MXN")
        self.assertEqual(row["two_day_shipping_purchase_count"], 3)

    def test_incomplete_source_row_is_not_promoted(self) -> None:
        self.assertIsNone(_row_values({"asin": "B000000001"}, 1, "catalog-1"))

    def test_source_reconciliation_rejects_wrong_period_and_unrequested_asin(self) -> None:
        with self.assertRaisesRegex(SpApiError, "requested period grain"):
            validate_report_rows(
                [{
                    "asin": "B000000001",
                    "startDate": "2026-08-24",
                    "endDate": "2026-08-29",
                }],
                ["B000000001"],
                date(2026, 8, 23),
                date(2026, 8, 29),
            )
        with self.assertRaisesRegex(SpApiError, "unrequested ASIN"):
            validate_report_rows(
                [{
                    "asin": "B000000002",
                    "startDate": "2026-08-23",
                    "endDate": "2026-08-29",
                }],
                ["B000000001"],
                date(2026, 8, 23),
                date(2026, 8, 29),
            )


if __name__ == "__main__":
    unittest.main()
