from __future__ import annotations

from datetime import date, timedelta


WINDOW_DAYS = 28

RECONCILED_BUSINESS_T28 = "RECONCILED_BUSINESS_T28"
RECONCILED_PRODUCT_T28 = "RECONCILED_PRODUCT_T28"
INVENTORY_ORDER_VELOCITY_T28 = "INVENTORY_ORDER_VELOCITY_T28"

CONTRACTS = {
    RECONCILED_BUSINESS_T28: {
        "label": "Reconciled seller performance · 28D",
        "source_id": "AMAZON_SALES_TRAFFIC_DATA_KIOSK",
        "source": "Sales & Traffic / Data Kiosk",
        "grain": "marketplace business day",
        "definition": "Reconciled seller sales, orders and units for completed marketplace days.",
    },
    RECONCILED_PRODUCT_T28: {
        "label": "Reconciled product demand · 28D",
        "source_id": "AMAZON_CHILD_ASIN_SALES_TRAFFIC_DATA_KIOSK",
        "source": "CHILD-ASIN Sales & Traffic / Data Kiosk",
        "grain": "child ASIN business day mapped once to its canonical offer owner",
        "definition": "Reconciled product sales, units and traffic for current canonical Amazon offers.",
    },
    INVENTORY_ORDER_VELOCITY_T28: {
        "label": "Order-based inventory velocity · 28D",
        "source_id": "AMAZON_ORDERS_SELLER_SKU",
        "source": "Amazon Orders",
        "grain": "seller SKU by local order date",
        "definition": "Operational units ordered by seller SKU, excluding cancelled orders; used for stock cover decisions.",
    },
}


def _iso(value):
    return value.isoformat() if hasattr(value, "isoformat") else value


def build_metric_window(
    contract_id: str,
    through_date: date | None,
    source_as_of,
    timezone: str,
    *,
    days: int = WINDOW_DAYS,
) -> dict:
    if contract_id not in CONTRACTS:
        raise ValueError(f"Unknown metric-window contract: {contract_id}")
    if days < 1:
        raise ValueError("Metric-window days must be positive")

    start_date = through_date - timedelta(days=days - 1) if through_date else None
    return {
        "id": contract_id,
        **CONTRACTS[contract_id],
        "included_days": days,
        "start_date": start_date,
        "through_date": through_date,
        "source_as_of": source_as_of,
        "timezone": timezone,
    }


def metric_window_fingerprint(window: dict) -> tuple:
    """Stable cross-page identity for an intentionally shared metric window."""
    return (
        window.get("id"),
        window.get("source_id"),
        window.get("grain"),
        int(window.get("included_days") or 0),
        _iso(window.get("start_date")),
        _iso(window.get("through_date")),
        _iso(window.get("source_as_of")),
        window.get("timezone"),
    )


def _one(cur, sql: str, params=()) -> dict:
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _market_timezone(cur, marketplace: str) -> str:
    row = _one(
        cur,
        "SELECT timezone FROM core.marketplace WHERE marketplace_id=%s",
        (marketplace,),
    )
    return row.get("timezone") or "America/Mexico_City"


def _business_window(cur, marketplace: str) -> dict:
    return _one(
        cur,
        """
        WITH cutoff AS (
          SELECT max(business_date) AS through_date
          FROM mart.business_daily
          WHERE marketplace_id=%s AND reconciled_daily_report
        )
        SELECT c.through_date,
               max(s.updated_at) AS source_as_of
        FROM cutoff c
        LEFT JOIN core.sales_traffic_daily s
          ON s.marketplace_id=%s
         AND s.business_date BETWEEN c.through_date-(%s-1) AND c.through_date
        GROUP BY c.through_date
        """,
        (marketplace, marketplace, WINDOW_DAYS),
    )


def _product_window(cur, marketplace: str) -> dict:
    return _one(
        cur,
        """
        WITH cutoff AS (
          SELECT max(through_date) AS through_date
          FROM mart.catalog_traffic_t56_cache
          WHERE marketplace_id=%s
        )
        SELECT c.through_date,
               max(s.updated_at) AS source_as_of
        FROM cutoff c
        LEFT JOIN core.asin_sales_traffic_daily s
          ON s.marketplace_id=%s
         AND s.business_date BETWEEN c.through_date-(%s-1) AND c.through_date
        GROUP BY c.through_date
        """,
        (marketplace, marketplace, WINDOW_DAYS),
    )


def _inventory_window(cur, marketplace: str) -> dict:
    return _one(
        cur,
        """
        WITH cutoff AS (
          SELECT max(business_date) AS through_date
          FROM mart.sku_daily
          WHERE marketplace_id=%s
        )
        SELECT c.through_date,
               max(GREATEST(i.last_seen_at,o.last_seen_at)) AS source_as_of
        FROM cutoff c
        LEFT JOIN core.marketplace mp ON mp.marketplace_id=%s
        LEFT JOIN core.amazon_order o
          ON o.marketplace_id=mp.marketplace_id
         AND (o.created_time AT TIME ZONE mp.timezone)::date
             BETWEEN c.through_date-(%s-1) AND c.through_date
        LEFT JOIN core.amazon_order_item i ON i.amazon_order_id=o.amazon_order_id
        GROUP BY c.through_date
        """,
        (marketplace, marketplace, WINDOW_DAYS),
    )


LOADERS = {
    RECONCILED_BUSINESS_T28: _business_window,
    RECONCILED_PRODUCT_T28: _product_window,
    INVENTORY_ORDER_VELOCITY_T28: _inventory_window,
}


def load_metric_windows(
    cur,
    marketplace: str,
    contract_ids,
    *,
    timezone: str | None = None,
) -> dict[str, dict]:
    timezone = timezone or _market_timezone(cur, marketplace)
    windows = {}
    for contract_id in contract_ids:
        if contract_id not in LOADERS:
            raise ValueError(f"Unknown metric-window contract: {contract_id}")
        evidence = LOADERS[contract_id](cur, marketplace)
        windows[contract_id] = build_metric_window(
            contract_id,
            evidence.get("through_date"),
            evidence.get("source_as_of"),
            timezone,
        )
    return windows
