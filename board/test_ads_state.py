from __future__ import annotations

import unittest

from ads_state import ADS_CONNECTION_STATES, ads_connection_state, connection_contract


class FakeCursor:
    def __init__(self, relation=True, row=None):
        self.results = [{"relation": "ops.integration_state" if relation else None}, row or {}]

    def execute(self, _query):
        return None

    def fetchone(self):
        return self.results.pop(0)


class AdsStateContractTest(unittest.TestCase):
    def test_every_lifecycle_state_has_one_complete_presentation(self):
        presentations = [connection_contract(state) for state in ADS_CONNECTION_STATES]
        self.assertEqual([item["state"] for item in presentations], list(ADS_CONNECTION_STATES))
        for item in presentations:
            self.assertTrue(item["badge"])
            self.assertTrue(item["headline"])
            self.assertTrue(item["detail"])
            self.assertTrue(item["note"])

    def test_recorded_state_is_preserved_for_every_api_consumer(self):
        state = ads_connection_state(
            FakeCursor(row={"state": "BACKFILL_RUNNING", "detail_code": "INITIAL_HISTORY_PENDING"})
        )
        self.assertEqual(state["state"], "BACKFILL_RUNNING")
        self.assertEqual(state["headline"], "Amazon Ads history is backfilling.")
        self.assertEqual(state["detail_code"], "INITIAL_HISTORY_PENDING")

    def test_current_vendor_report_progress_is_exposed_without_credentials(self):
        state = ads_connection_state(
            FakeCursor(row={
                "state": "BACKFILL_RUNNING",
                "detail_code": "REPORT_VENDOR_PROCESSING",
                "metadata": {
                    "account_id": "profile-1",
                    "grain": "campaign",
                    "report_number": 1,
                    "report_total": 4,
                    "report_id": "report-1",
                    "vendor_status": "PROCESSING",
                    "start_date": "2026-06-01",
                    "end_date": "2026-06-30",
                    "report_started_at": "2026-09-02T20:00:00+00:00",
                    "last_polled_at": "2026-09-02T20:01:00+00:00",
                    "client_secret": "must-not-leak",
                },
            })
        )
        progress = state["report_progress"]
        self.assertEqual(progress["report_id"], "report-1")
        self.assertEqual(progress["vendor_status"], "PROCESSING")
        self.assertEqual(progress["report_number"], 1)
        self.assertEqual(progress["report_total"], 4)
        self.assertGreaterEqual(progress["elapsed_seconds"], 0)
        self.assertNotIn("client_secret", progress)

    def test_missing_or_invalid_worker_state_fails_safe(self):
        missing = ads_connection_state(FakeCursor(relation=False))
        invalid = connection_contract("invented")
        self.assertEqual(missing["state"], "NOT_CONNECTED")
        self.assertEqual(invalid["state"], "FAILED")
        self.assertEqual(invalid["detail_code"], "INVALID_RECORDED_STATE")


if __name__ == "__main__":
    unittest.main()
