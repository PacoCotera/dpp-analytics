from __future__ import annotations

from datetime import datetime, timezone


ADS_CONNECTION_STATES = (
    "NOT_CONNECTED",
    "AUTHORIZATION_PENDING",
    "BACKFILL_RUNNING",
    "READY",
    "FAILED",
)


_PRESENTATION = {
    "NOT_CONNECTED": {
        "badge": "Ads not connected",
        "headline": "Amazon Ads is not connected.",
        "detail": "Connect Amazon Ads before paid-support reporting can start. Seller demand, conversion, inventory and COGS remain available.",
        "note": "connection required",
    },
    "AUTHORIZATION_PENDING": {
        "badge": "Ads authorization pending",
        "headline": "Amazon Ads authorization is pending.",
        "detail": "Complete Amazon Ads authorization and advertiser-account discovery before reporting can start. Seller demand, conversion, inventory and COGS remain available.",
        "note": "authorization required",
    },
    "BACKFILL_RUNNING": {
        "badge": "Ads backfill running",
        "headline": "Amazon Ads history is backfilling.",
        "detail": "The connection is active. Paid-support metrics will appear after the initial reporting backfill reaches the current window.",
        "note": "initial history loading",
    },
    "READY": {
        "badge": "Ads ready",
        "headline": "Amazon Ads reporting is ready.",
        "detail": "The connection and initial reporting backfill are complete. Product-level rows appear only when Amazon reports paid activity.",
        "note": "reporting connected",
    },
    "FAILED": {
        "badge": "Ads connection failed",
        "headline": "Amazon Ads reporting needs attention.",
        "detail": "The latest Ads connection or ingestion attempt failed. Paid-support reporting is unavailable until the connection succeeds.",
        "note": "connection attention required",
    },
}


def connection_contract(
    state: str,
    *,
    detail_code: str | None = None,
    updated_at=None,
    report_progress: dict | None = None,
) -> dict:
    normalized = str(state or "").strip().upper()
    if normalized not in ADS_CONNECTION_STATES:
        normalized = "FAILED"
        detail_code = detail_code or "INVALID_RECORDED_STATE"
    result = {
        "state": normalized,
        **_PRESENTATION[normalized],
        "detail_code": detail_code,
        "updated_at": updated_at,
    }
    if report_progress:
        result["report_progress"] = report_progress
    return result


def _report_progress(metadata: dict) -> dict | None:
    if not isinstance(metadata, dict) or not metadata.get("report_id"):
        return None
    allowed = (
        "account_id", "grain", "report_number", "report_total", "report_id", "vendor_status", "start_date",
        "end_date", "report_started_at", "last_polled_at",
    )
    progress = {key: metadata.get(key) for key in allowed}
    try:
        started = datetime.fromisoformat(str(progress["report_started_at"]).replace("Z", "+00:00"))
        progress["elapsed_seconds"] = max(
            0, int((datetime.now(timezone.utc) - started.astimezone(timezone.utc)).total_seconds())
        )
    except (TypeError, ValueError):
        progress["elapsed_seconds"] = None
    return progress


def ads_connection_state(cur) -> dict:
    cur.execute("SELECT to_regclass('ops.integration_state') AS relation")
    if not (cur.fetchone() or {}).get("relation"):
        return connection_contract("NOT_CONNECTED", detail_code="STATE_OWNER_NOT_DEPLOYED")
    cur.execute(
        """
        SELECT state,detail_code,metadata,updated_at
        FROM ops.integration_state
        WHERE integration='amazon_ads'
        """
    )
    row = cur.fetchone() or {}
    if not row:
        return connection_contract("NOT_CONNECTED", detail_code="NO_WORKER_STATE_REPORTED")
    return connection_contract(
        row.get("state"),
        detail_code=row.get("detail_code"),
        updated_at=row.get("updated_at"),
        report_progress=_report_progress(row.get("metadata") or {}),
    )
