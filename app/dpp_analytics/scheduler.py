from __future__ import annotations

import logging
import signal
import time
from collections.abc import Callable

from . import db
from .data_kiosk import ingest_sales_traffic
from .finances import ingest_finances
from .inventory import ingest_inventory
from .orders import ingest_orders
from .production_probe import probe as production_probe
from .sandbox_probe import probe as sandbox_probe
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


def _run(name: str, fn: Callable[[], dict]) -> None:
    started = time.monotonic()
    try:
        result = fn()
        log.info("job=%s status=success result=%s elapsed=%.2fs", name, result, time.monotonic() - started)
    except Exception:
        log.exception("job=%s status=error elapsed=%.2fs", name, time.monotonic() - started)


def _probe_loop(name: str, fn: Callable[[], dict], interval: int) -> None:
    next_probe = 0.0
    while not STOP:
        now = time.monotonic()
        if now >= next_probe:
            _run(name, fn)
            next_probe = time.monotonic() + interval
        time.sleep(settings.scheduler_tick_seconds)


def _next_due(source: str, job_name: str, interval: int) -> float:
    """Keep durable job cadence across container restarts and frequent deploys."""
    try:
        age = db.seconds_since_last_success(source, job_name)
    except Exception:
        log.exception("could not read last-success age source=%s job=%s; scheduling immediately", source, job_name)
        return 0.0
    if age is None or age >= interval:
        return 0.0
    delay = max(0.0, interval - age)
    log.info("job=%s startup_deferred=%.0fs last_success_age=%.0fs", job_name, delay, age)
    return time.monotonic() + delay


def main() -> None:
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    log.info(
        "DPP analytics worker starting environment=%s marketplace=%s spapi_enabled=%s credentials_present=%s production_ingestion_enabled=%s",
        settings.spapi_environment,
        settings.marketplace_id,
        settings.spapi_enabled,
        settings.spapi_credentials_present,
        settings.production_ingestion_enabled,
    )

    if not settings.spapi_enabled:
        log.info("SP-API ingestion is disabled")
        while not STOP:
            time.sleep(settings.scheduler_tick_seconds)
        return

    if settings.is_sandbox:
        log.info("SP-API sandbox mode active; production ingestion is blocked")
        _probe_loop("sandbox_probe", sandbox_probe, settings.sandbox_probe_interval_seconds)
        return

    if not settings.is_production:
        log.error("Unknown SPAPI_ENVIRONMENT=%s; refusing all SP-API activity", settings.spapi_environment)
        while not STOP:
            time.sleep(settings.scheduler_tick_seconds)
        return

    if not settings.production_ingestion_enabled:
        log.info("SP-API production credentials active; ingestion kill-switch is OFF, running read-only authorization probes only")
        _probe_loop("production_probe", production_probe, settings.production_probe_interval_seconds)
        return

    log.info("SP-API production ingestion ENABLED")

    # Orders remain eager on startup because they are our near-real-time feed.
    # The slower collectors respect their persisted last-success time so a deploy
    # does not create duplicate work or burst Amazon's rate limits.
    next_orders = 0.0
    next_inventory = _next_due("amazon_spapi", "fba_inventory_v1", settings.inventory_interval_seconds)
    next_finances = _next_due("amazon_spapi", "finances_v2024", settings.finances_interval_seconds)
    next_data_kiosk = _next_due(
        "amazon_data_kiosk",
        "sales_traffic_2024_04_24",
        settings.data_kiosk_interval_seconds,
    )

    while not STOP:
        now = time.monotonic()

        if now >= next_orders:
            _run("orders", ingest_orders)
            next_orders = time.monotonic() + settings.orders_interval_seconds

        if now >= next_inventory:
            _run("inventory", ingest_inventory)
            next_inventory = time.monotonic() + settings.inventory_interval_seconds

        if now >= next_finances:
            _run("finances", ingest_finances)
            next_finances = time.monotonic() + settings.finances_interval_seconds

        if now >= next_data_kiosk:
            _run("data_kiosk", ingest_sales_traffic)
            next_data_kiosk = time.monotonic() + settings.data_kiosk_interval_seconds

        time.sleep(settings.scheduler_tick_seconds)


if __name__ == "__main__":
    main()
