from __future__ import annotations

from interpretation_rules import (
    rule_catalog,
    sales_breadth,
    sales_concentration,
    sales_product_change,
    today_pace,
)
from sales_api_legacy import sales_payload as _legacy_sales_payload


def _decorate_recent_order_items(cur, decorate_products, orders: list[dict]) -> list[dict]:
    """Resolve Sales order evidence through the same editable SKU label map as products."""
    order_ids = [str(row.get("order_id") or "") for row in orders if row.get("order_id")]
    if not order_ids:
        return orders

    cur.execute(
        """
        SELECT i.amazon_order_id AS order_id,
               i.seller_sku AS sku,
               i.asin,
               COALESCE(sl.item_name,s.title,i.title,i.seller_sku,'Item') AS product,
               COALESCE(sl.image_url,ci.image_url) AS image_url,
               COALESCE(i.quantity_ordered,0)::bigint AS quantity_ordered
        FROM core.amazon_order_item i
        JOIN core.amazon_order o USING (amazon_order_id)
        LEFT JOIN core.sku s ON s.sku=i.seller_sku
        LEFT JOIN core.seller_listing sl
          ON sl.marketplace_id=o.marketplace_id AND sl.seller_sku=i.seller_sku
        LEFT JOIN core.catalog_item ci
          ON ci.marketplace_id=o.marketplace_id AND ci.asin=COALESCE(i.asin,s.asin)
        WHERE i.amazon_order_id=ANY(%s)
        ORDER BY i.amazon_order_id,i.order_item_id
        """,
        (order_ids,),
    )
    item_rows = [dict(row) for row in cur.fetchall()]
    decorate_products(item_rows)

    grouped: dict[str, list[dict]] = {}
    for item in item_rows:
        grouped.setdefault(str(item.get("order_id") or ""), []).append(item)

    for order in orders:
        items = grouped.get(str(order.get("order_id") or ""), [])
        order["order_items"] = items
        labels: list[str] = []
        for item in items:
            name = str(item.get("product") or item.get("sku") or item.get("asin") or "Item")
            qty = int(item.get("quantity_ordered") or 0)
            labels.append(f"{name} ×{qty}" if qty > 1 else name)
        order["items"] = ", ".join(labels)
    return orders


def _product_read(headline: dict, products: list[dict]) -> dict:
    product_sales = sum(float(row.get("sales_t28") or 0) for row in products)
    top_three_sales = sum(float(row.get("sales_t28") or 0) for row in products[:3])
    top_three_share = round(100.0 * top_three_sales / product_sales, 1) if product_sales else None
    growing = sum(1 for row in products if float(row.get("delta28_pct") or 0) >= 8)
    declining = sum(1 for row in products if float(row.get("delta28_pct") or 0) <= -8)
    stable = max(0, len(products) - growing - declining)
    movement_rows = [row for row in products if row.get("sales_change_t28") is not None]
    leading_mover = max(
        movement_rows,
        key=lambda row: abs(float(row.get("sales_change_t28") or 0)),
        default={},
    )
    change_evaluation = sales_product_change(headline.get("sales_change_t28"))
    concentration_evaluation = sales_concentration(top_three_share)
    breadth_evaluation = sales_breadth(growing, declining, stable)
    return {
        "sales_t28": headline.get("sales_t28"),
        "sales_prior_t28": headline.get("sales_prior_t28"),
        "sales_change_t28": headline.get("sales_change_t28"),
        "delta28_pct": headline.get("delta28_pct"),
        "top_three_share_pct": top_three_share,
        "concentration_state": concentration_evaluation["label"],
        "growing": growing,
        "declining": declining,
        "stable": stable,
        "breadth_state": breadth_evaluation["label"],
        "change_evaluation": change_evaluation,
        "concentration_evaluation": concentration_evaluation,
        "breadth_evaluation": breadth_evaluation,
        "leading_mover": {
            "sku": leading_mover.get("sku"),
            "product": leading_mover.get("product"),
            "sales_change_t28": leading_mover.get("sales_change_t28"),
        }
        if leading_mover
        else {},
    }


def sales_payload(connect, decorate_products, marketplace: str) -> dict:
    payload = _legacy_sales_payload(
        connect,
        decorate_products,
        marketplace,
        include_geography=False,
    )
    cutoff = (payload.get("headline") or {}).get("business_date")

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT currency,timezone,country_code FROM core.marketplace WHERE marketplace_id=%s",
            (marketplace,),
        )
        market = cur.fetchone() or {}

        if cutoff:
            cur.execute(
                """
                WITH c AS (
                  SELECT %s::date AS d,date_trunc('month',%s::date)::date AS month_start,
                         date_trunc('year',%s::date)::date AS year_start,extract(day FROM %s::date)::int AS dom,
                         extract(day FROM (date_trunc('month',%s::date)+interval '1 month - 1 day'))::int AS dim
                ), x AS (
                  SELECT COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.month_start AND c.d),0)::numeric(14,2) AS sales_mtd,
                         COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.month_start AND c.d),0)::bigint AS orders_mtd,
                         COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.month_start AND c.d),0)::bigint AS units_mtd,
                         COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN (c.month_start-interval '1 month')::date AND ((c.month_start-interval '1 month')::date+(c.dom-1))),0)::numeric(14,2) AS sales_prev_month_same_days,
                         COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN (c.month_start-interval '1 month')::date AND c.month_start-1),0)::numeric(14,2) AS sales_prev_month_full,
                         COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.year_start AND c.d),0)::numeric(14,2) AS sales_ytd,
                         COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.year_start AND c.d),0)::bigint AS orders_ytd,
                         COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.year_start AND c.d),0)::bigint AS units_ytd,
                         COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::numeric(14,2) AS sales_t7,
                         COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::bigint AS orders_t7,
                         COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-13 AND c.d-7),0)::numeric(14,2) AS sales_prior_t7,
                         COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::numeric(14,2) AS sales_t28,
                         COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS orders_t28,
                         COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS units_t28,
                         COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d-28),0)::numeric(14,2) AS sales_prior_t28,
                         COALESCE(sum(sessions) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS sessions_t28
                  FROM mart.business_daily,c
                  WHERE marketplace_id=%s AND reconciled_daily_report
                    AND business_date BETWEEN least(c.year_start,(c.month_start-interval '1 month')::date,c.d-55) AND c.d
                )
                SELECT c.d AS business_date,c.dom AS month_days_elapsed,c.dim AS month_days_total,
                       x.sales_mtd,x.orders_mtd,x.units_mtd,x.sales_prev_month_same_days,x.sales_prev_month_full,
                       round(x.sales_mtd/greatest(c.dom,1),2) AS daily_avg_mtd,
                       round((x.sales_mtd/greatest(c.dom,1))*c.dim,2) AS projected_month_sales,
                       CASE WHEN x.sales_prev_month_same_days>0 THEN round(100.0*(x.sales_mtd-x.sales_prev_month_same_days)/x.sales_prev_month_same_days,1) END AS delta_mtd_pct,
                       x.sales_ytd,x.orders_ytd,x.units_ytd,x.sales_t7,x.orders_t7,round(x.sales_t7/7.0,2) AS daily_avg_t7,
                       CASE WHEN x.sales_prior_t7>0 THEN round(100.0*(x.sales_t7-x.sales_prior_t7)/x.sales_prior_t7,1) END AS delta7_pct,
                       x.sales_t28,x.sales_prior_t28,x.orders_t28,x.units_t28,x.sessions_t28,round(x.sales_t28/28.0,2) AS daily_avg_t28,
                       CASE WHEN x.sales_prior_t28>0 THEN round(100.0*(x.sales_t28-x.sales_prior_t28)/x.sales_prior_t28,1) END AS delta28_pct,
                       (x.sales_t28-x.sales_prior_t28)::numeric(14,2) AS sales_change_t28,
                       CASE WHEN x.sessions_t28>0 THEN round(100.0*x.units_t28/x.sessions_t28,1) END AS cvr28_pct
                FROM c CROSS JOIN x
                """,
                (cutoff, cutoff, cutoff, cutoff, cutoff, marketplace),
            )
            payload["headline"] = cur.fetchone() or {}

            cur.execute(
                """
                SELECT business_date,sales,orders,units
                FROM mart.business_daily
                WHERE marketplace_id=%s AND reconciled_daily_report
                  AND business_date BETWEEN %s::date-89 AND %s::date
                ORDER BY business_date
                """,
                (marketplace, cutoff, cutoff),
            )
            payload["series"] = list(cur.fetchall())

            cur.execute(
                """
                WITH product_base AS (
                  SELECT p.seller_sku AS sku,p.asin,p.title AS product,p.image_url,
                         p.sales_t28,p.units_t28,p.sales_delta28_pct AS delta28_pct,
                         COALESCE(m.state,CASE WHEN p.sales_t28>0 THEN 'STABLE' ELSE 'DORMANT' END) AS state,
                         'AMAZON_ORDERED_PRODUCT_SALES'::text AS sales_basis,
                         CASE
                           WHEN p.sales_delta28_pct IS NULL OR p.sales_delta28_pct<=-100 THEN NULL
                           ELSE round(p.sales_t28/(1+p.sales_delta28_pct/100.0),2)
                         END::numeric(14,2) AS sales_prior_t28
                  FROM mart.catalog_portfolio_product p
                  LEFT JOIN mart.catalog_movers_t28 m
                    ON m.marketplace_id=p.marketplace_id AND m.seller_sku=p.seller_sku
                  WHERE p.marketplace_id=%s AND p.is_offer_owner
                    AND p.product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE') AND p.sales_t28>0
                ), scored AS (
                  SELECT p.*,
                         (p.sales_t28-p.sales_prior_t28)::numeric(14,2) AS sales_change_t28,
                         round(100.0*p.sales_t28/nullif(sum(p.sales_t28) OVER (),0),1) AS share_t28_pct
                  FROM product_base p
                )
                SELECT s.*,
                       round(100.0*abs(s.sales_change_t28)/nullif(sum(abs(s.sales_change_t28)) OVER (),0),1) AS movement_contribution_pct
                FROM scored s
                ORDER BY s.sales_t28 DESC,s.sku LIMIT 20
                """,
                (marketplace,),
            )
            payload["skus"] = decorate_products(list(cur.fetchall()))
            payload["product_read"] = _product_read(payload["headline"], payload["skus"])

        cur.execute(
            """
            SELECT o.amazon_order_id AS order_id,
                   to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') AS local_time,
                   extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint AS age_seconds,
                   right(o.amazon_order_id,9) AS order_short,
                   ''::text AS items,
                   o.customer_spend AS sales,'GROSS_CUSTOMER_SPEND'::text AS sales_basis,
                   COALESCE(o.fulfillment_status,'') AS status
            FROM mart.order_customer_spend o
            JOIN core.marketplace mp USING(marketplace_id)
            WHERE o.marketplace_id=%s ORDER BY o.created_time DESC LIMIT 30
            """,
            (marketplace,),
        )
        recent_orders = [dict(row) for row in cur.fetchall()]
        payload["orders"] = _decorate_recent_order_items(cur, decorate_products, recent_orders)

    payload["metric_basis"] = {
        "currency": market.get("currency") or "MXN",
        "timezone": market.get("timezone"),
        "historical_sales": {
            "id": "AMAZON_ORDERED_PRODUCT_SALES",
            "label": "Amazon ordered-product sales",
            "source": "Sales & Traffic / Data Kiosk",
            "definition": "Reconciled operating sales only. Order-derived gap rows and settlement/proceeds amounts are excluded.",
        },
        "product_sales": {
            "id": "AMAZON_ORDERED_PRODUCT_SALES",
            "label": "Amazon ordered-product sales",
            "source": "CHILD-ASIN Sales & Traffic mapped to canonical offer owner",
            "definition": "ASIN demand is attached exactly once to the canonical sellable offer; aliases and structural parents do not duplicate revenue.",
        },
        "today_and_orders": {
            "id": "GROSS_CUSTOMER_SPEND",
            "label": "Shopper spend incl. IVA",
            "source": "Amazon Orders",
            "definition": "Customer product spend on one tax-inclusive basis from explicit ITEM+TAX evidence where available; settlement fees are excluded.",
        },
        "finance_boundary": "Finance separately reports net sales ex IVA, IVA withheld, and gross customer spend.",
    }
    if payload.get("today"):
        payload["today"]["sales_basis"] = "GROSS_CUSTOMER_SPEND"
    today = payload.get("today") or {}
    payload["today_read"] = today_pace(
        True,
        today.get("orders_today"),
        today.get("pace_vs_same_weekday_pct"),
        "day",
    )
    payload["interpretation_rules"] = rule_catalog(
        "TODAY_PACE_V1",
        "SALES_PRODUCT_CHANGE_V1",
        "SALES_CONCENTRATION_V1",
        "SALES_BREADTH_V1",
    )
    payload.pop("geography", None)
    return payload
