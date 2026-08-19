from __future__ import annotations

import logging
import signal
import time
from collections.abc import Callable

from .inventory import ingest_inventory
from .orders import ingest_orders
from .settings import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("dpp.scheduler")

STOP = False


def _stop(signum: int, frame: object) -> None:
    global STOP
    STOP = True
    log.info("shutdown requested signal=%s", signum)


def _run(name: str, fn: Callable[[], dict[str, int]]) -> None:
    started = time.monotonic()
    try:
        result = fn()
        log.info("job=%s status=success result=%s elapsed=%.2fs", name, result, time.monotonic() - started)
    except Exception:
        log.exception("job=%s status=error elapsed=%.2fs", name, time.monotonic() - started)


def main() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log.info(
        "DPP analytics worker starting marketplace=%s spapi_enabled=%s credentials_present=%s",
        settings.marketplace_id,
        settings.spapi_enabled,
        settings.spapi_credentials_present,
    )

    if not settings.spapi_enabled:
        log.info("SP-API ingestion is disabled until credentials are installed on the host")
        while not STOP:
            time.sleep(settings.scheduler_tick_seconds)
        return

    next_orders = 0.0
    next_inventory = 0.0

    while not STOP:
        now = time.monotonic()

        if now >= next_orders:
            _run("orders", ingest_orders)
            next_orders = time.monotonic() + settings.orders_interval_seconds

        if now >= next_inventory:
            _run("inventory", ingest_inventory)
            next_inventory = time.monotonic() + settings.inventory_interval_seconds

        time.sleep(settings.scheduler_tick_seconds)


if __name__ == "__main__":
    main()
