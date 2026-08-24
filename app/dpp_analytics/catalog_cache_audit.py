from __future__ import annotations

import json
import time
from typing import Any

from . import db


TRAFFIC_COLUMNS = """
marketplace_id, asin, parent_asin, through_date,
sales_t28, units_t28, orders_t28, sessions_t28, page_views_t28,
sales_prior_t28, units_prior_t28, sessions_prior_t28
"""

TRAFFIC_LIVE = """
WITH cutoff AS (
    SELECT marketplace_id, max(business_date) AS through_date
    FROM core.asin_sales_traffic_daily
    GROUP BY marketplace_id
)
SELECT
    a.marketplace_id,
    a.asin,
    max(NULLIF(a.parent_asin,'')) AS parent_asin,
    c.through_date,
    COALESCE(sum(a.ordered_product_sales) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::numeric(14,2) AS sales_t28,
    COALESCE(sum(a.units_ordered) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::bigint AS units_t28,
    COALESCE(sum(a.total_order_items) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::bigint AS orders_t28,
    COALESCE(sum(a.sessions) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::bigint AS sessions_t28,
    COALESCE(sum(a.page_views) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 27 AND c.through_date
    ),0)::bigint AS page_views_t28,
    COALESCE(sum(a.ordered_product_sales) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
    ),0)::numeric(14,2) AS sales_prior_t28,
    COALESCE(sum(a.units_ordered) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
    ),0)::bigint AS units_prior_t28,
    COALESCE(sum(a.sessions) FILTER (
        WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date - 28
    ),0)::bigint AS sessions_prior_t28
FROM core.asin_sales_traffic_daily a
JOIN cutoff c USING (marketplace_id)
WHERE a.business_date BETWEEN c.through_date - 55 AND c.through_date
GROUP BY a.marketplace_id, a.asin, c.through_date
"""

SKU_COLUMNS = "marketplace_id, seller_sku, recent_sales, recent_units"
SKU_LIVE = """
SELECT
    marketplace_id,
    seller_sku,
    COALESCE(sum(sales) FILTER (WHERE business_date >= current_date - 55),0)::numeric(14,2) AS recent_sales,
    COALESCE(sum(units) FILTER (WHERE business_date >= current_date - 55),0)::bigint AS recent_units
FROM mart.sku_daily
GROUP BY marketplace_id, seller_sku
"""


def _elapsed_ms(started: float) -> int:
    return round((time.monotonic() - started) * 1000)


def _fetch_timed(cur, sql: str) -> tuple[list[dict[str, Any]], int]:
    started = time.monotonic()
    cur.execute(sql)
    rows = [dict(row) for row in cur.fetchall()]
    return rows, _elapsed_ms(started)


def _mismatch_count(cur, cached_relation: str, columns: str, live_sql: str) -> int:
    cur.execute(
        f"""
        WITH live AS ({live_sql}), differences AS (
            (SELECT {columns} FROM {cached_relation}
             EXCEPT ALL
             SELECT {columns} FROM live)
            UNION ALL
            (SELECT {columns} FROM live
             EXCEPT ALL
             SELECT {columns} FROM {cached_relation})
        )
        SELECT count(*)::int AS mismatch_count FROM differences
        """
    )
    return int((cur.fetchone() or {}).get("mismatch_count") or 0)


def audit() -> dict[str, Any]:
    with db.connect() as conn, conn.cursor() as cur:
        # Refresh and compare under one stable source snapshot. This prevents a
        # concurrent Orders/Data Kiosk write from creating a false parity failure
        # between the materialized relation and its canonical live aggregation.
        cur.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")

        started = time.monotonic()
        cur.execute("REFRESH MATERIALIZED VIEW mart.catalog_traffic_t56_cache")
        traffic_refresh_ms = _elapsed_ms(started)

        started = time.monotonic()
        cur.execute("REFRESH MATERIALIZED VIEW mart.catalog_sku_activity_t56_cache")
        sku_refresh_ms = _elapsed_ms(started)

        traffic_live_rows, traffic_live_ms = _fetch_timed(cur, TRAFFIC_LIVE)
        traffic_cache_rows, traffic_cache_ms = _fetch_timed(
            cur,
            f"SELECT {TRAFFIC_COLUMNS} FROM mart.catalog_traffic_t56_cache",
        )
        traffic_mismatches = _mismatch_count(
            cur,
            "mart.catalog_traffic_t56_cache",
            TRAFFIC_COLUMNS,
            TRAFFIC_LIVE,
        )

        sku_live_rows, sku_live_ms = _fetch_timed(cur, SKU_LIVE)
        sku_cache_rows, sku_cache_ms = _fetch_timed(
            cur,
            f"SELECT {SKU_COLUMNS} FROM mart.catalog_sku_activity_t56_cache",
        )
        sku_mismatches = _mismatch_count(
            cur,
            "mart.catalog_sku_activity_t56_cache",
            SKU_COLUMNS,
            SKU_LIVE,
        )
        conn.commit()

    result = {
        "ok": traffic_mismatches == 0 and sku_mismatches == 0,
        "traffic": {
            "live_rows": len(traffic_live_rows),
            "cache_rows": len(traffic_cache_rows),
            "mismatches": traffic_mismatches,
            "refresh_ms": traffic_refresh_ms,
            "live_read_ms": traffic_live_ms,
            "cache_read_ms": traffic_cache_ms,
        },
        "sku_activity": {
            "live_rows": len(sku_live_rows),
            "cache_rows": len(sku_cache_rows),
            "mismatches": sku_mismatches,
            "refresh_ms": sku_refresh_ms,
            "live_read_ms": sku_live_ms,
            "cache_read_ms": sku_cache_ms,
        },
    }
    if not result["ok"]:
        raise RuntimeError(json.dumps(result, separators=(",", ":")))
    return result


def main() -> None:
    print(json.dumps(audit(), separators=(",", ":"), default=str))


if __name__ == "__main__":
    main()
