from __future__ import annotations

from statistics import median

from ads_context import product_t28
from catalog_api import (
    _apply_canonical_identity,
    _product_costs,
    _product_taxonomy,
    _repair_variation_taxonomy,
    _variation_taxonomy_for_row,
)
from interpretation_rules import catalog_offer_state, rule_catalog


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _ads_product_identity(decorate_products, sku, asin, product, image_url):
    """Give cross-route Ads decisions the same canonical identity as the page."""
    return decorate_products(
        [
            {
                'sku': sku,
                'asin': asin,
                'product': product,
                'image_url': image_url,
            }
        ]
    )[0]


def product_payload(connect, decorate_products, marketplace: str, sku: str) -> dict:
    sku = (sku or '').strip()
    if not sku:
        raise ValueError('sku is required')

    with connect() as conn, conn.cursor() as cur:
        profile = _one(cur, """
            SELECT s.sku,COALESCE(sl.asin,s.asin) asin,
                   NULLIF(s.parent_asin,'') historical_parent_asin,
                   COALESCE(sl.item_name,ci.title,s.title,s.sku) product,
                   COALESCE(sl.image_url,ci.image_url) image_url,
                   COALESCE(sl.price,s.list_price) listing_price,
                   sl.status source_listing_status,
                   CASE WHEN COALESCE(sl.is_current_listing,false) THEN sl.status ELSE 'Deleted' END listing_status,
                   COALESCE(sl.is_current_listing,false) is_current_listing,sl.deleted_at,
                   sl.fulfillment_channel,sl.open_date,
                   a.available,a.inbound,a.days_cover_on_hand,a.days_cover_with_inbound,
                   a.action inventory_action,a.units_per_day,a.sales_t28 inventory_sales_t28,
                   a.units_t28 inventory_units_t28
            FROM core.sku s
            LEFT JOIN core.seller_listing sl ON sl.seller_sku=s.sku AND sl.marketplace_id=%s
            LEFT JOIN core.catalog_item ci ON ci.marketplace_id=%s AND ci.asin=COALESCE(sl.asin,s.asin)
            LEFT JOIN mart.inventory_attention a ON a.marketplace_id=%s AND a.seller_sku=s.sku
            WHERE s.sku=%s LIMIT 1
        """, (marketplace,marketplace,marketplace,sku))
        if not profile:
            raise LookupError(f'Unknown SKU: {sku}')

        asin = profile.get('asin')
        cutoff = _one(cur,"SELECT max(business_date) d FROM mart.business_daily WHERE marketplace_id=%s AND reconciled_daily_report",(marketplace,)).get('d')

        portfolio_rows = _all(cur, """
            SELECT p.seller_sku sku,p.asin,p.parent_asin,p.family_asin,p.product_role,
                   p.offer_owner_sku,p.is_offer_owner,p.title product,p.image_url,
                   p.sales_t28,p.units_t28,p.orders_t28,p.sessions_t28,p.page_views_t28,
                   p.conversion_t28_pct,p.sales_delta28_pct,p.sessions_delta28_pct,p.conversion_delta28_pp,
                   p.available,p.inbound,p.days_cover_on_hand,p.days_cover_with_inbound,p.inventory_action,
                   p.status,p.fulfillment_channel,p.open_date,p.traffic_through_date,
                   p.is_current_listing,p.deleted_at,p.catalog_membership,
                   ci.variation_theme amazon_variation_theme,
                   ci.variation_attributes amazon_variation_attribute_names,
                   ci.attributes catalog_attributes
            FROM mart.catalog_portfolio_product p
            LEFT JOIN core.catalog_item ci ON ci.marketplace_id=p.marketplace_id AND ci.asin=p.asin
            WHERE p.marketplace_id=%s
        """, (marketplace,))
        commercial = next(
            (row for row in portfolio_rows if row.get('sku') == sku),
            {},
        )
        if not commercial and not profile.get('is_current_listing'):
            historical_parent = profile.get('historical_parent_asin')
            commercial = {
                'sku': sku,
                'asin': asin,
                'parent_asin': historical_parent,
                'family_asin': historical_parent or asin,
                'product_role': 'HISTORICAL_RECORD',
                'product': profile.get('product'),
                'image_url': profile.get('image_url'),
                'status': 'Deleted',
                'source_listing_status': profile.get('source_listing_status'),
                'is_current_listing': False,
                'deleted_at': profile.get('deleted_at'),
                'catalog_membership': 'DELETED',
                'is_offer_owner': False,
            }

        performance = _one(cur,"""
            WITH c AS (SELECT %s::date d), x AS (
              SELECT COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::numeric(14,2) sales_t7,
                     COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::bigint units_t7,
                     COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::bigint orders_t7,
                     COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::numeric(14,2) sales_t28,
                     COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint units_t28,
                     COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint orders_t28,
                     COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d-28),0)::numeric(14,2) sales_prior_t28,
                     COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-89 AND c.d),0)::numeric(14,2) sales_t90,
                     COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-89 AND c.d),0)::bigint units_t90
              FROM mart.sku_daily,c WHERE marketplace_id=%s AND seller_sku=%s AND business_date BETWEEN c.d-89 AND c.d
            )
            SELECT x.*,CASE WHEN sales_prior_t28>0 THEN round(100.0*(sales_t28-sales_prior_t28)/sales_prior_t28,1) END delta28_pct,
                   CASE WHEN orders_t28>0 THEN round(sales_t28/orders_t28,2) END aov_t28 FROM x
        """,(cutoff,marketplace,sku)) if cutoff else {}

        traffic = _one(cur,"""
            WITH c AS (SELECT %s::date d)
            SELECT COALESCE(sum(sessions),0)::bigint sessions_t28,
                   COALESCE(sum(page_views),0)::bigint page_views_t28,
                   COALESCE(sum(units_ordered),0)::bigint traffic_units_t28,
                   CASE WHEN COALESCE(sum(sessions),0)>0 THEN round(100.0*COALESCE(sum(units_ordered),0)/sum(sessions),1) END cvr_t28
            FROM core.asin_sales_traffic_daily,c
            WHERE marketplace_id=%s AND asin=%s AND business_date BETWEEN c.d-27 AND c.d
        """,(cutoff,marketplace,asin)) if cutoff and asin else {}

        ads_identity = _ads_product_identity(
            decorate_products,
            sku,
            asin,
            commercial.get('product') or profile.get('product'),
            commercial.get('image_url') or profile.get('image_url'),
        )
        ads = product_t28(
            cur,
            marketplace,
            sku,
            product=ads_identity.get('product'),
            image_url=ads_identity.get('image_url'),
        )

        series = _all(cur,"""
            WITH c AS (SELECT %s::date d), days AS (SELECT generate_series(c.d-89,c.d,interval '1 day')::date business_date FROM c),
            s AS (SELECT business_date,sum(sales)::numeric(14,2) sales,sum(units)::bigint units FROM mart.sku_daily WHERE marketplace_id=%s AND seller_sku=%s AND business_date BETWEEN %s::date-89 AND %s::date GROUP BY business_date),
            t AS (SELECT business_date,sessions,page_views,units_ordered,unit_session_percentage FROM core.asin_sales_traffic_daily WHERE marketplace_id=%s AND asin=%s AND business_date BETWEEN %s::date-89 AND %s::date),
            ad AS (SELECT d.business_date,sum(d.spend) ad_spend,sum(d.attributed_sales) ad_attributed_sales FROM ads.daily_advertised_product d JOIN ads.account a USING(account_id) WHERE a.marketplace_id=%s AND (d.advertised_sku=%s OR (%s<>'' AND d.advertised_asin=%s)) AND d.business_date BETWEEN %s::date-89 AND %s::date GROUP BY d.business_date)
            SELECT d.business_date,COALESCE(s.sales,0)::numeric(14,2) sales,COALESCE(s.units,0)::bigint units,t.sessions,t.page_views,t.units_ordered,t.unit_session_percentage,ad.ad_spend,ad.ad_attributed_sales
            FROM days d LEFT JOIN s USING(business_date) LEFT JOIN t USING(business_date) LEFT JOIN ad USING(business_date) ORDER BY d.business_date
        """,(cutoff,marketplace,sku,cutoff,cutoff,marketplace,asin or '',cutoff,cutoff,marketplace,sku,asin or '',asin or '',cutoff,cutoff)) if cutoff else []

        recent_orders = _all(cur,"""
            SELECT to_char(o.created_time AT TIME ZONE mp.timezone,'MM-DD HH24:MI') local_time,
                   extract(epoch FROM (CURRENT_TIMESTAMP-o.created_time))::bigint age_seconds,
                   o.amazon_order_id order_id,right(o.amazon_order_id,9) order_short,
                   i.quantity_ordered units,
                   COALESCE(i.proceeds_total_amount,i.proceeds_item_amount,i.unit_price_amount*i.quantity_ordered,0)::numeric(14,2) sales,
                   COALESCE(o.fulfillment_status,'') status,
                   COALESCE(o.fulfilled_by,'') fulfilled_by,
                   CASE upper(COALESCE(o.fulfilled_by,''))
                     WHEN 'AMAZON' THEN 'FBA'
                     WHEN 'MERCHANT' THEN 'FBM'
                     ELSE 'Amazon'
                   END fulfillment_model,
                   COALESCE(o.channel_name,'Amazon') channel_name
            FROM core.amazon_order_item i
            JOIN core.amazon_order o ON o.amazon_order_id=i.amazon_order_id
            JOIN core.marketplace mp ON mp.marketplace_id=o.marketplace_id
            WHERE o.marketplace_id=%s AND i.seller_sku=%s AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
            ORDER BY o.created_time DESC LIMIT 15
        """,(marketplace,sku))

        inventory_history = _all(cur,"""
            SELECT snapshot_at,fulfillable_quantity available,
                   inbound_working_quantity+inbound_shipped_quantity+inbound_receiving_quantity inbound,
                   reserved_quantity reserved FROM core.inventory_snapshot
            WHERE marketplace_id=%s AND seller_sku=%s ORDER BY snapshot_at DESC LIMIT 30
        """,(marketplace,sku))

        family_asin = commercial.get('family_asin') or asin
        sibling_keys = (
            'sku', 'asin', 'parent_asin', 'family_asin', 'product_role', 'product',
            'image_url', 'sales_t28', 'units_t28', 'sessions_t28',
            'conversion_t28_pct', 'available', 'inbound', 'days_cover_with_inbound',
            'inventory_action', 'status', 'amazon_variation_theme',
            'amazon_variation_attribute_names', 'catalog_attributes',
        )
        siblings = [
            {key: row.get(key) for key in sibling_keys}
            for row in sorted(
                (
                    row for row in portfolio_rows
                    if family_asin
                    and row.get('family_asin') == family_asin
                    and row.get('product_role') in ('SELLABLE_VARIATION', 'SELLABLE_STANDALONE')
                    and row.get('is_offer_owner')
                ),
                key=lambda row: (
                    -float(row.get('sales_t28') or 0),
                    str(row.get('sku') or ''),
                ),
            )[:12]
        ]
        local_clock = _one(cur,"SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

    taxonomy = _product_taxonomy()
    local_taxonomy = taxonomy["products"].get(sku, {})
    commercial["family_name"] = local_taxonomy.get("family_name")
    taxonomy_rows = [commercial] + siblings if commercial else siblings
    for row in taxonomy_rows:
        row['variation_attributes'],row['variation_attribute_source']=_variation_taxonomy_for_row(row,taxonomy)
        _apply_canonical_identity(row)
    taxonomy_warnings = _repair_variation_taxonomy(taxonomy_rows)
    for row in taxonomy_rows:
        row.pop('catalog_attributes',None)

    costs=_product_costs();unit_cogs=costs.get(sku);sales_t28=float(performance.get('sales_t28') or 0);units_t28=int(performance.get('units_t28') or 0)
    estimated_cogs=round(unit_cogs*units_t28,2) if unit_cogs is not None else None
    economics={'unit_cogs':unit_cogs,'estimated_cogs_t28':estimated_cogs,
               'contribution_before_amazon_t28':round(sales_t28-estimated_cogs,2) if estimated_cogs is not None else None,
               'cogs_pct_sales_t28':round(100.0*estimated_cogs/sales_t28,1) if estimated_cogs is not None and sales_t28>0 else None,
               'basis':'Standard COGS estimate only. Amazon selling/FBA fees and advertising are not included in this product contribution read.'}
    commercial['listing_sellable']=(
        bool(profile.get('is_current_listing'))
        and str(profile.get('source_listing_status') or commercial.get('status') or '').strip().lower() == 'active'
        and bool(commercial.get('is_offer_owner'))
    )
    commercial['family_asin']=commercial.get('family_asin') or asin
    commercial['parent_asin']=commercial.get('parent_asin') or None
    active_offers = [
        row
        for row in portfolio_rows
        if row.get('product_role') in ('SELLABLE_VARIATION', 'SELLABLE_STANDALONE')
        and row.get('catalog_membership') in (None, 'CURRENT_OFFER')
        and str(row.get('status') or '').strip().lower() == 'active'
    ]
    traffic_values = [float(row.get('sessions_t28') or 0) for row in active_offers if float(row.get('sessions_t28') or 0) > 0]
    conversion_values = [float(row['conversion_t28_pct']) for row in active_offers if row.get('conversion_t28_pct') is not None]
    traffic_median = median(traffic_values) if traffic_values else 0.0
    conversion_median = median(conversion_values) if conversion_values else 0.0
    traffic_cutoff = max((row.get('traffic_through_date') for row in portfolio_rows if row.get('traffic_through_date')), default=None)
    commercial_state, commercial_explanation, commercial_evaluation = catalog_offer_state(
        commercial, traffic_median, conversion_median, traffic_cutoff
    )
    commercial['commercial_state'] = commercial_state
    commercial['commercial_explanation'] = commercial_explanation
    commercial['commercial_evaluation'] = commercial_evaluation

    decorated_commercial = decorate_products([commercial])[0] if commercial else commercial
    return {'profile':decorate_products([profile])[0],'commercial':decorated_commercial,'performance':performance,'traffic':traffic,
            'economics':economics,'ads':ads,'family_variations':decorate_products(siblings),'taxonomy_warnings':taxonomy_warnings,
            'series':series,'recent_orders':recent_orders,'inventory_history':inventory_history,'business_date':cutoff,'local_time':local_clock.get('local_time'),
            'interpretation_rules':rule_catalog('CATALOG_COMMERCIAL_STATE_V1')}
