from __future__ import annotations

import threading
import time
import unittest
from unittest.mock import patch

from response_cache import TTLResponseCache


class TTLResponseCacheTest(unittest.TestCase):
    def test_hit_expiry_and_refresh(self):
        cache = TTLResponseCache(max_entries=4)
        builds = 0

        def builder():
            nonlocal builds
            builds += 1
            return f"payload-{builds}".encode()

        with patch("response_cache.monotonic") as clock:
            clock.return_value = 10.0
            first = cache.get_or_build("home", 5, builder)
            self.assertEqual(first.status, "MISS")
            self.assertEqual(first.value, b"payload-1")
            self.assertEqual(first.build_ms, 0)

            clock.return_value = 12.0
            second = cache.get_or_build("home", 5, builder)
            self.assertEqual(second.status, "HIT")
            self.assertEqual(second.age_seconds, 2)
            self.assertEqual(second.build_ms, 0)
            self.assertEqual(builds, 1)

            clock.return_value = 16.0
            expired = cache.get_or_build("home", 5, builder)
            self.assertEqual(expired.status, "MISS")
            self.assertEqual(expired.value, b"payload-2")

            clock.return_value = 17.0
            refreshed = cache.get_or_build("home", 5, builder, refresh=True)
            self.assertEqual(refreshed.status, "REFRESH")
            self.assertEqual(refreshed.value, b"payload-3")
            self.assertEqual(builds, 3)

    def test_reports_cold_build_duration(self):
        cache = TTLResponseCache(max_entries=4)
        with patch(
            "response_cache.monotonic",
            side_effect=[10.0, 10.0, 10.0, 10.123, 10.123],
        ):
            result = cache.get_or_build("sales", 60, lambda: b"payload")
        self.assertEqual(result.status, "MISS")
        self.assertEqual(result.build_ms, 123)

    def test_concurrent_misses_build_once(self):
        cache = TTLResponseCache(max_entries=4)
        build_count = 0
        count_lock = threading.Lock()
        start = threading.Barrier(5)
        results = []

        def builder():
            nonlocal build_count
            with count_lock:
                build_count += 1
            time.sleep(0.05)
            return b"shared"

        def worker():
            start.wait()
            results.append(cache.get_or_build("sales", 60, builder))

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for thread in threads:
            thread.start()
        start.wait()
        for thread in threads:
            thread.join(timeout=2)

        self.assertEqual(build_count, 1)
        self.assertEqual(len(results), 4)
        self.assertEqual(sum(result.status == "MISS" for result in results), 1)
        self.assertEqual(sum(result.status == "HIT" for result in results), 3)
        self.assertTrue(all(result.value == b"shared" for result in results))
        self.assertTrue(all(result.build_ms >= 0 for result in results))


if __name__ == "__main__":
    unittest.main()
