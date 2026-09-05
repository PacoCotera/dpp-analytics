from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest

import ads_shadow_scheduler


class AdvertisingShadowSchedulerTests(unittest.TestCase):
    def test_health_requires_a_recent_success_marker(self):
        with TemporaryDirectory() as directory:
            marker = Path(directory) / "health"
            with patch.object(ads_shadow_scheduler, "HEALTH_PATH", marker):
                self.assertFalse(ads_shadow_scheduler.healthy(now=1_000))
                marker.write_text("900", encoding="utf-8")
                self.assertTrue(ads_shadow_scheduler.healthy(now=1_000))
                marker.write_text(str(1_000 - max(ads_shadow_scheduler.INTERVAL_SECONDS * 2, 900) - 1), encoding="utf-8")
                self.assertFalse(ads_shadow_scheduler.healthy(now=1_000))


if __name__ == "__main__":
    unittest.main()
