#!/usr/bin/env python3
"""Production smoke test for monetary-basis contracts.

This deliberately tests semantics the browser screenshot QA cannot infer. It fails
when an operating endpoint loses its explicit basis metadata or reintroduces a
mixed proceeds/shopper-spend order path.
"""
from __future__ import annotations

import json
import sys
from urllib.parse import quote
from urllib.request import urlopen

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8088").rstrip("/")


def get(path: str) -> dict:
    with urlopen(f"{BASE}{path}", timeout=20) as response:  # noqa: S310 - fixed operator-provided host
        return json.load(response)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def require_basis(rows: list[dict], expected: str, label: str) -> None:
    bad = [row for row in rows if row.get("sales_basis") != expected]
    require(not bad, f"{label}: {len(bad)} rows missing {expected} sales_basis")


def main() -> None:
    today = get("/api/today")
    require(
        today.get("metric_basis", {}).get("operating_sales", {}).get("id") == "GROSS_CUSTOMER_SPEND",
        "Today must declare GROSS_CUSTOMER_SPEND",
    )
    require(today.get("today", {}).get("sales_basis") == "GROSS_CUSTOMER_SPEND", "Today headline basis mismatch")
    require_basis(today.get("sku_today") or [], "GROSS_CUSTOMER_SPEND", "Today products")
    require_basis(today.get("recent_orders") or [], "GROSS_CUSTOMER_SPEND", "Today orders")
    require_basis(today.get("recent_daily") or [], "GROSS_CUSTOMER_SPEND", "Today rhythm")

    sales = get("/api/sales")
    metric_basis = sales.get("metric_basis", {})
    require(
        metric_basis.get("historical_sales", {}).get("id") == "AMAZON_ORDERED_PRODUCT_SALES",
        "Sales historical basis must be AMAZON_ORDERED_PRODUCT_SALES",
    )
    require(
        metric_basis.get("today_and_orders", {}).get("id") == "GROSS_CUSTOMER_SPEND",
        "Sales live/order basis must be GROSS_CUSTOMER_SPEND",
    )
    require(sales.get("today", {}).get("sales_basis") == "GROSS_CUSTOMER_SPEND", "Sales Today basis mismatch")
    require_basis(sales.get("orders") or [], "GROSS_CUSTOMER_SPEND", "Sales orders")
    require_basis(sales.get("skus") or [], "AMAZON_ORDERED_PRODUCT_SALES", "Sales products")

    # Exercise Product Workspace using a real selling SKU from the Sales payload.
    sku = next((row.get("sku") for row in sales.get("skus") or [] if row.get("sku")), None)
    if sku:
        product = get(f"/api/product?sku={quote(str(sku))}")
        require(
            product.get("metric_basis", {}).get("product_sales", {}).get("id") == "AMAZON_ORDERED_PRODUCT_SALES",
            "Product performance basis must be AMAZON_ORDERED_PRODUCT_SALES",
        )
        require(product.get("performance", {}).get("sales_basis") == "AMAZON_ORDERED_PRODUCT_SALES", "Product KPI basis mismatch")
        require_basis(product.get("recent_orders") or [], "GROSS_CUSTOMER_SPEND", "Product order evidence")

    print(
        "monetary-basis=ok "
        f"today_products={len(today.get('sku_today') or [])} "
        f"today_orders={len(today.get('recent_orders') or [])} "
        f"sales_products={len(sales.get('skus') or [])} "
        f"sales_orders={len(sales.get('orders') or [])}"
    )


if __name__ == "__main__":
    main()
