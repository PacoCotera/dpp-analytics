from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import time

from ads_shadow_replay import connect, replay_ads_shadow_candidates


INTERVAL_SECONDS = max(300, int(os.getenv("ADS_SHADOW_REPLAY_INTERVAL_SECONDS", "1800")))
HEALTH_PATH = Path(os.getenv("ADS_SHADOW_REPLAY_HEALTH_PATH", "/tmp/dpp-ads-shadow-last-success"))
STOP = False


def _stop(*_args) -> None:
    global STOP
    STOP = True


def run_once() -> dict:
    with connect() as conn:
        result = replay_ads_shadow_candidates(conn)
    HEALTH_PATH.write_text(str(time.time()), encoding="utf-8")
    return result


def healthy(*, now: float | None = None) -> bool:
    try:
        succeeded_at = float(HEALTH_PATH.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return False
    age = (now if now is not None else time.time()) - succeeded_at
    return 0 <= age <= max(INTERVAL_SECONDS * 2, 900)


def serve() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    while not STOP:
        started = time.monotonic()
        try:
            print(json.dumps(run_once(), sort_keys=True), flush=True)
            delay = INTERVAL_SECONDS
        except Exception as exc:
            print(
                json.dumps(
                    {"status": "error", "error_type": type(exc).__name__, "message": str(exc)[:500]},
                    sort_keys=True,
                ),
                flush=True,
            )
            delay = min(60, INTERVAL_SECONDS)
        deadline = started + delay
        while not STOP and time.monotonic() < deadline:
            time.sleep(min(5, max(0, deadline - time.monotonic())))


def main() -> None:
    parser = argparse.ArgumentParser(description="Schedule immutable Advertising V2 shadow evaluations")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--health", action="store_true")
    args = parser.parse_args()
    if args.health:
        raise SystemExit(0 if healthy() else 1)
    if args.once:
        print(json.dumps(run_once(), sort_keys=True))
        return
    serve()


if __name__ == "__main__":
    main()
