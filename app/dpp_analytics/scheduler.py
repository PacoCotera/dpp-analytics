from __future__ import annotations

import logging
import signal
import threading
import time
from collections.abc import Callable

from . import db
from .amazon_ads import ingest_ads, probe_ads
from .catalog import ingest_catalog
from .data_kiosk import ingest_sales_traffic
from .finance_close_tax_corrected import close_ready_months
from .finances import ingest_finances
from .inventory import ingest_inventory
from .listings_report import ingest_listings_report
from .orders import backfill_order_geography, ingest_orders
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
ORDER_GEOGRAPHY_BACKFILL_INTERVAL_SECONDS = 86400
CATALOG_ONBOARDING_RETRY_SECONDS = 1800
GEOGRAPHY_JOB = "orders_geography_state_v2026"


def _stop(signum: int, frame: object) -> None:
    global STOP
    STOP = True
    log.info("shutdown requested signal=%s", signum)


def _run(name: str, fn: Callable[[], dict]) -> dict | None:
    started = time.monotonic()
    try:
        result = fn()
        log.info(
            "job=%s status=success result=%s elapsed=%.2fs",
            name,
            result,
            time.monotonic() - started,
        )
        return result
    except Exception:
        log.exception("job=%s status=error elapsed=%.2fs", name, time.monotonic() - started)
        return None


def _start_background_job(name: str, fn: Callable[[], dict]) -> threading.Thread:
    """Run a slow optional collector without delaying core ingestion cadence."""
    thread = threading.Thread(
        target=_run,
        args=(name, fn),
        name=f"dpp-{name}",
        daemon=True,
    )
    thread.start()
    return thread


def _refresh_catalog_cache_if_written(result: dict | None, kind: str) -> None:
    if int((result or {}).get("records_written") or 0) <= 0:
        return
    _run(
        f"catalog_{kind}_cache_refresh",
        lambda: db.refresh_catalog_hot_path_cache(kind),
    )


def _probe_product_roles() -> tuple[bool, dict]:
    started = time.monotonic()
    try:
        result = product_roles_probe()
        listing_ok = (result.get("product_listing") or {}).get("status") == "ok"
        log.info(
            "job=product_roles_probe status=success result=%s elapsed=%.2fs",
            result,
            time.monotonic() - started,
        )
        return listing_ok, result
    except Exception:
        log.exception(
            "job=product_roles_probe status=error elapsed=%.2fs",
            time.monotonic() - started,
        )
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
        log.exception(
            "could not read last-success age source=%s job=%s; scheduling immediately",
            source,
            job_name,
        )
        return 0.0
    if age is None or age >= interval:
        return 0.0
    delay = max(0.0, interval - age)
    log.info("job=%s startup_deferred=%.0fs last_success_age=%.0fs", job_name, delay, age)
    return time.monotonic() + delay


def _catalog_metadata_backfill_needed() -> bool:
    """Return whether active seller offers with ASINs still need Catalog convergence.

    Listings is authoritative for seller SKU discovery and runs more frequently
    than Catalog Items. A new SKU can therefore exist before Amazon exposes its
    complete Catalog record. Only states Catalog can actually improve are
    considered here; AWAITING_ASIN waits for the next listings snapshot.
    """
    try:
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                SELECT count(*)::int AS unresolved
                FROM mart.catalog_onboarding_state
                WHERE marketplace_id=%s
                  AND asin IS NOT NULL
                  AND catalog_enriched_at IS NULL
                  AND (
                    source_state IN ('AWAITING_CATALOG','CATALOG_PROPAGATING')
                    OR (catalog_last_attempt_at IS NULL AND age_seconds < 172800)
                  )
                """,
                (settings.marketplace_id,),
            )
            unresolved = int((cur.fetchone() or {}).get("unresolved") or 0)
        if unresolved:
            log.info("Catalog onboarding enrichment pending offers=%s", unresolved)
        return unresolved > 0
    except Exception:
        log.exception("could not inspect Catalog onboarding state; using normal schedule")
        return False


def _claim_manual_sync() -> dict | None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            WITH candidate AS (
                SELECT id FROM ops.manual_sync_request
                WHERE status='pending'
                ORDER BY requested_at
                FOR UPDATE SKIP LOCKED LIMIT 1
            )
            UPDATE ops.manual_sync_request request
            SET status='running', started_at=now()
            FROM candidate
            WHERE request.id=candidate.id
            RETURNING request.id,request.job_name
            """
        )
        request = cur.fetchone()
        conn.commit()
        return request


def _finish_manual_sync(request_id: int, success: bool) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ops.manual_sync_request
            SET status=%s,finished_at=now(),error_message=%s
            WHERE id=%s
            """,
            ("success" if success else "error", None if success else "Collector failed; see ingestion run", request_id),
        )
        conn.commit()


def _run_manual_sync() -> str | None:
    request = _claim_manual_sync()
    if not request:
        return None
    jobs: dict[str, Callable[[], dict]] = {
        "orders_v2026": ingest_orders,
        "fba_inventory_v1": ingest_inventory,
        "finances_v2024": ingest_finances,
        "settlement_reports_v2": ingest_settlement_reports,
        "sales_traffic_2024_04_24": ingest_sales_traffic,
        "merchant_listings_all_data": ingest_listings_report,
        "catalog_items_2022_04_01": ingest_catalog,
        GEOGRAPHY_JOB: backfill_order_geography,
        "month_close": close_ready_months,
    }
    job_name = request["job_name"]
    result = _run(f"manual_{job_name}", jobs[job_name])
    _finish_manual_sync(request["id"], result is not None)
    return job_name


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

    # Amazon Ads is an independent authorization surface. Always publish its
    # current connection state, even when SP-API ingestion itself is disabled.
    _run("amazon_ads_probe", probe_ads)

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
        log.info(
            "SP-API production credentials active; ingestion kill-switch is OFF, running read-only authorization probes only"
        )
        _probe_loop("production_probe", production_probe, settings.production_probe_interval_seconds)
        return

    log.info("SP-API production ingestion ENABLED")

    if settings.ads_enabled and not settings.ads_credentials_present:
        log.warning("Amazon Ads enabled but credentials are incomplete; Ads ingestion will remain idle")
    elif not settings.ads_enabled:
        log.info("Amazon Ads ingestion disabled")

    next_listings_report = _next_due(
        "amazon_reports",
        "merchant_listings_all_data",
        settings.listings_report_interval_seconds,
    )
    next_settlements = _next_due(
        "amazon_reports",
        "settlement_reports_v2",
        settings.settlement_reports_interval_seconds,
    )
    next_geography = _next_due(
        "amazon_spapi",
        GEOGRAPHY_JOB,
        ORDER_GEOGRAPHY_BACKFILL_INTERVAL_SECONDS,
    )

    catalog_role_ready = False
    if settings.catalog_enabled:
        catalog_role_ready, product_roles = _probe_product_roles()
        if not catalog_role_ready:
            pricing_ok = (product_roles.get("pricing") or {}).get("status") == "ok"
            log.warning(
                "Catalog Items enrichment paused: Product Listing is not authorized yet; pricing_authorized=%s",
                pricing_ok,
            )
    else:
        log.info("Catalog Items enrichment disabled")

    next_orders = 0.0
    next_inventory = _next_due(
        "amazon_spapi", "fba_inventory_v1", settings.inventory_interval_seconds
    )
    next_finances = _next_due(
        "amazon_spapi", "finances_v2024", settings.finances_interval_seconds
    )
    next_finance_close = _next_due("dpp_finance", "month_close", FINANCE_CLOSE_INTERVAL_SECONDS)
    if settings.catalog_enabled and catalog_role_ready:
        next_catalog = (
            0.0
            if _catalog_metadata_backfill_needed()
            else _next_due(
                "amazon_spapi",
                "catalog_items_2022_04_01",
                settings.catalog_interval_seconds,
            )
        )
    else:
        next_catalog = float("inf")
    next_product_roles_probe = (
        time.monotonic() + settings.production_probe_interval_seconds
        if settings.catalog_enabled
        else float("inf")
    )
    next_data_kiosk = _next_due(
        "amazon_data_kiosk",
        "sales_traffic_2024_04_24",
        settings.data_kiosk_interval_seconds,
    )
    next_ads = (
        _next_due(
            "amazon_ads",
            "sponsored_products_reporting_v3",
            settings.ads_reporting_interval_seconds,
        )
        if settings.ads_enabled and settings.ads_credentials_present
        else float("inf")
    )
    ads_thread: threading.Thread | None = None

    while not STOP:
        now = time.monotonic()

        if ads_thread is not None and not ads_thread.is_alive():
            ads_thread = None
            next_ads = time.monotonic() + settings.ads_reporting_interval_seconds

        manual_job = _run_manual_sync()
        if manual_job:
            now = time.monotonic()
            if manual_job == "orders_v2026": next_orders = now + settings.orders_interval_seconds
            elif manual_job == "fba_inventory_v1": next_inventory = now + settings.inventory_interval_seconds
            elif manual_job == "finances_v2024": next_finances = now + settings.finances_interval_seconds
            elif manual_job == "settlement_reports_v2": next_settlements = now + settings.settlement_reports_interval_seconds
            elif manual_job == "sales_traffic_2024_04_24": next_data_kiosk = now + settings.data_kiosk_interval_seconds
            elif manual_job == "merchant_listings_all_data": next_listings_report = now + settings.listings_report_interval_seconds
            elif manual_job == "catalog_items_2022_04_01": next_catalog = now + settings.catalog_interval_seconds
            elif manual_job == GEOGRAPHY_JOB: next_geography = now + ORDER_GEOGRAPHY_BACKFILL_INTERVAL_SECONDS
            elif manual_job == "month_close": next_finance_close = now + FINANCE_CLOSE_INTERVAL_SECONDS

        if now >= next_orders:
            order_result = _run("orders", ingest_orders)
            _refresh_catalog_cache_if_written(order_result, "sku_activity")
            next_orders = time.monotonic() + settings.orders_interval_seconds

        if now >= next_geography:
            _run("order_geography_backfill", backfill_order_geography)
            next_geography = time.monotonic() + ORDER_GEOGRAPHY_BACKFILL_INTERVAL_SECONDS

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
            if catalog_role_ready and _catalog_metadata_backfill_needed():
                log.info(
                    "Seller listings exposed unresolved Catalog onboarding; pulling Catalog run forward"
                )
                next_catalog = min(next_catalog, time.monotonic())

        if now >= next_product_roles_probe:
            was_ready = catalog_role_ready
            catalog_role_ready, product_roles = _probe_product_roles()
            if catalog_role_ready and not was_ready:
                log.info("Product Listing authorization is now active; enabling Catalog Items enrichment")
                next_catalog = time.monotonic()
            elif not catalog_role_ready:
                pricing_ok = (product_roles.get("pricing") or {}).get("status") == "ok"
                log.warning(
                    "Product Listing still unavailable; Catalog Items enrichment remains paused; pricing_authorized=%s",
                    pricing_ok,
                )
                next_catalog = float("inf")
            next_product_roles_probe = time.monotonic() + settings.production_probe_interval_seconds

        if catalog_role_ready and now >= next_catalog:
            _run("catalog", ingest_catalog)
            if _catalog_metadata_backfill_needed():
                next_catalog = time.monotonic() + CATALOG_ONBOARDING_RETRY_SECONDS
                log.info(
                    "Catalog onboarding still unresolved; retrying in %ss",
                    CATALOG_ONBOARDING_RETRY_SECONDS,
                )
            else:
                next_catalog = time.monotonic() + settings.catalog_interval_seconds

        if now >= next_data_kiosk:
            data_kiosk_result = _run("data_kiosk", ingest_sales_traffic)
            _refresh_catalog_cache_if_written(data_kiosk_result, "traffic")
            next_data_kiosk = time.monotonic() + settings.data_kiosk_interval_seconds

        if now >= next_ads and ads_thread is None:
            ads_thread = _start_background_job("amazon_ads", ingest_ads)
            next_ads = float("inf")

        time.sleep(settings.scheduler_tick_seconds)


if __name__ == "__main__":
    main()
