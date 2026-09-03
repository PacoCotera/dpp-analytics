from __future__ import annotations

import json
import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from .amazon_ads import (
    AmazonAdsClient,
    INITIAL_HISTORY_CURSOR,
    _report_progress_callback,
    _target_key,
    _write_search_term_rows,
    _write_target_rows,
    ads_initial_history_complete,
    ingest_ads,
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
        self.ads._token = None
        self.ads._token_expires_at = 0.0

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

    @patch("dpp_analytics.amazon_ads.time.monotonic", return_value=100.0)
    @patch(
        "dpp_analytics.amazon_ads.settings",
        SimpleNamespace(
            ads_client_id="client-id",
            ads_client_secret="client-secret",
            ads_refresh_token="refresh-token",
        ),
    )
    def test_access_token_renews_before_vendor_expiry(self, _clock) -> None:
        self.ads._token = "expired-token"
        self.ads._token_expires_at = 99.0
        self.ads.client.post.return_value = _response(
            200,
            {"access_token": "fresh-token", "expires_in": 3600},
        )

        self.assertEqual(self.ads.access_token(), "fresh-token")
        self.assertEqual(self.ads._token_expires_at, 3640.0)
        self.ads.client.post.assert_called_once()

    @patch("dpp_analytics.amazon_ads.time.sleep")
    @patch("dpp_analytics.amazon_ads.time.monotonic", return_value=0.0)
    @patch(
        "dpp_analytics.amazon_ads.settings",
        SimpleNamespace(
            ads_client_id="client-id",
            ads_client_secret="client-secret",
            ads_refresh_token="refresh-token",
            ads_report_poll_timeout_seconds=3600,
            ads_report_poll_seconds=5,
        ),
    )
    def test_report_poll_refreshes_once_after_unauthorized(
        self, _clock, _sleep
    ) -> None:
        self.ads._token = "expired-token"
        self.ads._token_expires_at = float("inf")
        self.ads.client.get.side_effect = [
            _response(401, {"message": "Unauthorized"}),
            _response(
                200,
                {
                    "reportId": "report-1",
                    "status": "COMPLETED",
                    "url": "https://download.example/report.gz",
                },
            ),
        ]
        self.ads.client.post.return_value = _response(
            200,
            {"access_token": "fresh-token", "expires_in": 3600},
        )

        result = self.ads.wait_for_report("profile-1", "report-1")

        self.assertEqual(result["status"], "COMPLETED")
        self.assertEqual(self.ads.client.get.call_count, 2)
        self.assertEqual(
            self.ads.client.get.call_args_list[0].kwargs["headers"]["Authorization"],
            "Bearer expired-token",
        )
        self.assertEqual(
            self.ads.client.get.call_args_list[1].kwargs["headers"]["Authorization"],
            "Bearer fresh-token",
        )
        self.ads.client.post.assert_called_once()

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
            "ON CONFLICT(account_id,target_id,business_date)",
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

    @patch("dpp_analytics.amazon_ads.date")
    @patch("dpp_analytics.amazon_ads.db.get_cursor")
    def test_completed_history_fallback_survives_the_next_reporting_day(
        self, get_cursor, today
    ) -> None:
        today.today.return_value = date(2026, 9, 3)
        today.fromisoformat.side_effect = date.fromisoformat
        get_cursor.side_effect = lambda _source, _job, name: (
            None if name == INITIAL_HISTORY_CURSOR else "2026-09-01"
        )

        self.assertTrue(ads_initial_history_complete())

    @patch("dpp_analytics.amazon_ads.db.get_cursor")
    def test_durable_history_marker_preserves_completion(self, get_cursor) -> None:
        get_cursor.side_effect = lambda _source, _job, name: (
            "2026-09-01" if name == INITIAL_HISTORY_CURSOR else None
        )

        self.assertTrue(ads_initial_history_complete())

    @patch("dpp_analytics.amazon_ads.time.monotonic", return_value=30.0)
    @patch("dpp_analytics.amazon_ads._publish_state")
    def test_report_progress_preserves_ready_state_for_established_history(
        self, publish, _clock
    ) -> None:
        progress, _metadata = _report_progress_callback(
            "profile-1",
            "product",
            "report-1",
            date(2026, 9, 2),
            date(2026, 9, 2),
            2,
            4,
            history_available=True,
        )

        progress("PENDING", {})

        self.assertEqual(publish.call_args.args[:2], ("READY", "REPORT_REFRESH_RUNNING"))
        self.assertEqual(publish.call_args.kwargs["report_id"], "report-1")
        self.assertEqual(publish.call_args.kwargs["vendor_status"], "PENDING")

    @patch("dpp_analytics.amazon_ads._publish_state")
    @patch("dpp_analytics.amazon_ads.discover_scopes", side_effect=RuntimeError("poll failed"))
    @patch("dpp_analytics.amazon_ads.ads_initial_history_complete", return_value=True)
    @patch(
        "dpp_analytics.amazon_ads._next_window",
        return_value=(date(2026, 9, 2), date(2026, 9, 2)),
    )
    @patch("dpp_analytics.amazon_ads.AmazonAdsClient")
    @patch(
        "dpp_analytics.amazon_ads.settings",
        SimpleNamespace(ads_enabled=True, ads_credentials_present=True),
    )
    def test_failed_incremental_refresh_preserves_ready_history_state(
        self, _client, _window, _history, _discover, publish
    ) -> None:
        with self.assertRaisesRegex(RuntimeError, "poll failed"):
            ingest_ads()

        self.assertEqual(
            publish.call_args_list[0].args[:2],
            ("READY", "REPORT_REFRESH_RUNNING"),
        )
        self.assertEqual(
            publish.call_args_list[-1].args[:2],
            ("READY", "REPORT_REFRESH_FAILED"),
        )


if __name__ == "__main__":
    unittest.main()
