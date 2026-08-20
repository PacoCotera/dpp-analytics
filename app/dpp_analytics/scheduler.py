from __future__ import annotations

import logging
import signal
import time
from collections.abc import Callable

from . import db
from .amazon_ads import ingest_ads, probe_ads
from .catalog import ingest_catalog
from .data_kiosk import ingest_sales_traffic
from .finance_close import close_ready_months
from .finances import ingest_finances
from .inventory import ingest_inventory
from .listings_report import ingest_listings_report
from .orders import ingest_orders
from .product_roles_probe import probe as product_roles_probe
from .production_probe import probe as production_probe
from .sandbox_probe import probe as sandbox_probe
from .settlement_reports import ingest_settlement_reports
from .settings import settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("dpp.scheduler")

STOP = False
FINANCE_CLOSE_INTERVAL_SECONDS = 3600


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


def _probe_product_roles() -> tuple[bool, dict]:
    started = time.monotonic()
    try:
        result = product_roles_probe()
        listing_ok = (result.get("product_listing") or {}).get("status") == "ok"
        log.info("job=product_roles_probe status=success result=%s elapsed=%.2fs", result, time.monotonic() - started)
        return listing_ok, result
    except Exception:
        log.exception("job=product_roles_probe status=error elapsed=%.2fs", time.monotonic() - started)
        return False, {}


def _probe_loop(name: str, fn: Callable[[], dict], interval: int) -> None:
    next_probe = 0.0
    while not STOP:
        now = time.monotonic()
        if now >= next_probe:
            _run(name, fn)
            next_probe = time.monotonic() + interval
        time.sleep(settings.scheduler_tick_seconds)


def _next_due(source: str, job_name: str, interval: int) -> float:
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
        "DPP analytics worker starting environment=%s marketplace=%s spapi_enabled=%s credentials_present=%s production_ingestion_enabled=%s catalog_enabled=%s ads_enabled=%s ads_credentials_present=%s",
        settings.spapi_environment,
        settings.marketplace_id,
        settings.spapi_enabled,
        settings.spapi_credentials_present,
        settings.production_ingestion_enabled,
        settings.catalog_enabled,
        settings.ads_enabled,
        settings.ads_credentials_present,
    )

    try:
        interrupted = db.mark_interrupted_runs()
        if interrupted:
            log.info("closed_interrupted_ingestion_runs=%s", interrupted)
    except Exception:
        log.exception("failed to close interrupted ingestion runs")

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

    if settings.ads_enabled:
        if settings.ads_credentials_present:
            _run("amazon_ads_probe", probe_ads)
        else:
            log.warning("Amazon Ads enabled but credentials are incomplete; Ads ingestion will remain idle")
    else:
        log.info("Amazon Ads ingestion disabled")

    next_listings_report = _next_due("amazon_reports", "merchant_listings_all_data", settings.listings_report_interval_seconds)
    next_settlements = _next_due("amazon_reports", "settlement_reports_v2", settings.settlement_reports_interval_seconds)

    catalog_role_ready = False
    if settings.catalog_enabled:
        catalog_role_ready, product_roles = _probe_product_roles()
        if not catalog_role_ready:
            pricing_ok = (product_roles.get("pricing") or {}).get("status") == "ok"
            log.warning("Catalog Items enrichment paused: Product Listing is not authorized yet; pricing_authorized=%s", pricing_ok)
    else:
        log.info("Catalog Items enrichment disabled")

    next_orders = 0.0
    next_inventory = _next_due("amazon_spapi", "fba_inventory_v1", settings.inventory_interval_seconds)
    next_finances = _next_due("amazon_spapi", "finances_v2024", settings.finances_interval_seconds)
    next_finance_close = _next_due("dpp_finance", "month_close", FINANCE_CLOSE_INTERVAL_SECONDS)
    next_catalog = _next_due("amazon_spapi", "catalog_items_2022_04_01", settings.catalog_interval_seconds) if settings.catalog_enabled and catalog_role_ready else float("inf")
    next_product_roles_probe = time.monotonic() + settings.production_probe_interval_seconds if settings.catalog_enabled else float("inf")
    next_data_kiosk = _next_due("amazon_data_kiosk", "sales_traffic_2024_04_24", settings.data_kiosk_interval_seconds)
    next_ads = _next_due("amazon_ads", "sponsored_products_reporting_v3", settings.ads_reporting_interval_seconds) if settings.ads_enabled and settings.ads_credentials_present else float("inf")

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
            next_finance_close = min(next_finance_close, time.monotonic())

        if now >= next_settlements:
            _run("settlement_reports", ingest_settlement_reports)
            next_settlements = time.monotonic() + settings.settlement_reports_interval_seconds

        if now >= next_finance_close:
            _run("finance_month_close", close_ready_months)
            next_finance_close = time.monotonic() + FINANCE_CLOSE_INTERVAL_SECONDS

        if now >= next_listings_report:
            _run("seller_listings_report", ingest_listings_report)
            next_listings_report = time.monotonic() + settings.listings_report_interval_seconds

        if now >= next_product_roles_probe:
            was_ready = catalog_role_ready
            catalog_role_ready, product_roles = _probe_product_roles()
            if catalog_role_ready and not was_ready:
                log.info("Product Listing authorization is now active; enabling Catalog Items enrichment")
                next_catalog = time.monotonic()
            elif not catalog_role_ready:
                pricing_ok = (product_roles.get("pricing") or {}).get("status") == "ok"
                log.warning("Product Listing still unavailable; Catalog Items enrichment remains paused; pricing_authorized=%s", pricing_ok)
                next_catalog = float("inf")
            next_product_roles_probe = time.monotonic() + settings.production_probe_interval_seconds

        if catalog_role_ready and now >= next_catalog:
            _run("catalog", ingest_catalog)
            next_catalog = time.monotonic() + settings.catalog_interval_seconds

        if now >= next_data_kiosk:
            _run("data_kiosk", ingest_sales_traffic)
            next_data_kiosk = time.monotonic() + settings.data_kiosk_interval_seconds

        if now >= next_ads:
            _run("amazon_ads", ingest_ads)
            next_ads = time.monotonic() + settings.ads_reporting_interval_seconds

        time.sleep(settings.scheduler_tick_seconds)


if __name__ == "__main__":
    main()
