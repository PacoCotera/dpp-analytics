from __future__ import annotations

import threading
import unittest

from .scheduler import _start_background_job


class BackgroundSchedulerTests(unittest.TestCase):
    def test_slow_optional_job_does_not_block_scheduler_thread(self) -> None:
        started = threading.Event()
        release = threading.Event()

        def slow_job() -> dict:
            started.set()
            release.wait(timeout=2)
            return {"status": "ok"}

        thread = _start_background_job("test_optional", slow_job)
        try:
            self.assertTrue(thread.daemon)
            self.assertTrue(started.wait(timeout=1))
            self.assertTrue(thread.is_alive())
        finally:
            release.set()
            thread.join(timeout=1)

        self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
