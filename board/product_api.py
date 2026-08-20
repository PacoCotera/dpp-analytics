from __future__ import annotations


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def product_payload(connect, decorate_products, marketplace: str, sku: str) -> dict:
    sku = (sku or '').strip()
    if not sku:
        raise ValueError('sku is required')

    with connect() as conn, conn.cursor() as cur:
        profile = _one(
            cur,
            """
            SELECT
              s.sku,
              COALESCE(sl.asin,s.asin) AS asin,
              COALESCE(sl.item_name,ci.title,s.title,s.sku) AS product,
              COALESCE(sl.image_url,ci.image_url) AS image_url,
              COALESCE(sl.price,s.list_price) AS listing_price,
              sl.status AS listing_status,
              sl.fulfillment_channel,
              sl.open_date,
              a.available,
              a.inbound,
              a.days_cover_on_hand,
              a.days_cover_with_inbound,
              a.action AS inventory_action,
              a.units_per_day,
              a.sales_t28 AS inventory_sales_t28,
              a.units_t28 AS inventory_units_t28
            FROM core.sku s
            LEFT JOIN core.seller_listing sl
              ON sl.seller_sku=s.sku AND sl.marketplace_id=%s
            LEFT JOIN core.catalog_item ci
              ON ci.marketplace_id=%s AND ci.asin=COALESCE(sl.asin,s.asin)
            LEFT JOIN mart.inventory_attention a
              ON a.marketplace_id=%s AND a.seller_sku=s.sku
            WHERE s.sku=%s
            LIMIT 1
            """,
            (marketplace, marketplace, marketplace, sku),
        )
        if not profile:
            raise LookupError(f'Unknown SKU: {sku}')

        asin = profile.get('asin')
        cutoff = _one(
            cur,
            """
            SELECT max(business_date) AS d
            FROM mart.business_daily
            WHERE marketplace_id=%s AND reconciled_daily_report
            """,
            (marketplace,),
        ).get('d')

        performance = _one(
            cur,
            """
            WITH c AS (SELECT %s::date d), x AS (
              SELECT
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::numeric(14,2) sales_t7,
                COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::bigint units_t7,
                COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::bigint orders_t7,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::numeric(14,2) sales_t28,
                COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint units_t28,
                COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint orders_t28,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d-28),0)::numeric(14,2) sales_prior_t28,
                COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-89 AND c.d),0)::numeric(14,2) sales_t90,
                COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-89 AND c.d),0)::bigint units_t90
              FROM mart.sku_daily, c
              WHERE marketplace_id=%s AND seller_sku=%s
                AND business_date BETWEEN c.d-89 AND c.d
            )
            SELECT x.*,
              CASE WHEN sales_prior_t28>0 THEN round(100.0*(sales_t28-sales_prior_t28)/sales_prior_t28,1) END AS delta28_pct,
              CASE WHEN orders_t28>0 THEN round(sales_t28/orders_t28,2) END AS aov_t28
            FROM x
            """,
            (cutoff, marketplace, sku),
        ) if cutoff else {}

        traffic = _one(
            cur,
            """
            WITH c AS (SELECT %s::date d)
            SELECT
              COALESCE(sum(sessions),0)::bigint AS sessions_t28,
              COALESCE(sum(page_views),0)::bigint AS page_views_t28,
              COALESCE(sum(units_ordered),0)::bigint AS traffic_units_t28,
              CASE WHEN COALESCE(sum(sessions),0)>0
                   THEN round(100.0*COALESCE(sum(units_ordered),0)/sum(sessions),1) END AS cvr_t28
            FROM core.asin_sales_traffic_daily, c
            WHERE marketplace_id=%s AND asin=%s
              AND business_date BETWEEN c.d-27 AND c.d
            """,
            (cutoff, marketplace, asin),
        ) if cutoff and asin else {}

        ads_through = _one(cur, """
            SELECT max(d.business_date) AS d
            FROM ads.daily_advertised_product d
            JOIN ads.account a USING(account_id)
            WHERE a.marketplace_id=%s
              AND (d.advertised_sku=%s OR (%s<>'' AND d.advertised_asin=%s))
        """, (marketplace, sku, asin or '', asin or '')).get('d')

        ads = _one(cur, """
            WITH c AS (SELECT %s::date d), ad AS (
              SELECT
                coalesce(sum(d.spend) FILTER (WHERE d.business_date BETWEEN c.d-27 AND c.d),0) spend_t28,
                coalesce(sum(d.attributed_sales) FILTER (WHERE d.business_date BETWEEN c.d-27 AND c.d),0) attributed_sales_t28,
                coalesce(sum(d.clicks) FILTER (WHERE d.business_date BETWEEN c.d-27 AND c.d),0)::bigint clicks_t28,
                coalesce(sum(d.impressions) FILTER (WHERE d.business_date BETWEEN c.d-27 AND c.d),0)::bigint impressions_t28,
                coalesce(sum(d.purchases) FILTER (WHERE d.business_date BETWEEN c.d-27 AND c.d),0)::bigint purchases_t28,
                coalesce(sum(d.spend) FILTER (WHERE d.business_date BETWEEN c.d-55 AND c.d-28),0) spend_prior_t28,
                coalesce(sum(d.attributed_sales) FILTER (WHERE d.business_date BETWEEN c.d-55 AND c.d-28),0) attributed_sales_prior_t28
              FROM ads.daily_advertised_product d
              JOIN ads.account a ON a.account_id=d.account_id
              CROSS JOIN c
              WHERE a.marketplace_id=%s
                AND (d.advertised_sku=%s OR (%s<>'' AND d.advertised_asin=%s))
                AND d.business_date BETWEEN c.d-55 AND c.d
            ), seller AS (
              SELECT coalesce(sum(sales),0) sales_t28
              FROM mart.sku_daily, c
              WHERE marketplace_id=%s AND seller_sku=%s AND business_date BETWEEN c.d-27 AND c.d
            )
            SELECT ad.*,
              CASE WHEN spend_t28>0 THEN attributed_sales_t28/spend_t28 END AS roas_t28,
              CASE WHEN attributed_sales_t28>0 THEN spend_t28/attributed_sales_t28 END AS acos_t28,
              CASE WHEN seller.sales_t28>0 THEN spend_t28/seller.sales_t28 END AS tacos_t28,
              CASE WHEN spend_prior_t28>0 THEN round(100.0*(spend_t28-spend_prior_t28)/spend_prior_t28,1) END AS spend_delta28_pct,
              c.d AS through_date
            FROM ad CROSS JOIN seller CROSS JOIN c
        """, (ads_through, marketplace, sku, asin or '', asin or '', marketplace, sku)) if ads_through else {}
        ads['status'] = 'ready' if ads_through else 'awaiting_ads_data'

        series = _all(
            cur,
            """
            WITH c AS (SELECT %s::date d), days AS (
              SELECT generate_series(c.d-89,c.d,interval '1 day')::date AS business_date FROM c
            ), s AS (
              SELECT business_date, sum(sales)::numeric(14,2) sales, sum(units)::bigint units
              FROM mart.sku_daily
              WHERE marketplace_id=%s AND seller_sku=%s
                AND business_date BETWEEN %s::date-89 AND %s::date
              GROUP BY business_date
            ), t AS (
              SELECT business_date, sessions, page_views, units_ordered,
                     unit_session_percentage
              FROM core.asin_sales_traffic_daily
              WHERE marketplace_id=%s AND asin=%s
                AND business_date BETWEEN %s::date-89 AND %s::date
            ), ad AS (
              SELECT d.business_date, sum(d.spend) ad_spend, sum(d.attributed_sales) ad_attributed_sales
              FROM ads.daily_advertised_product d
              JOIN ads.account a USING(account_id)
              WHERE a.marketplace_id=%s
                AND (d.advertised_sku=%s OR (%s<>'' AND d.advertised_asin=%s))
                AND d.business_date BETWEEN %s::date-89 AND %s::date
              GROUP BY d.business_date
            )
            SELECT d.business_date,
                   COALESCE(s.sales,0)::numeric(14,2) sales,
                   COALESCE(s.units,0)::bigint units,
                   t.sessions,t.page_views,t.units_ordered,t.unit_session_percentage,
                   ad.ad_spend,ad.ad_attributed_sales
            FROM days d LEFT JOIN s USING (business_date) LEFT JOIN t USING (business_date) LEFT JOIN ad USING (business_date)
            ORDER BY d.business_date
            """,
            (cutoff, marketplace, sku, cutoff, cutoff, marketplace, asin or '', cutoff, cutoff,
             marketplace, sku, asin or '', asin or '', cutoff, cutoff),
        ) if cutoff else []

        recent_orders = _all(
            cur,
            """
            SELECT
              to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') AS local_time,
              extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint AS age_seconds,
              right(o.amazon_order_id,9) AS order_short,
              i.quantity_ordered AS units,
              COALESCE(i.proceeds_total_amount,i.proceeds_item_amount,i.unit_price_amount*i.quantity_ordered,0)::numeric(14,2) AS sales,
              COALESCE(o.fulfillment_status,'') AS status
            FROM core.amazon_order_item i
            JOIN core.amazon_order o USING (amazon_order_id)
            JOIN core.marketplace mp USING (marketplace_id)
            WHERE o.marketplace_id=%s AND i.seller_sku=%s
              AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
            ORDER BY o.created_time DESC
            LIMIT 15
            """,
            (marketplace, sku),
        )

        inventory_history = _all(
            cur,
            """
            SELECT snapshot_at, fulfillable_quantity AS available,
                   inbound_working_quantity+inbound_shipped_quantity+inbound_receiving_quantity AS inbound,
                   reserved_quantity AS reserved
            FROM core.inventory_snapshot
            WHERE marketplace_id=%s AND seller_sku=%s
            ORDER BY snapshot_at DESC
            LIMIT 30
            """,
            (marketplace, sku),
        )

        local_clock = _one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

    return {
        'profile': decorate_products([profile])[0],
        'performance': performance,
        'traffic': traffic,
        'ads': ads,
        'series': series,
        'recent_orders': recent_orders,
        'inventory_history': inventory_history,
        'business_date': cutoff,
        'local_time': local_clock.get('local_time'),
    }
