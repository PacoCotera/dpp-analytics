from __future__ import annotations

import json
import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from .amazon_ads import (
    AmazonAdsClient,
    _target_key,
    _write_search_term_rows,
    _write_target_rows,
)


def _response(status_code: int, body: dict[str, object]):
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = body
    response.text = json.dumps(body)
    return response


class AmazonAdsReportCreationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ads = AmazonAdsClient.__new__(AmazonAdsClient)
        self.ads.base = "https://ads.example"
        self.ads.client = MagicMock()

    def _create(self, grain: str = "campaign") -> str:
        return self.ads.create_report(
            "profile-1",
            date(2026, 8, 1),
            date(2026, 8, 31),
            grain=grain,
        )

    @patch.object(AmazonAdsClient, "headers", return_value={})
    def test_reuses_report_id_returned_with_duplicate_response(self, _headers) -> None:
        self.ads.client.post.return_value = _response(425, {"reportId": "existing-report"})

        self.assertEqual(self._create(), "existing-report")
        self.ads.client.post.assert_called_once()

    @patch.object(AmazonAdsClient, "headers", return_value={})
    def test_create_error_includes_grain_and_amazon_detail(self, _headers) -> None:
        self.ads.client.post.return_value = _response(
            400,
            {"detail": "Column targetingId is not supported"},
        )

        with self.assertRaisesRegex(
            RuntimeError,
            "grain=campaign.*targetingId is not supported",
        ):
            self._create()

    @patch.object(AmazonAdsClient, "headers", return_value={})
    def test_target_reports_use_supported_sponsored_products_columns(self, _headers) -> None:
        self.ads.client.post.return_value = _response(202, {"reportId": "target-report"})

        self.assertEqual(self._create("target"), "target-report")
        columns = self.ads.client.post.call_args.kwargs["json"]["configuration"]["columns"]
        self.assertNotIn("targetingId", columns)
        self.assertNotIn("targetingExpression", columns)
        self.assertIn("keywordId", columns)
        self.assertIn("targeting", columns)

    def test_target_key_uses_expression_when_keyword_id_is_absent(self) -> None:
        self.assertEqual(
            _target_key({"keywordId": "", "targeting": "asin=B012345678"}),
            "asin=B012345678",
        )
        self.assertEqual(
            _target_key({"keywordId": "keyword-1", "targeting": "asin=B012345678"}),
            "keyword-1",
        )

    @patch.object(AmazonAdsClient, "headers", return_value={})
    def test_search_term_reports_use_supported_sponsored_products_columns(self, _headers) -> None:
        self.ads.client.post.return_value = _response(202, {"reportId": "search-report"})

        self.assertEqual(self._create("search_term"), "search-report")
        columns = self.ads.client.post.call_args.kwargs["json"]["configuration"]["columns"]
        self.assertNotIn("targetingId", columns)
        self.assertIn("keywordId", columns)
        self.assertIn("targeting", columns)

    @patch.object(AmazonAdsClient, "headers", return_value={})
    @patch("dpp_analytics.amazon_ads.time.sleep")
    @patch("dpp_analytics.amazon_ads.time.monotonic", side_effect=[0, 1])
    @patch(
        "dpp_analytics.amazon_ads.settings",
        SimpleNamespace(ads_report_poll_timeout_seconds=900, ads_report_poll_seconds=5),
    )
    def test_retries_duplicate_without_report_id(
        self, _clock, sleep, _headers
    ) -> None:
        self.ads.client.post.side_effect = [
            _response(425, {}),
            _response(202, {"reportId": "memorized-report"}),
        ]

        self.assertEqual(self._create(), "memorized-report")
        sleep.assert_called_once_with(5)
        self.assertEqual(self.ads.client.post.call_count, 2)

    @patch.object(AmazonAdsClient, "headers", return_value={})
    @patch("dpp_analytics.amazon_ads.time.sleep")
    @patch("dpp_analytics.amazon_ads.time.monotonic", side_effect=[0, 1])
    @patch(
        "dpp_analytics.amazon_ads.settings",
        SimpleNamespace(ads_report_poll_timeout_seconds=900, ads_report_poll_seconds=5),
    )
    def test_wait_for_report_publishes_vendor_status(
        self, _clock, _sleep, _headers
    ) -> None:
        self.ads.client.get.return_value = _response(200, {
            "reportId": "report-1",
            "status": "COMPLETED",
            "url": "https://download.example/report.gz",
        })
        statuses = []

        result = self.ads.wait_for_report(
            "profile-1",
            "report-1",
            on_status=lambda status, _payload: statuses.append(status),
        )

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(statuses, ["COMPLETED"])

    def _writer_sql(self, writer, row: dict[str, object]) -> str:
        with patch("dpp_analytics.amazon_ads.db.connect") as connect:
            connection = connect.return_value.__enter__.return_value
            cursor = connection.cursor.return_value.__enter__.return_value
            writer("profile-1", [row], "report-1")
            return cursor.execute.call_args.args[0]

    def test_target_upsert_matches_deployed_primary_key(self) -> None:
        sql = self._writer_sql(
            _write_target_rows,
            {"date": "2026-08-01", "campaignId": "campaign-1", "keywordId": "keyword-1"},
        )
        self.assertIn(
            "ON CONFLICT(account_id,business_date,ad_product,campaign_id,ad_group_id,target_id,search_term)",
            sql,
        )

    def test_search_term_upsert_matches_corrected_primary_key(self) -> None:
        sql = self._writer_sql(
            _write_search_term_rows,
            {
                "date": "2026-08-01",
                "campaignId": "campaign-1",
                "keywordId": "keyword-1",
                "searchTerm": "notebook",
            },
        )
        self.assertIn(
            "ON CONFLICT(account_id,business_date,campaign_id,ad_group_id,target_id,search_term)",
            sql,
        )
        self.assertNotIn("ON CONFLICT(account_id,business_date,ad_product", sql)


if __name__ == "__main__":
    unittest.main()
