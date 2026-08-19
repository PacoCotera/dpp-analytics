from __future__ import annotations

import json
import os
from datetime import date, datetime
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from catalog_api import catalog_payload as build_catalog_payload
from health_api import health_board_payload as build_health_board_payload
from inventory_api import inventory_payload as build_inventory_payload
from sales_api import sales_payload as build_sales_payload
from today_api import today_payload as build_today_payload
from trajectory_api import trajectory_payload as build_trajectory_payload

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
LABELS_PATH = ROOT / "product_labels.json"
HOME_INDEX = (STATIC / "home.html").read_bytes()
TODAY_INDEX = (STATIC / "today.html").read_bytes()
SALES_INDEX = (STATIC / "sales.html").read_bytes()
CATALOG_INDEX = (STATIC / "catalog.html").read_bytes()
INVENTORY_INDEX = (STATIC / "inventory.html").read_bytes()
TRAJECTORY_INDEX = (STATIC / "trajectory.html").read_bytes()
DATA_HEALTH_INDEX = (STATIC / "data_health.html").read_bytes()
THEME_CSS = (STATIC / "theme.css").read_bytes()
MARKETPLACE = os.getenv("SPAPI_MARKETPLACE_ID", "A1AM78C64UM0Y8")
AMAZON_MX_DP = "https://www.amazon.com.mx/dp/"


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


def product_labels() -> dict[str, dict]:
    try:
        data = json.loads(LABELS_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return {
        str(sku): value
        for sku, value in data.items()
        if not str(sku).startswith("_") and isinstance(value, dict)
    }


def decorate_products(rows: list[dict]) -> list[dict]:
    labels = product_labels()
    for row in rows:
        sku = str(row.get("sku") or "")
        override = labels.get(sku, {})
        raw_title = row.get("product") or sku
        asin = row.get("asin")
        row["catalog_title"] = raw_title
        row["product"] = override.get("name") or raw_title
        row["amazon_url"] = override.get("amazon_url") or (f"{AMAZON_MX_DP}{asin}" if asin else None)
        row["image_url"] = override.get("image_url") or row.get("image_url")
        row["label_source"] = "override" if override.get("name") else "catalog"
    return rows


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
            SELECT a.seller_sku sku, s.asin,
                   COALESCE(sl.item_name,ci.title,s.title,'') product,
                   COALESCE(sl.image_url,ci.image_url) image_url,
                   a.available, a.inbound, a.units_t28,
                   a.days_cover_with_inbound days_cover, a.action
            FROM mart.inventory_attention a
            LEFT JOIN core.sku s ON s.sku=a.seller_sku
            LEFT JOIN core.seller_listing sl
              ON sl.marketplace_id=a.marketplace_id AND sl.seller_sku=a.seller_sku
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=a.marketplace_id AND ci.asin=s.asin
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
            SELECT m.seller_sku sku, s.asin,
                   COALESCE(sl.item_name,ci.title,s.title,'') product,
                   COALESCE(sl.image_url,ci.image_url) image_url,
                   m.sales_t28, m.units_t28, m.delta28_pct, m.state
            FROM mart.catalog_movers_t28 m
            LEFT JOIN core.sku s ON s.sku=m.seller_sku
            LEFT JOIN core.seller_listing sl
              ON sl.marketplace_id=m.marketplace_id AND sl.seller_sku=m.seller_sku
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=m.marketplace_id AND ci.asin=s.asin
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
            WHERE job_name IN (
              'orders_v2026','sales_traffic_2024_04_24','finances_v2024',
              'fba_inventory_v1','merchant_listings_all_data','catalog_items_2022_04_01'
            )
            ORDER BY CASE job_name
              WHEN 'orders_v2026' THEN 1
              WHEN 'sales_traffic_2024_04_24' THEN 2
              WHEN 'finances_v2024' THEN 3
              WHEN 'fba_inventory_v1' THEN 4
              WHEN 'merchant_listings_all_data' THEN 5
              ELSE 6 END
            """,
        )
        local_clock = one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

    return clean({
        "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "local_time": local_clock.get("local_time"),
        "today": today,
        "rolling": rolling,
        "inventory_summary": inventory_summary,
        "inventory": decorate_products(inventory),
        "movers": decorate_products(movers),
        "series": series,
        "freshness": freshness,
    })


def health_payload():
    """Validate the board's actual data dependencies, not just database reachability."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("SELECT 1")
        cur.fetchone()

        today = one(cur, "SELECT count(*)::int AS n FROM mart.today_operating WHERE marketplace_id=%s", (MARKETPLACE,))
        rolling = one(cur, "SELECT count(*)::int AS n FROM mart.business_rolling WHERE marketplace_id=%s", (MARKETPLACE,))
        sales = one(cur, "SELECT count(*)::int AS n, max(business_date) AS last_date FROM mart.business_daily WHERE marketplace_id=%s", (MARKETPLACE,))
        inventory = one(cur, "SELECT count(*)::int AS n FROM mart.inventory_attention WHERE marketplace_id=%s", (MARKETPLACE,))
        finance = one(cur, "SELECT count(*)::int AS n, max(posted_date) AS last_posted FROM core.financial_transaction WHERE marketplace_id=%s", (MARKETPLACE,))
        catalog = one(cur, "SELECT count(*)::int AS n, max(updated_at) AS last_updated FROM core.catalog_item WHERE marketplace_id=%s", (MARKETPLACE,))
        listings = one(cur, "SELECT count(*)::int AS n, max(fetched_at) AS last_updated FROM core.seller_listing WHERE marketplace_id=%s", (MARKETPLACE,))
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
    feed_errors = [row.get("job_name") for row in freshness if row.get("latest_status") not in ("success", "running")]
    status = "ok" if not missing and not feed_errors else "degraded"
    return clean({
        "status": status,
        "marketplace": MARKETPLACE,
        "dependencies": dependency_counts,
        "seller_listings": int(listings.get("n") or 0),
        "seller_listings_last_updated": listings.get("last_updated"),
        "catalog_items": int(catalog.get("n") or 0),
        "catalog_last_updated": catalog.get("last_updated"),
        "sales_last_date": sales.get("last_date"),
        "finance_last_posted": finance.get("last_posted"),
        "feed_errors": feed_errors,
    })


class Handler(BaseHTTPRequestHandler):
    server_version = "DPPBoard/5"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}")

    def send_bytes(self, status, content_type, body, cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def json_endpoint(self, builder):
        try:
            payload = clean(builder())
            body = json.dumps(payload, separators=(",", ":")).encode()
            self.send_bytes(200, "application/json", body)
        except Exception as exc:
            body = json.dumps({"error": str(exc)[:500]}).encode()
            self.send_bytes(500, "application/json", body)

    def do_GET(self):
        if self.path == "/assets/theme.css":
            self.send_bytes(200, "text/css; charset=utf-8", THEME_CSS, cache="public, max-age=60")
            return
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
        if self.path.startswith("/api/today"):
            self.json_endpoint(lambda: build_today_payload(connect, decorate_products, MARKETPLACE))
            return
        if self.path.startswith("/api/home"):
            self.json_endpoint(home_payload)
            return
        if self.path.startswith("/api/sales"):
            self.json_endpoint(lambda: build_sales_payload(connect, decorate_products, MARKETPLACE))
            return
        if self.path.startswith("/api/catalog"):
            self.json_endpoint(lambda: build_catalog_payload(connect, decorate_products, MARKETPLACE))
            return
        if self.path.startswith("/api/inventory"):
            self.json_endpoint(lambda: build_inventory_payload(connect, decorate_products, MARKETPLACE))
            return
        if self.path.startswith("/api/trajectory"):
            self.json_endpoint(lambda: build_trajectory_payload(connect, MARKETPLACE))
            return
        if self.path.startswith("/api/data-health"):
            self.json_endpoint(lambda: build_health_board_payload(connect, MARKETPLACE))
            return
        if self.path == "/today" or self.path.startswith("/today?"):
            self.send_bytes(200, "text/html; charset=utf-8", TODAY_INDEX, cache="no-cache")
            return
        if self.path == "/sales" or self.path.startswith("/sales?"):
            self.send_bytes(200, "text/html; charset=utf-8", SALES_INDEX, cache="no-cache")
            return
        if self.path == "/catalog" or self.path.startswith("/catalog?"):
            self.send_bytes(200, "text/html; charset=utf-8", CATALOG_INDEX, cache="no-cache")
            return
        if self.path == "/inventory" or self.path.startswith("/inventory?"):
            self.send_bytes(200, "text/html; charset=utf-8", INVENTORY_INDEX, cache="no-cache")
            return
        if self.path == "/trajectory" or self.path.startswith("/trajectory?"):
            self.send_bytes(200, "text/html; charset=utf-8", TRAJECTORY_INDEX, cache="no-cache")
            return
        if self.path == "/data-health" or self.path.startswith("/data-health?"):
            self.send_bytes(200, "text/html; charset=utf-8", DATA_HEALTH_INDEX, cache="no-cache")
            return
        if self.path == "/" or self.path.startswith("/?"):
            self.send_bytes(200, "text/html; charset=utf-8", HOME_INDEX, cache="no-cache")
            return
        self.send_bytes(404, "text/plain; charset=utf-8", b"Not found")


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
