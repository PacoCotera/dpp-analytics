from __future__ import annotations

from sales_api_legacy import sales_payload as _legacy_sales_payload


def _state(current: float, prior: float) -> str:
    if current > 0 and prior == 0:
        return "NEW"
    if prior > 0 and current >= prior * 1.20:
        return "ACCELERATING"
    if prior > 0 and current >= prior * 1.05:
        return "GROWING"
    if prior > 0 and current <= prior * 0.80:
        return "DECLINING"
    if prior > 0 and current <= prior * 0.95:
        return "COOLING"
    return "STABLE"


def sales_payload(connect, decorate_products, marketplace: str) -> dict:
    payload = _legacy_sales_payload(connect, decorate_products, marketplace)
    cutoff = (payload.get("headline") or {}).get("business_date")

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT currency,timezone,country_code FROM core.marketplace WHERE marketplace_id=%s",
            (marketplace,),
        )
        market = cur.fetchone() or {}

        if cutoff:
            # Historical Sales charts are reconciled Amazon Sales & Traffic only.
            # Do not let an order-derived fallback silently enter a reconciled series.
            cur.execute(
                """
                SELECT business_date,sales,orders,units
                FROM mart.business_daily
                WHERE marketplace_id=%s
                  AND reconciled_daily_report
                  AND business_date BETWEEN %s::date-89 AND %s::date
                ORDER BY business_date
                """,
                (marketplace, cutoff, cutoff),
            )
            payload["series"] = list(cur.fetchall())

            # Keep Product performance on the same reconciled Sales & Traffic basis
            # as the Sales headline rather than the order/proceeds ledger.
            cur.execute(
                """
                WITH c AS (SELECT %s::date AS d), x AS (
                  SELECT seller_sku AS sku,max(asin) AS asin,
                         COALESCE(sum(ordered_product_sales) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::numeric(14,2) AS sales_t28,
                         COALESCE(sum(units_ordered) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS units_t28,
                         COALESCE(sum(ordered_product_sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d-28),0)::numeric(14,2) AS sales_prior_t28
                  FROM core.sku_sales_traffic_daily,c
                  WHERE marketplace_id=%s AND business_date BETWEEN c.d-55 AND c.d
                  GROUP BY seller_sku
                )
                SELECT *,CASE WHEN sales_prior_t28>0 THEN round(100.0*(sales_t28-sales_prior_t28)/sales_prior_t28,1)
                              WHEN sales_t28>0 THEN NULL ELSE 0::numeric END AS delta28_pct
                FROM x ORDER BY sales_t28 DESC LIMIT 20
                """,
                (cutoff, marketplace),
            )
            product_values = {r["sku"]: r for r in cur.fetchall()}
            for row in payload.get("skus") or []:
                canonical = product_values.get(row.get("sku"))
                if not canonical:
                    continue
                current = float(canonical.get("sales_t28") or 0)
                prior = float(canonical.get("sales_prior_t28") or 0)
                row.update(
                    sales_t28=canonical.get("sales_t28"),
                    units_t28=canonical.get("units_t28"),
                    delta28_pct=canonical.get("delta28_pct"),
                    state=_state(current, prior),
                    sales_basis="AMAZON_ORDERED_PRODUCT_SALES",
                )
            payload["skus"] = sorted(payload.get("skus") or [], key=lambda r: -float(r.get("sales_t28") or 0))

        # Recent Orders are shopper-spend evidence. Never fall back to settlement
        # proceeds, which can be net of IVA in Mexico.
        cur.execute(
            """
            WITH items AS (
              SELECT amazon_order_id,
                     string_agg(DISTINCT COALESCE(seller_sku,title,'item'),', ' ORDER BY COALESCE(seller_sku,title,'item')) AS items
              FROM core.amazon_order_item GROUP BY amazon_order_id
            )
            SELECT to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') AS local_time,
                   extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint AS age_seconds,
                   right(o.amazon_order_id,9) AS order_short,
                   COALESCE(i.items,'') AS items,
                   o.customer_spend AS sales,
                   'GROSS_CUSTOMER_SPEND'::text AS sales_basis,
                   COALESCE(o.fulfillment_status,'') AS status
            FROM mart.order_customer_spend o
            JOIN core.marketplace mp USING (marketplace_id)
            LEFT JOIN items i USING (amazon_order_id)
            WHERE o.marketplace_id=%s
            ORDER BY o.created_time DESC LIMIT 30
            """,
            (marketplace,),
        )
        payload["orders"] = list(cur.fetchall())

    payload["metric_basis"] = {
        "currency": market.get("currency") or "MXN",
        "timezone": market.get("timezone"),
        "historical_sales": {
            "id": "AMAZON_ORDERED_PRODUCT_SALES",
            "label": "Amazon ordered-product sales",
            "source": "Sales & Traffic / Data Kiosk",
            "definition": "Reconciled operating sales. Settlement/proceeds amounts are excluded.",
        },
        "today_and_orders": {
            "id": "GROSS_CUSTOMER_SPEND",
            "label": "Shopper spend incl. IVA",
            "source": "Amazon Orders",
            "definition": "Order grand total with gross item price × quantity fallback.",
        },
        "finance_boundary": "Finance is the accounting surface and separately reports net sales ex IVA, IVA, and gross customer spend.",
    }
    if payload.get("today"):
        payload["today"]["sales_basis"] = "GROSS_CUSTOMER_SPEND"
    return payload
