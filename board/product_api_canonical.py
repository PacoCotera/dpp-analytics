from __future__ import annotations

from product_api_legacy import product_payload as _legacy_product_payload


def product_payload(connect, decorate_products, marketplace: str, sku: str) -> dict:
    payload = _legacy_product_payload(connect, decorate_products, marketplace, sku)
    cutoff = payload.get("business_date")
    commercial = payload.get("commercial") or {}
    asin = (payload.get("profile") or {}).get("asin") or commercial.get("asin") or ""

    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT currency,timezone,country_code FROM core.marketplace WHERE marketplace_id=%s",
            (marketplace,),
        )
        market = cur.fetchone() or {}

        if cutoff and asin:
            # Production Data Kiosk product demand is CHILD-ASIN grain. Product
            # Workspace is a commercial-offer view, so use that reconciled ASIN
            # fact rather than an unpopulated seller-SKU Sales & Traffic table.
            cur.execute(
                """
                WITH c AS (SELECT %s::date AS d), x AS (
                  SELECT
                    COALESCE(sum(ordered_product_sales) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::numeric(14,2) AS sales_t7,
                    COALESCE(sum(units_ordered) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::bigint AS units_t7,
                    COALESCE(sum(total_order_items) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::bigint AS orders_t7,
                    COALESCE(sum(ordered_product_sales) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::numeric(14,2) AS sales_t28,
                    COALESCE(sum(units_ordered) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS units_t28,
                    COALESCE(sum(total_order_items) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS orders_t28,
                    COALESCE(sum(ordered_product_sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d-28),0)::numeric(14,2) AS sales_prior_t28,
                    COALESCE(sum(ordered_product_sales) FILTER (WHERE business_date BETWEEN c.d-89 AND c.d),0)::numeric(14,2) AS sales_t90,
                    COALESCE(sum(units_ordered) FILTER (WHERE business_date BETWEEN c.d-89 AND c.d),0)::bigint AS units_t90
                  FROM core.asin_sales_traffic_daily,c
                  WHERE marketplace_id=%s AND asin=%s AND business_date BETWEEN c.d-89 AND c.d
                )
                SELECT x.*,
                       CASE WHEN sales_prior_t28>0 THEN round(100.0*(sales_t28-sales_prior_t28)/sales_prior_t28,1) END AS delta28_pct,
                       CASE WHEN orders_t28>0 THEN round(sales_t28/orders_t28,2) END AS aov_t28
                FROM x
                """,
                (cutoff, marketplace, asin),
            )
            performance = cur.fetchone() or {}
            performance["sales_basis"] = "AMAZON_ORDERED_PRODUCT_SALES"
            performance["sales_grain"] = "CHILD_ASIN"
            payload["performance"] = performance

            cur.execute(
                """
                WITH c AS (SELECT %s::date AS d),
                days AS (SELECT generate_series(c.d-89,c.d,interval '1 day')::date AS business_date FROM c),
                s AS (
                  SELECT business_date,ordered_product_sales AS sales,units_ordered AS units,
                         sessions,page_views,units_ordered,unit_session_percentage
                  FROM core.asin_sales_traffic_daily,c
                  WHERE marketplace_id=%s AND asin=%s AND business_date BETWEEN c.d-89 AND c.d
                ), ad AS (
                  SELECT d.business_date,sum(d.spend) AS ad_spend,sum(d.attributed_sales) AS ad_attributed_sales
                  FROM ads.daily_advertised_product d
                  JOIN ads.account a USING(account_id),c
                  WHERE a.marketplace_id=%s
                    AND (d.advertised_sku=%s OR d.advertised_asin=%s)
                    AND d.business_date BETWEEN c.d-89 AND c.d
                  GROUP BY d.business_date
                )
                SELECT d.business_date,COALESCE(s.sales,0)::numeric(14,2) AS sales,
                       COALESCE(s.units,0)::bigint AS units,s.sessions,s.page_views,s.units_ordered,s.unit_session_percentage,
                       ad.ad_spend,ad.ad_attributed_sales,'AMAZON_ORDERED_PRODUCT_SALES'::text AS sales_basis
                FROM days d LEFT JOIN s USING(business_date) LEFT JOIN ad USING(business_date)
                ORDER BY d.business_date
                """,
                (cutoff, marketplace, asin, marketplace, sku, asin),
            )
            payload["series"] = list(cur.fetchall())

            economics = payload.get("economics") or {}
            unit_cogs = economics.get("unit_cogs")
            units_t28 = int(performance.get("units_t28") or 0)
            sales_t28 = float(performance.get("sales_t28") or 0)
            if unit_cogs is not None:
                estimated_cogs = round(float(unit_cogs) * units_t28, 2)
                economics.update({
                    "estimated_cogs_t28": estimated_cogs,
                    "contribution_before_amazon_t28": round(sales_t28 - estimated_cogs, 2),
                    "cogs_pct_sales_t28": round(100.0 * estimated_cogs / sales_t28, 1) if sales_t28 > 0 else None,
                    "basis": "Amazon CHILD-ASIN ordered-product sales less editable standard COGS. Amazon fees and advertising are excluded from this product contribution read.",
                })
            payload["economics"] = economics

        # Seller-SKU order evidence remains gross shopper spend. Explicit join
        # predicates avoid ambiguity because both order views carry marketplace_id.
        cur.execute(
            """
            SELECT to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') AS local_time,
                   extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint AS age_seconds,
                   right(o.amazon_order_id,9) AS order_short,
                   x.units,
                   x.customer_spend AS sales,
                   'GROSS_CUSTOMER_SPEND'::text AS sales_basis,
                   COALESCE(o.fulfillment_status,'') AS status
            FROM mart.order_item_customer_spend x
            JOIN core.amazon_order o ON o.amazon_order_id=x.amazon_order_id AND o.marketplace_id=x.marketplace_id
            JOIN core.marketplace mp ON mp.marketplace_id=x.marketplace_id
            WHERE x.marketplace_id=%s AND x.seller_sku=%s
            ORDER BY o.created_time DESC LIMIT 15
            """,
            (marketplace, sku),
        )
        payload["recent_orders"] = list(cur.fetchall())

    payload["metric_basis"] = {
        "currency": market.get("currency") or "MXN",
        "timezone": market.get("timezone"),
        "product_sales": {
            "id": "AMAZON_ORDERED_PRODUCT_SALES",
            "label": "Amazon ordered-product sales",
            "source": "CHILD-ASIN Sales & Traffic / Data Kiosk",
            "definition": "Reconciled commercial product sales used for 7D/28D/90D performance. ASIN demand belongs to the canonical offer; aliases do not duplicate it.",
        },
        "order_evidence": {
            "id": "GROSS_CUSTOMER_SPEND",
            "label": "Shopper spend incl. IVA",
            "source": "Amazon Orders",
            "definition": "Item price × quantity. Settlement/proceeds amounts are excluded.",
        },
        "ads": "Amazon-attributed sales are attribution, not incremental sales; TACOS uses independent seller sales.",
    }
    return payload
