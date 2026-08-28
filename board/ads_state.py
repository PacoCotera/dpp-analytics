from __future__ import annotations


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
) -> dict:
    normalized = str(state or "").strip().upper()
    if normalized not in ADS_CONNECTION_STATES:
        normalized = "FAILED"
        detail_code = detail_code or "INVALID_RECORDED_STATE"
    return {
        "state": normalized,
        **_PRESENTATION[normalized],
        "detail_code": detail_code,
        "updated_at": updated_at,
    }


def ads_connection_state(cur) -> dict:
    cur.execute("SELECT to_regclass('ops.integration_state') AS relation")
    if not (cur.fetchone() or {}).get("relation"):
        return connection_contract("NOT_CONNECTED", detail_code="STATE_OWNER_NOT_DEPLOYED")
    cur.execute(
        """
        SELECT state,detail_code,updated_at
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
    )
