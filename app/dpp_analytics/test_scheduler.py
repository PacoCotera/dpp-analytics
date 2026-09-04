from __future__ import annotations

import threading
import unittest
from unittest.mock import patch

from .scheduler import (
    _ads_delay_after_result,
    _ads_traffic_quality_delay_after_result,
    _brand_analytics_delay_after_result,
    _ingest_scheduled_brand_analytics,
    _initial_ads_due,
    _initial_ads_traffic_quality_due,
    _initial_brand_analytics_due,
    _start_background_job,
)
from .settings import settings


class BackgroundSchedulerTests(unittest.TestCase):
    def test_slow_optional_job_does_not_block_scheduler_thread(self) -> None:
        started = threading.Event()
        release = threading.Event()
        outcome = {}

        def slow_job() -> dict:
            started.set()
            release.wait(timeout=2)
            return {"status": "ok"}

        thread = _start_background_job("test_optional", slow_job, outcome=outcome)
        try:
            self.assertTrue(thread.daemon)
            self.assertTrue(started.wait(timeout=1))
            self.assertTrue(thread.is_alive())
        finally:
            release.set()
            thread.join(timeout=1)

        self.assertFalse(thread.is_alive())
        self.assertEqual(outcome["result"], {"status": "ok"})

    @patch("dpp_analytics.scheduler.ads_backfill_complete", return_value=False)
    def test_incomplete_ads_backfill_is_due_immediately(self, _complete) -> None:
        self.assertEqual(_initial_ads_due(), 0.0)

    def test_successful_incomplete_ads_window_chains_immediately(self) -> None:
        self.assertEqual(
            _ads_delay_after_result({"status": "success", "backfill_complete": False}),
            0,
        )

    def test_failed_ads_run_retries_in_five_minutes(self) -> None:
        self.assertEqual(_ads_delay_after_result(None), 300)

    def test_current_ads_run_keeps_normal_interval(self) -> None:
        self.assertEqual(
            _ads_delay_after_result({"status": "success", "backfill_complete": True}),
            settings.ads_reporting_interval_seconds,
        )

    @patch(
        "dpp_analytics.scheduler.ads_traffic_quality_backfill_complete",
        return_value=False,
    )
    def test_incomplete_ads_traffic_quality_backfill_is_due_immediately(
        self, _complete
    ) -> None:
        self.assertEqual(_initial_ads_traffic_quality_due(), 0.0)

    def test_successful_incomplete_ads_traffic_window_chains_immediately(self) -> None:
        self.assertEqual(
            _ads_traffic_quality_delay_after_result(
                {"status": "success", "backfill_complete": False}
            ),
            0,
        )

    def test_failed_ads_traffic_run_retries_in_five_minutes(self) -> None:
        self.assertEqual(_ads_traffic_quality_delay_after_result(None), 300)

    @patch("dpp_analytics.scheduler._brand_analytics_backfill_complete", return_value=False)
    def test_incomplete_brand_analytics_backfill_is_due_immediately(
        self, _complete
    ) -> None:
        self.assertEqual(_initial_brand_analytics_due(), 0.0)

    def test_successful_incomplete_brand_analytics_month_chains_immediately(self) -> None:
        self.assertEqual(
            _brand_analytics_delay_after_result(
                {"status": "success", "backfill_complete": False}
            ),
            0,
        )

    def test_failed_brand_analytics_run_retries_in_five_minutes(self) -> None:
        self.assertEqual(_brand_analytics_delay_after_result(None), 300)

    def test_current_brand_analytics_run_keeps_normal_interval(self) -> None:
        self.assertEqual(
            _brand_analytics_delay_after_result(
                {"status": "success", "backfill_complete": True}
            ),
            settings.brand_analytics_search_query_interval_seconds,
        )

    @patch("dpp_analytics.scheduler._brand_analytics_backfill_complete", return_value=False)
    @patch("dpp_analytics.scheduler.ingest_search_catalog_performance")
    @patch("dpp_analytics.scheduler.weekly_search_query_backfill_complete", return_value=False)
    @patch("dpp_analytics.scheduler.ingest_weekly_search_query_performance")
    def test_brand_scheduler_prioritizes_weekly_query_history(
        self, weekly_ingest, _weekly_complete, catalog_ingest, _all_complete
    ) -> None:
        weekly_ingest.return_value = {"status": "success"}

        result = _ingest_scheduled_brand_analytics()

        weekly_ingest.assert_called_once_with()
        catalog_ingest.assert_not_called()
        self.assertFalse(result["backfill_complete"])

    @patch("dpp_analytics.scheduler._brand_analytics_backfill_complete", return_value=False)
    @patch("dpp_analytics.scheduler.ingest_search_query_performance")
    @patch("dpp_analytics.scheduler.search_catalog_backfill_complete", return_value=False)
    @patch("dpp_analytics.scheduler.ingest_search_catalog_performance")
    @patch("dpp_analytics.scheduler.weekly_search_query_backfill_complete", return_value=True)
    def test_brand_scheduler_runs_catalog_before_monthly_query_refresh(
        self, _weekly_complete, catalog_ingest, _catalog_complete,
        monthly_ingest, _all_complete,
    ) -> None:
        catalog_ingest.return_value = {"status": "success"}

        result = _ingest_scheduled_brand_analytics()

        catalog_ingest.assert_called_once_with()
        monthly_ingest.assert_not_called()
        self.assertFalse(result["backfill_complete"])

    @patch("dpp_analytics.scheduler._brand_analytics_backfill_complete", return_value=False)
    @patch("dpp_analytics.scheduler.ingest_search_query_performance")
    @patch("dpp_analytics.scheduler.ingest_search_terms")
    @patch("dpp_analytics.scheduler.search_terms_backfill_complete", return_value=False)
    @patch("dpp_analytics.scheduler.search_catalog_backfill_complete", return_value=True)
    @patch("dpp_analytics.scheduler.weekly_search_query_backfill_complete", return_value=True)
    def test_brand_scheduler_runs_market_search_terms_before_monthly_query_refresh(
        self, _weekly_complete, _catalog_complete, _terms_complete,
        terms_ingest, monthly_ingest, _all_complete,
    ) -> None:
        terms_ingest.return_value = {"status": "success"}

        result = _ingest_scheduled_brand_analytics()

        terms_ingest.assert_called_once_with()
        monthly_ingest.assert_not_called()
        self.assertFalse(result["backfill_complete"])


if __name__ == "__main__":
    unittest.main()
