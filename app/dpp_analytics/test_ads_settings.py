from __future__ import annotations

import os
import subprocess
import sys
import unittest


class AmazonAdsSettingsTests(unittest.TestCase):
    def _read_timeout(self, value: str | None) -> int:
        env = os.environ.copy()
        if value is None:
            env.pop("AMAZON_ADS_REPORT_POLL_TIMEOUT_SECONDS", None)
        else:
            env["AMAZON_ADS_REPORT_POLL_TIMEOUT_SECONDS"] = value

        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "from dpp_analytics.settings import settings; "
                "print(settings.ads_report_poll_timeout_seconds)",
            ],
            check=True,
            capture_output=True,
            env=env,
            text=True,
        )
        return int(result.stdout.strip())

    def test_ads_report_timeout_defaults_to_fifteen_minutes(self) -> None:
        self.assertEqual(self._read_timeout(None), 900)

    def test_ads_report_timeout_remains_operator_configurable(self) -> None:
        self.assertEqual(self._read_timeout("1200"), 1200)


if __name__ == "__main__":
    unittest.main()
