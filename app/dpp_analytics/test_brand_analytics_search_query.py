from __future__ import annotations

import unittest
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock, patch

from .brand_analytics_search_query import (
    REPORT_TYPE,
    _create_report,
    _row_values,
    chunk_asins,
    completed_month_periods,
    normalize_query,
    report_rows,
    _wait_for_report,
)
from .settings import settings


class BrandAnalyticsSearchQueryTests(unittest.TestCase):
    def test_completed_months_are_newest_first(self) -> None:
        self.assertEqual(
            completed_month_periods(date(2026, 9, 3), 3),
            [
                (date(2026, 8, 1), date(2026, 8, 31)),
                (date(2026, 7, 1), date(2026, 7, 31)),
                (date(2026, 6, 1), date(2026, 6, 30)),
            ],
        )

    def test_asin_chunks_respect_report_option_limit(self) -> None:
        asins = [f"B0{i:08d}" for i in range(45)]
        chunks = chunk_asins(asins)
        self.assertEqual([asin for chunk in chunks for asin in chunk], sorted(asins))
        self.assertTrue(all(len(" ".join(chunk)) <= 200 for chunk in chunks))

    def test_query_key_normalizes_without_mutating_source_text(self) -> None:
        self.assertEqual(normalize_query("  Dog\u00a0  MOM  "), "dog mom")

    def test_create_report_uses_documented_month_options(self) -> None:
        client = MagicMock()
        client.post.return_value = {"payload": {"reportId": "r-1"}}
        result = _create_report(
            client,
            ["B000000001", "B000000002"],
            date(2026, 8, 1),
            date(2026, 8, 31),
        )
        self.assertEqual(result, "r-1")
        _, kwargs = client.post.call_args
        self.assertEqual(kwargs["json_body"]["reportType"], REPORT_TYPE)
        self.assertEqual(
            kwargs["json_body"]["reportOptions"],
            {"reportPeriod": "MONTH", "asin": "B000000001 B000000002"},
        )
        self.assertEqual(kwargs["json_body"]["marketplaceIds"], [settings.marketplace_id])

    def test_report_rows_accepts_direct_and_spapi_wrapped_payloads(self) -> None:
        rows = [{"asin": "B000000001"}]
        self.assertEqual(report_rows({"dataByAsin": rows}), rows)
        self.assertEqual(report_rows({"payload": {"dataByAsin": rows}}), rows)

    @patch("dpp_analytics.brand_analytics_search_query.time.monotonic")
    @patch("dpp_analytics.brand_analytics_search_query.time.sleep")
    def test_report_polling_uses_brand_analytics_timeout(
        self, _sleep: MagicMock, monotonic: MagicMock
    ) -> None:
        monotonic.side_effect = [0, 0, 3601]
        client = MagicMock()
        client.get.return_value = {"processingStatus": "IN_QUEUE"}

        with self.assertRaisesRegex(TimeoutError, "within 3600s"):
            _wait_for_report(client, "report-1")

    def test_row_mapping_preserves_source_and_ratio_semantics(self) -> None:
        mapped = _row_values(
            {
                "startDate": "2026-08-01",
                "endDate": "2026-08-31",
                "asin": "B000000001",
                "searchQueryData": {
                    "searchQuery": "Dog Mom",
                    "searchQueryScore": 7,
                    "searchQueryVolume": 1000,
                },
                "impressionData": {
                    "totalQueryImpressionCount": 8000,
                    "asinImpressionCount": 800,
                    "asinImpressionShare": 0.1,
                },
                "clickData": {
                    "totalClickCount": 400,
                    "asinClickCount": 40,
                    "asinClickShare": 0.1,
                    "totalMedianClickPrice": {"amount": 249.5, "currencyCode": "MXN"},
                },
                "cartAddData": {"totalCartAddCount": 100, "asinCartAddCount": 20},
                "purchaseData": {
                    "totalPurchaseCount": 50,
                    "asinPurchaseCount": 12,
                    "asinPurchaseShare": 0.24,
                },
            },
            123,
            "report-1",
        )
        self.assertIsNotNone(mapped)
        columns, values = mapped or ([], [])
        self.assertEqual(len(columns), len(values))
        row = dict(zip(columns, values, strict=True))
        self.assertEqual(row["search_query"], "Dog Mom")
        self.assertEqual(row["search_query_key"], "dog mom")
        self.assertEqual(row["asin_impression_share"], Decimal("0.1"))
        self.assertEqual(row["asin_purchase_share"], Decimal("0.24"))
        self.assertEqual(row["total_median_click_price"], Decimal("249.5"))
        self.assertEqual(row["click_total_currency"], "MXN")
        self.assertEqual(row["source_payload_id"], 123)


if __name__ == "__main__":
    unittest.main()
