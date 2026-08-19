from __future__ import annotations

import json
import os
from datetime import date, datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).parent
INDEX = (ROOT / "static" / "index.html").read_bytes()
MARKETPLACE = os.getenv("SPAPI_MARKETPLACE_ID", "A1AM78C64UM0Y8")


def connect():
    return psycopg.connect(
        host=os.getenv("DB_HOST", "postgres"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.environ["POSTGRES_DB"],
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        row_factory=dict_row,
    )


def clean(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def one(cur, sql, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def all_rows(cur, sql, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def home_payload():
    with connect() as conn, conn.cursor() as cur:
        today = one(cur, "SELECT * FROM mart.today_operating WHERE marketplace_id=%s", (MARKETPLACE,))
        rolling = one(
            cur,
            """
            WITH d AS (
              SELECT max(business_date) d
              FROM mart.business_daily
              WHERE marketplace_id=%s AND reconciled_daily_report
            ), x AS (
              SELECT b.* FROM mart.business_rolling b, d
              WHERE b.marketplace_id=%s AND b.business_date=d.d
            ), p AS (
              SELECT b.sales_t28 prior_t28 FROM mart.business_rolling b, d
              WHERE b.marketplace_id=%s AND b.business_date=d.d-28
            )
            SELECT x.business_date, x.sales_t28, x.sales_t56, x.orders_t28, x.units_t28,
                   CASE WHEN p.prior_t28>0 THEN round(100.0*(x.sales_t28-p.prior_t28)/p.prior_t28,1) END delta28_pct
            FROM x LEFT JOIN p ON true
            """,
            (MARKETPLACE, MARKETPLACE, MARKETPLACE),
        )
        inventory_summary = one(
            cur,
            """
            SELECT
              count(*) FILTER (WHERE action IN ('STOCKOUT','PRODUCE','PLAN'))::int needs_action,
              count(*) FILTER (WHERE action='STOCKOUT')::int stockouts,
              count(*) FILTER (WHERE action='PRODUCE')::int produce,
              count(*) FILTER (WHERE action='PLAN')::int plan
            FROM mart.inventory_attention WHERE marketplace_id=%s
            """,
            (MARKETPLACE,),
        )
        inventory = all_rows(
            cur,
            """
            SELECT a.seller_sku sku, COALESCE(s.title,'') product, a.available, a.inbound,
                   a.units_t28, a.days_cover_with_inbound days_cover, a.action
            FROM mart.inventory_attention a
            LEFT JOIN core.sku s ON s.sku=a.seller_sku
            WHERE a.marketplace_id=%s AND a.action IN ('STOCKOUT','PRODUCE','PLAN')
            ORDER BY CASE a.action WHEN 'STOCKOUT' THEN 0 WHEN 'PRODUCE' THEN 1 ELSE 2 END,
                     a.days_cover_with_inbound NULLS FIRST
            LIMIT 8
            """,
            (MARKETPLACE,),
        )
        movers = all_rows(
            cur,
            """
            SELECT m.seller_sku sku, COALESCE(s.title,'') product, m.sales_t28, m.units_t28,
                   m.delta28_pct, m.state
            FROM mart.catalog_movers_t28 m
            LEFT JOIN core.sku s ON s.sku=m.seller_sku
            WHERE m.marketplace_id=%s AND m.sales_t28>0
            ORDER BY m.sales_t28 DESC
            LIMIT 8
            """,
            (MARKETPLACE,),
        )
        series = all_rows(
            cur,
            """
            SELECT business_date, sales
            FROM mart.business_daily
            WHERE marketplace_id=%s AND business_date>=CURRENT_DATE-89
            ORDER BY business_date
            """,
            (MARKETPLACE,),
        )
        freshness = all_rows(
            cur,
            """
            SELECT job_name, latest_status,
                   extract(epoch from age)::bigint age_seconds
            FROM ops.data_health
            WHERE job_name IN ('orders_v2026','sales_traffic_2024_04_24','finances_v2024','fba_inventory_v1')
            ORDER BY CASE job_name
              WHEN 'orders_v2026' THEN 1 WHEN 'sales_traffic_2024_04_24' THEN 2
              WHEN 'finances_v2024' THEN 3 ELSE 4 END
            """,
        )
        local_clock = one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

    return clean({
        "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "local_time": local_clock.get("local_time"),
        "today": today,
        "rolling": rolling,
        "inventory_summary": inventory_summary,
        "inventory": inventory,
        "movers": movers,
        "series": series,
        "freshness": freshness,
    })


def health_payload():
    """Validate the board's actual data dependencies, not just database reachability."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1")
        cur.fetchone()

        today = one(
            cur,
            "SELECT count(*)::int AS n FROM mart.today_operating WHERE marketplace_id=%s",
            (MARKETPLACE,),
        )
        rolling = one(
            cur,
            "SELECT count(*)::int AS n FROM mart.business_rolling WHERE marketplace_id=%s",
            (MARKETPLACE,),
        )
        sales = one(
            cur,
            "SELECT count(*)::int AS n, max(business_date) AS last_date FROM mart.business_daily WHERE marketplace_id=%s",
            (MARKETPLACE,),
        )
        inventory = one(
            cur,
            "SELECT count(*)::int AS n FROM mart.inventory_attention WHERE marketplace_id=%s",
            (MARKETPLACE,),
        )
        finance = one(
            cur,
            "SELECT count(*)::int AS n, max(posted_date) AS last_posted FROM core.financial_transaction WHERE marketplace_id=%s",
            (MARKETPLACE,),
        )
        freshness = all_rows(
            cur,
            """
            SELECT job_name, latest_status, extract(epoch from age)::bigint age_seconds
            FROM ops.data_health
            WHERE job_name IN ('orders_v2026','sales_traffic_2024_04_24','finances_v2024','fba_inventory_v1')
            """,
        )

    dependency_counts = {
        "today": int(today.get("n") or 0),
        "rolling": int(rolling.get("n") or 0),
        "sales_days": int(sales.get("n") or 0),
        "inventory_rows": int(inventory.get("n") or 0),
        "finance_transactions": int(finance.get("n") or 0),
    }
    missing = [name for name, count in dependency_counts.items() if count <= 0]
    feed_errors = [
        row.get("job_name")
        for row in freshness
        if row.get("latest_status") not in ("success", "running")
    ]
    status = "ok" if not missing and not feed_errors else "degraded"
    return clean({
        "status": status,
        "marketplace": MARKETPLACE,
        "dependencies": dependency_counts,
        "sales_last_date": sales.get("last_date"),
        "finance_last_posted": finance.get("last_posted"),
        "feed_errors": feed_errors,
    })


class Handler(BaseHTTPRequestHandler):
    server_version = "DPPBoard/1"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}")

    def send_bytes(self, status, content_type, body, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            try:
                payload = health_payload()
                status = 200 if payload.get("status") == "ok" else 503
                body = json.dumps(payload, separators=(",", ":")).encode()
                self.send_bytes(status, "application/json", body)
            except Exception as exc:
                body = json.dumps({"status": "error", "error": str(exc)[:160]}).encode()
                self.send_bytes(503, "application/json", body)
            return
        if self.path.startswith("/api/home"):
            try:
                body = json.dumps(home_payload(), separators=(",", ":")).encode()
                self.send_bytes(200, "application/json", body)
            except Exception as exc:
                body = json.dumps({"error": str(exc)[:500]}).encode()
                self.send_bytes(500, "application/json", body)
            return
        if self.path == "/" or self.path.startswith("/?"):
            self.send_bytes(200, "text/html; charset=utf-8", INDEX, cache="no-cache")
            return
        self.send_bytes(404, "text/plain; charset=utf-8", b"Not found")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
