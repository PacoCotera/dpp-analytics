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

    def test_missing_or_invalid_worker_state_fails_safe(self):
        missing = ads_connection_state(FakeCursor(relation=False))
        invalid = connection_contract("invented")
        self.assertEqual(missing["state"], "NOT_CONNECTED")
        self.assertEqual(invalid["state"], "FAILED")
        self.assertEqual(invalid["detail_code"], "INVALID_RECORDED_STATE")


if __name__ == "__main__":
    unittest.main()
