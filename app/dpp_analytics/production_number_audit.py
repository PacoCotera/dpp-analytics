from __future__ import annotations

import argparse
import json

import httpx

from . import db
from .settings import settings


def _money(value) -> float:
    return round(float(value or 0), 2)


def _close(a, b, tolerance: float = 0.02) -> bool:
    return abs(float(a or 0) - float(b or 0)) <= tolerance


def _get(client: httpx.Client, path: str) -> dict:
    response = client.get(path)
    response.raise_for_status()
    return response.json()


def audit(board_url: str) -> dict:
    failures: list[str] = []
    warnings: list[str] = []
    evidence: dict[str, object] = {}

    with httpx.Client(base_url=board_url.rstrip('/'), timeout=20) as client:
        today = _get(client, '/api/today')
        home = _get(client, '/api/home')
        sales = _get(client, '/api/sales')
        catalog = _get(client, '/api/catalog')
        inventory = _get(client, '/api/inventory')
        finance = _get(client, '/api/finance')
        trajectory = _get(client, '/api/trajectory')

    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT timezone,currency FROM core.marketplace WHERE marketplace_id=%s",
            (settings.marketplace_id,),
        )
        market = cur.fetchone() or {}
        timezone = market.get('timezone') or 'America/Mexico_City'

        cur.execute("SELECT (CURRENT_TIMESTAMP AT TIME ZONE %s)::date AS d", (timezone,))
        local_today = cur.fetchone()['d']

        cur.execute(
            """SELECT max(business_date) AS d FROM mart.business_daily
               WHERE marketplace_id=%s AND reconciled_daily_report""",
            (settings.marketplace_id,),
        )
        cutoff = (cur.fetchone() or {}).get('d')

        # Raw/current order-money evidence. This is deliberately verbose: it proves
        # which Amazon fields compose the customer-facing amount in production.
        cur.execute(
            """
            SELECT o.amazon_order_id,right(o.amazon_order_id,9) AS order_short,
                   o.grand_total_amount,
                   COALESCE(sum(i.unit_price_amount*i.quantity_ordered),0)::numeric(14,2) AS unit_price_x_qty,
                   COALESCE(sum(i.proceeds_item_amount),0)::numeric(14,2) AS proceeds_item,
                   COALESCE(sum(i.proceeds_shipping_amount),0)::numeric(14,2) AS proceeds_shipping,
                   COALESCE(sum(i.proceeds_tax_amount),0)::numeric(14,2) AS proceeds_tax,
                   COALESCE(sum(i.proceeds_total_amount),0)::numeric(14,2) AS proceeds_total,
                   COALESCE(sum(sl.price*i.quantity_ordered),0)::numeric(14,2) AS listing_price_x_qty,
                   max(ocs.customer_spend) AS canonical_customer_spend,
                   max(ocs.customer_spend_source) AS canonical_source,
                   string_agg(DISTINCT oics.customer_spend_source,',' ORDER BY oics.customer_spend_source) AS item_sources,
                   COALESCE(sum(i.quantity_ordered),0)::bigint AS units
            FROM core.amazon_order o
            JOIN core.marketplace mp USING(marketplace_id)
            LEFT JOIN core.amazon_order_item i USING(amazon_order_id)
            LEFT JOIN core.seller_listing sl
              ON sl.marketplace_id=o.marketplace_id AND sl.seller_sku=i.seller_sku
            LEFT JOIN mart.order_customer_spend ocs
              ON ocs.marketplace_id=o.marketplace_id AND ocs.amazon_order_id=o.amazon_order_id
            LEFT JOIN mart.order_item_customer_spend oics
              ON oics.marketplace_id=o.marketplace_id AND oics.amazon_order_id=o.amazon_order_id
             AND oics.seller_sku=i.seller_sku
            WHERE o.marketplace_id=%s
              AND (o.created_time AT TIME ZONE mp.timezone)::date=%s
              AND o.fulfillment_status IS DISTINCT FROM 'CANCELLED'
            GROUP BY o.amazon_order_id,o.grand_total_amount
            ORDER BY o.created_time
            """,
            (settings.marketplace_id, local_today),
        )
        raw_today = list(cur.fetchall())
        evidence['today_order_money'] = raw_today

        cur.execute(
            """SELECT COALESCE(sum(customer_spend),0)::numeric(14,2) AS sales,
                      count(*)::int AS orders,COALESCE(sum(units),0)::bigint AS units
               FROM mart.order_customer_spend
               WHERE marketplace_id=%s AND business_date=%s""",
            (settings.marketplace_id, local_today),
        )
        canonical_today = cur.fetchone() or {}
        evidence['canonical_today'] = canonical_today

        if cutoff:
            cur.execute(
                """
                WITH c AS (
                  SELECT %s::date AS d,date_trunc('month',%s::date)::date AS month_start,
                         date_trunc('year',%s::date)::date AS year_start
                )
                SELECT
                  COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::numeric(14,2) AS t28,
                  COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d-28),0)::numeric(14,2) AS prior_t28,
                  COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-6 AND c.d),0)::numeric(14,2) AS t7,
                  COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-13 AND c.d-7),0)::numeric(14,2) AS prior_t7,
                  COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-55 AND c.d),0)::numeric(14,2) AS t56,
                  COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.d-89 AND c.d),0)::numeric(14,2) AS t90,
                  COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.month_start AND c.d),0)::numeric(14,2) AS mtd,
                  COALESCE(sum(sales) FILTER (WHERE business_date BETWEEN c.year_start AND c.d),0)::numeric(14,2) AS ytd,
                  COALESCE(sum(orders) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS orders_t28,
                  COALESCE(sum(units) FILTER (WHERE business_date BETWEEN c.d-27 AND c.d),0)::bigint AS units_t28
                FROM mart.business_daily,c
                WHERE marketplace_id=%s AND reconciled_daily_report
                  AND business_date BETWEEN least(c.year_start,c.d-89) AND c.d
                """,
                (cutoff, cutoff, cutoff, settings.marketplace_id),
            )
            reconciled = cur.fetchone() or {}
        else:
            reconciled = {}
        evidence['reconciled_business'] = {'cutoff': cutoff, **reconciled}

        cur.execute(
            """
            SELECT COALESCE(sum(sales_t28),0)::numeric(14,2) AS sales_t28,
                   COALESCE(sum(units_t28),0)::bigint AS units_t28,
                   COALESCE(sum(sessions_t28),0)::bigint AS sessions_t28,
                   count(*)::int AS active_offers
            FROM mart.catalog_portfolio_product
            WHERE marketplace_id=%s AND is_offer_owner
              AND product_role IN ('SELLABLE_VARIATION','SELLABLE_STANDALONE')
              AND lower(COALESCE(status,'')) <> 'inactive'
            """,
            (settings.marketplace_id,),
        )
        portfolio = cur.fetchone() or {}
        evidence['canonical_portfolio'] = portfolio

        cur.execute(
            """SELECT count(*)::int AS duplicate_owner_asins FROM (
                 SELECT asin FROM mart.catalog_portfolio_product
                 WHERE marketplace_id=%s AND is_offer_owner GROUP BY asin HAVING count(*)>1
               ) x""",
            (settings.marketplace_id,),
        )
        duplicate_owner_asins = int((cur.fetchone() or {}).get('duplicate_owner_asins') or 0)

        cur.execute(
            """SELECT count(*)::int AS bad_nonowners
               FROM mart.catalog_portfolio_product
               WHERE marketplace_id=%s AND (product_role='STRUCTURAL_PARENT' OR product_role='SELLER_SKU_ALIAS')
                 AND (COALESCE(sales_t28,0)<>0 OR COALESCE(units_t28,0)<>0 OR COALESCE(sessions_t28,0)<>0)""",
            (settings.marketplace_id,),
        )
        bad_nonowners = int((cur.fetchone() or {}).get('bad_nonowners') or 0)

        cur.execute(
            """SELECT count(*)::int AS rows,COALESCE(sum(available),0)::bigint AS available,
                      COALESCE(sum(inbound),0)::bigint AS inbound,
                      count(*) FILTER (WHERE action IN ('STOCKOUT','PRODUCE','PLAN'))::int AS needs_action
               FROM mart.inventory_attention a LEFT JOIN core.sku s ON s.sku=a.seller_sku
               WHERE a.marketplace_id=%s AND COALESCE(s.active,true)""",
            (settings.marketplace_id,),
        )
        inv_db = cur.fetchone() or {}
        evidence['inventory_db'] = inv_db

    # Cross-surface Today is exactly one amount and one tax basis.
    today_sales = _money((today.get('today') or {}).get('sales_today'))
    canonical_sales = _money(canonical_today.get('sales'))
    home_today = _money((home.get('today') or {}).get('sales_today'))
    sales_today = _money((sales.get('today') or {}).get('sales_today'))
    if not _close(today_sales, canonical_sales): failures.append(f'Today API {today_sales} != canonical order spend {canonical_sales}')
    if not _close(home_today, canonical_sales): failures.append(f'Home Today {home_today} != canonical order spend {canonical_sales}')
    if not _close(sales_today, canonical_sales): failures.append(f'Sales Today {sales_today} != canonical order spend {canonical_sales}')
    if int((today.get('today') or {}).get('orders_today') or 0) != int(canonical_today.get('orders') or 0): failures.append('Today order count != canonical order count')

    product_sum = round(sum(_money(r.get('sales')) for r in (today.get('sku_today') or [])), 2)
    if raw_today and not _close(product_sum, canonical_sales):
        failures.append(f'Today product contribution {product_sum} != headline {canonical_sales}')

    api_orders = {str(r.get('order_short')): r for r in (today.get('recent_orders') or [])}
    for row in raw_today:
        short = str(row.get('order_short') or '')
        api = api_orders.get(short)
        if api and not _close(api.get('sales'), row.get('canonical_customer_spend')):
            failures.append(f'Today order {short} API amount != canonical amount')
        source = str(row.get('canonical_source') or '')
        if 'UNKNOWN' in source or source == 'NO_AMOUNT':
            failures.append(f'Today order {short} has unknown tax basis: {source}')

        # Listing price is independent seller-owned evidence for the current offer.
        # A difference can be legitimate after a promotion, so only require agreement
        # when Orders itself has no completed proceeds total/tax yet. This is the exact
        # transient state that previously mixed MX$279 and MX$240.52.
        listing = _money(row.get('listing_price_x_qty'))
        canonical = _money(row.get('canonical_customer_spend'))
        completed_order_money = _money(row.get('proceeds_total')) > 0 or _money(row.get('proceeds_tax')) > 0
        if not completed_order_money and listing > 0 and not _close(canonical, listing):
            failures.append(
                f"Today order {short}: provisional canonical {canonical} != current offer price {listing}; tax basis is inconsistent"
            )

    # Historical business values are reconciled Sales & Traffic only.
    h = sales.get('headline') or {}
    for api_key, db_key in (
        ('sales_t28','t28'),('sales_t7','t7'),('sales_mtd','mtd'),('sales_ytd','ytd'),
        ('orders_t28','orders_t28'),('units_t28','units_t28'),
    ):
        if not _close(h.get(api_key), reconciled.get(db_key)):
            failures.append(f'Sales {api_key} != reconciled {db_key}')

    t28 = _money(reconciled.get('t28'))
    if not _close((home.get('rolling') or {}).get('sales_t28'), t28): failures.append('Home T28 != reconciled T28')
    horizon_map = {str(r.get('label')): r for r in (trajectory.get('horizons') or [])}
    for label, db_key in (('28D','t28'),('56D','t56'),('90D','t90')):
        if not _close((horizon_map.get(label) or {}).get('sales'), reconciled.get(db_key)):
            failures.append(f'Trajectory {label} != reconciled {db_key}')

    # Portfolio identity and additive totals.
    if duplicate_owner_asins: failures.append(f'{duplicate_owner_asins} ASINs have multiple canonical offer owners')
    if bad_nonowners: failures.append(f'{bad_nonowners} structural/alias rows carry commercial demand')
    cat_summary = catalog.get('summary') or {}
    if not _close(cat_summary.get('sales_t28'), portfolio.get('sales_t28')): failures.append('Catalog portfolio sales != canonical offer-owner sum')
    traj_port = trajectory.get('portfolio') or {}
    if not _close(traj_port.get('portfolio_sales_t28'), portfolio.get('sales_t28')): failures.append('Trajectory portfolio sales != canonical offer-owner sum')

    # Inventory additive summary.
    inv_summary = inventory.get('summary') or {}
    for key in ('available','inbound','needs_action'):
        if int(inv_summary.get(key) or 0) != int(inv_db.get(key) or 0): failures.append(f'Inventory {key} != warehouse')

    # Finance accounting identity on every period surfaced by the UI.
    for label, row in [('OPEN', finance.get('current_month') or {})] + [
        (str(r.get('month')), r) for r in (finance.get('closed_months') or []) + (finance.get('finalizing_months') or [])
    ]:
        if row and not _close(row.get('shopper_product_spend'), _money(row.get('net_sales_ex_vat')) + _money(row.get('iva_on_sales'))):
            failures.append(f'Finance {label}: gross != net sales + IVA')

    # A ready Finance advertising candidate is an expense, never positive income.
    for row in (finance.get('finalizing_months') or []):
        if row.get('advertising_final') and row.get('advertising') is not None and float(row.get('advertising')) > 0:
            failures.append(f"Finance {row.get('month')}: advertising candidate has positive income sign")

    return {
        'status': 'PASS' if not failures else 'FAIL',
        'marketplace': settings.marketplace_id,
        'currency': market.get('currency'),
        'local_date': str(local_today),
        'failures': failures,
        'warnings': warnings,
        'evidence': evidence,
        'api_summary': {
            'today_sales': today_sales,
            'today_orders': int((today.get('today') or {}).get('orders_today') or 0),
            'home_today_sales': home_today,
            'sales_today_sales': sales_today,
            'reconciled_t28': t28,
            'sales_mtd': _money(h.get('sales_mtd')),
            'sales_ytd': _money(h.get('sales_ytd')),
            'catalog_sales_t28': _money(cat_summary.get('sales_t28')),
            'trajectory_portfolio_sales_t28': _money(traj_port.get('portfolio_sales_t28')),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--board-url', default='http://board:8080')
    parser.add_argument('--fail', action='store_true', help='exit non-zero on numeric failures')
    args = parser.parse_args()
    result = audit(args.board_url)
    print(json.dumps(result, default=str, indent=2, sort_keys=True))
    if args.fail and result['status'] != 'PASS':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
