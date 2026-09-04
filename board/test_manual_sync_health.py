import unittest
from pathlib import Path

from health_api import MANUAL_SYNC_COOLDOWN_SECONDS, load_health_jobs


class RecordingCursor:
    def __init__(self, rows):
        self.rows = rows
        self.query = ""
        self.params = ()

    def execute(self, query, params=()):
        self.query = query
        self.params = params

    def fetchall(self):
        return self.rows


class ManualSyncHealthContractTest(unittest.TestCase):
    def test_health_rows_expose_latest_lifecycle_and_server_permission(self):
        cursor = RecordingCursor(
            [
                {
                    "source": "amazon_spapi",
                    "job_name": "orders_v2026",
                    "latest_status": "success",
                    "age_seconds": 60,
                    "manual_sync_request_id": 71,
                    "manual_sync_status": "running",
                    "manual_sync_can_request": False,
                    "manual_sync_cooldown_seconds": 780,
                }
            ]
        )

        jobs = load_health_jobs(cursor)

        self.assertEqual(jobs[0]["manual_sync_request_id"], 71)
        self.assertEqual(jobs[0]["manual_sync_status"], "running")
        self.assertFalse(jobs[0]["manual_sync_can_request"])
        self.assertEqual(jobs[0]["manual_sync_cooldown_seconds"], 780)
        self.assertIn("ops.manual_sync_request", cursor.query)
        self.assertIn("m.status IN ('pending','running')", cursor.query)
        self.assertIn("interval '15 minutes'", cursor.query)

    def test_post_contract_guards_active_requests_past_nominal_cooldown(self):
        source = Path(__file__).with_name("server.py").read_text()

        self.assertEqual(MANUAL_SYNC_COOLDOWN_SECONDS, 900)
        self.assertIn("status IN ('pending','running')", source)
        self.assertIn('reason = "in_progress"', source)
        self.assertIn('"retry_after_seconds": MANUAL_SYNC_COOLDOWN_SECONDS', source)

    def test_post_contract_accepts_every_brand_analytics_collector(self):
        source = Path(__file__).with_name("server.py").read_text()

        for job_name in (
            "search_query_performance",
            "search_query_performance_weekly",
            "search_catalog_performance_weekly",
            "search_terms_weekly",
            "market_basket_weekly",
            "repeat_purchase_weekly",
        ):
            self.assertIn(f'"{job_name}"', source)


if __name__ == "__main__":
    unittest.main()
