from __future__ import annotations

from geo_reference import postal_dictionary
from sales_api_legacy import sales_payload as _legacy_sales_payload


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
                       x.sales_t28,x.orders_t28,x.units_t28,x.sessions_t28,round(x.sales_t28/28.0,2) AS daily_avg_t28,
                       CASE WHEN x.sales_prior_t28>0 THEN round(100.0*(x.sales_t28-x.sales_prior_t28)/x.sales_prior_t28,1) END AS delta28_pct,
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
                SELECT p.seller_sku AS sku,p.asin,p.title AS product,p.image_url,
                       p.sales_t28,p.units_t28,p.sales_delta28_pct AS delta28_pct,
                       COALESCE(m.state,CASE WHEN p.sales_t28>0 THEN 'STABLE' ELSE 'DORMANT' END) AS state,
                       'AMAZON_ORDERED_PRODUCT_SALES'::text AS sales_basis
                FROM mart.catalog_portfolio_product p
                LEFT JOIN mart.catalog_movers_t28 m
                  ON m.marketplace_id=p.marketplace_id AND m.seller_sku=p.seller_sku
                WHERE p.marketplace_id=%s AND p.is_offer_owner
                  AND p.product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE') AND p.sales_t28>0
                ORDER BY p.sales_t28 DESC,p.seller_sku LIMIT 20
                """,
                (marketplace,),
            )
            payload["skus"] = decorate_products(list(cur.fetchall()))

        cur.execute(
            """
            WITH items AS (
              SELECT amazon_order_id,string_agg(DISTINCT COALESCE(seller_sku,title,'item'),', ' ORDER BY COALESCE(seller_sku,title,'item')) AS items
              FROM core.amazon_order_item GROUP BY amazon_order_id
            )
            SELECT to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') AS local_time,
                   extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint AS age_seconds,
                   right(o.amazon_order_id,9) AS order_short,COALESCE(i.items,'') AS items,
                   o.customer_spend AS sales,'GROSS_CUSTOMER_SPEND'::text AS sales_basis,
                   COALESCE(o.fulfillment_status,'') AS status
            FROM mart.order_customer_spend o
            JOIN core.marketplace mp USING(marketplace_id)
            LEFT JOIN items i USING(amazon_order_id)
            WHERE o.marketplace_id=%s ORDER BY o.created_time DESC LIMIT 30
            """,
            (marketplace,),
        )
        payload["orders"] = list(cur.fetchall())

    geography = payload.setdefault("geography", {})
    geo_rows = list(geography.get("daily") or [])
    codes = {str(row.get("postal_code") or "").strip().zfill(5) for row in geo_rows if row.get("postal_code")}
    geography["postal_reference"] = postal_dictionary(codes)
    geography["reference_source"] = "SEPOMEX textual catalog · open-mexico db_postal v1.2.0"

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
    return payload
