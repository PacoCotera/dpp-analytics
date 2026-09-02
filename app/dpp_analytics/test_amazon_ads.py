from __future__ import annotations

import unittest
from datetime import date
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from .amazon_ads import AmazonAdsClient


def _response(status_code: int, body: dict[str, object]):
    response = MagicMock()
    response.status_code = status_code
    response.json.return_value = body
    return response


class AmazonAdsReportCreationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.ads = AmazonAdsClient.__new__(AmazonAdsClient)
        self.ads.base = "https://ads.example"
        self.ads.client = MagicMock()

    def _create(self) -> str:
        return self.ads.create_report(
            "profile-1",
            date(2026, 8, 1),
            date(2026, 8, 31),
            grain="campaign",
        )

    @patch.object(AmazonAdsClient, "headers", return_value={})
    def test_reuses_report_id_returned_with_duplicate_response(self, _headers) -> None:
        self.ads.client.post.return_value = _response(425, {"reportId": "existing-report"})

        self.assertEqual(self._create(), "existing-report")
        self.ads.client.post.assert_called_once()

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


if __name__ == "__main__":
    unittest.main()
