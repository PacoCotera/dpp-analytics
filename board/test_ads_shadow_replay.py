from __future__ import annotations

from contextlib import nullcontext
from datetime import datetime, timezone
from unittest.mock import patch
import unittest

from ads_shadow_replay import (
    _expire_absent_candidates,
    _load_replay_facts,
    _lookback_days,
    replay_ads_shadow_candidates,
)
from decision_contract import finalize_candidate
from test_decision_contract import sample_candidate


NOW = datetime(2026, 9, 5, 1, 0, tzinfo=timezone.utc)


class Cursor:
    def __init__(self, one=None, rows=None):
        self.one = list(one or [])
        self.rows = list(rows or [])
        self.executions = []

    def execute(self, sql, params=()):
        self.executions.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self.one.pop(0) if self.one else None

    def fetchall(self):
        return list(self.rows)


class Connection:
    def __init__(self, cursor):
        self._cursor = cursor
        self.commits = 0

    def cursor(self):
        return nullcontext(self._cursor)

    def commit(self):
        self.commits += 1


class AdvertisingShadowReplayTests(unittest.TestCase):
    def test_attribution_lookback_uses_declared_contract(self):
        self.assertEqual(_lookback_days("7d_click"), 7)
        self.assertEqual(_lookback_days("14 d"), 14)
        self.assertEqual(_lookback_days(None), 7)

    def test_missing_stored_window_becomes_honest_source_state(self):
        cursor = Cursor(one=[None])
        facts = _load_replay_facts(cursor, "A1AM78C64UM0Y8", now=NOW)
        self.assertEqual(facts["source"]["state"], "NO_STORED_WINDOW")
        self.assertFalse(facts["source"]["trusted"])
        self.assertEqual(facts["products"], [])
        self.assertEqual(facts["window"]["id"], "CURRENT_SOURCE_STATE")

    def test_replay_persists_blocker_and_commits_one_atomic_result(self):
        facts = {
            "window": {
                "id": "CURRENT_SOURCE_STATE",
                "start": "2026-09-05",
                "through": "2026-09-05",
                "state": "UNAVAILABLE",
                "cutoff": NOW,
                "currency": "MXN",
            },
            "source": {
                "marketplace_id": "A1AM78C64UM0Y8",
                "source_key": "amazon_ads",
                "trusted": False,
                "state": "NO_STORED_WINDOW",
                "reason": "No stored window.",
                "cutoff": NOW,
            },
            "products": [],
        }
        conn = Connection(Cursor())
        with (
            patch("ads_shadow_replay._load_replay_facts", return_value=facts),
            patch("ads_shadow_replay.persist_candidate", return_value=17) as persist,
            patch("ads_shadow_replay._expire_absent_candidates", return_value=0),
        ):
            result = replay_ads_shadow_candidates(conn, now=NOW)
        self.assertEqual(result["candidates"], 1)
        self.assertEqual(result["kinds"]["ADS_DATA_BLOCKER"], 1)
        self.assertEqual(result["snapshot_ids"], [17])
        self.assertEqual(persist.call_count, 1)
        self.assertEqual(conn.commits, 1)

    def test_absent_shadow_candidate_appends_terminal_snapshot(self):
        candidate = sample_candidate()
        candidate["kind"] = "ADS_INVENTORY_CONFLICT"
        candidate["rule"]["key"] = "ADS_INVENTORY_CONFLICT"
        candidate["rule"]["version"] = 2
        candidate = finalize_candidate(candidate)
        cursor = Cursor(rows=[{"candidate": candidate}])
        with patch("ads_shadow_replay.persist_candidate", return_value=19) as persist:
            count = _expire_absent_candidates(
                cursor, set(), marketplace_id="A1AM78C64UM0Y8"
            )
        self.assertEqual(count, 1)
        self.assertEqual(cursor.executions[0][1][1], "A1AM78C64UM0Y8")
        terminal = persist.call_args.args[1]
        self.assertEqual(terminal["state"], "EXPIRED")
        self.assertEqual(terminal["id"], candidate["id"])
        self.assertEqual(terminal["fact_fingerprint"], candidate["fact_fingerprint"])


if __name__ == "__main__":
    unittest.main()
