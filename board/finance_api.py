from __future__ import annotations

import json
import os
from pathlib import Path


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _load_product_costs() -> dict[str, float]:
    """Load editable seller-owned unit COGS.

    Amazon exposes Amazon fees and accounting events, not the seller's own
    manufacturing/product cost. Keep that cost local and editable rather than
    baking it into application code.
    """
    path = Path(os.getenv("PRODUCT_COSTS_PATH", "/app/product_costs.json"))
    try:
        raw = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    raw = raw.get("costs", raw) if isinstance(raw, dict) else {}
    costs: dict[str, float] = {}
    for sku, value in raw.items():
        if not isinstance(sku, str) or sku.startswith("_"):
            continue
        if isinstance(value, dict):
            value = value.get("unit_cogs")
        if value is None:
            continue
        try:
            amount = float(value)
        except (TypeError, ValueError):
            continue
        if amount >= 0:
            costs[sku] = amount
    return costs


def finance_payload(connect, marketplace: str) -> dict:
    """Amazon accounting plus seller-owned product COGS when configured.

    Amazon transactions include proceeds, fees, refunds and ad charges. Product
    COGS is supplied locally because it is the seller's private cost structure.
    Even with complete product COGS this page is contribution, not a full P&L:
    payroll, rent, freight-to-FBA and other off-Amazon overhead may still exist.
    """
    with connect() as conn, conn.cursor() as cur:
        cutoff = _one(
            cur,
            "SELECT max(posted_date) AS posted_at FROM core.financial_transaction WHERE marketplace_id=%s",
            (marketplace,),
        ).get('posted_at')
        if cutoff is None:
            return {'summary': {}, 'types': [], 'daily': [], 'breakdowns': [], 'recent': [], 'cogs': [], 'local_time': None}

        summary = _one(
            cur,
            """
            WITH x AS (
              SELECT transaction_type,total_amount,posted_date
              FROM core.financial_transaction
              WHERE marketplace_id=%s AND posted_date>=%s::timestamptz-interval '56 days'
            ), a AS (
              SELECT
                count(*) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days')::int AS transactions_28,
                COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type='Shipment'),0)::numeric(16,2) AS shipment_amount_28,
                COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '56 days' AND posted_date<%s::timestamptz-interval '28 days' AND transaction_type='Shipment'),0)::numeric(16,2) AS shipment_amount_prior_28,
                COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type='Refund'),0)::numeric(16,2) AS refund_amount_28,
                COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type='ProductAdsPayment'),0)::numeric(16,2) AS ads_amount_28,
                COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type='ServiceFee'),0)::numeric(16,2) AS service_fee_amount_28,
                COALESCE(sum(total_amount) FILTER (WHERE posted_date>=%s::timestamptz-interval '28 days' AND transaction_type='Adjustment'),0)::numeric(16,2) AS adjustment_amount_28,
                COALESCE(sum(total_amount) FILTER (
                  WHERE posted_date>=%s::timestamptz-interval '28 days'
                    AND transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')
                ),0)::numeric(16,2) AS operating_ledger_balance_28,
                COALESCE(sum(total_amount) FILTER (
                  WHERE posted_date>=%s::timestamptz-interval '56 days'
                    AND posted_date<%s::timestamptz-interval '28 days'
                    AND transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement')
                ),0)::numeric(16,2) AS operating_ledger_balance_prior_28,
                max(posted_date) AS latest_posted
              FROM x
            )
            SELECT a.*,
              CASE WHEN shipment_amount_28>0
                   THEN round(100.0*operating_ledger_balance_28/shipment_amount_28,1) END AS amazon_contribution_rate_28,
              CASE WHEN operating_ledger_balance_prior_28<>0
                   THEN round(100.0*(operating_ledger_balance_28-operating_ledger_balance_prior_28)/abs(operating_ledger_balance_prior_28),1) END AS amazon_contribution_delta_pct,
              greatest(operating_ledger_balance_28,0)::numeric(16,2) AS break_even_off_amazon_costs_28
            FROM a
            """,
            (marketplace, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff, cutoff),
        )

        # Attribute product cost to orders that have a Shipment accounting event
        # inside the same 28-day finance window. DISTINCT avoids multiplying COGS
        # when Amazon posts more than one Shipment transaction for an order.
        shipped_units = _all(
            cur,
            """
            WITH shipped_orders AS (
              SELECT DISTINCT amazon_order_id
              FROM core.financial_transaction
              WHERE marketplace_id=%s
                AND posted_date>=%s::timestamptz-interval '28 days'
                AND transaction_type='Shipment'
                AND amazon_order_id IS NOT NULL
            )
            SELECT i.seller_sku AS sku,
                   COALESCE(sum(i.quantity_ordered),0)::bigint AS units
            FROM shipped_orders so
            JOIN core.amazon_order_item i USING (amazon_order_id)
            WHERE i.seller_sku IS NOT NULL
            GROUP BY i.seller_sku
            ORDER BY units DESC, i.seller_sku
            """,
            (marketplace, cutoff),
        )

        costs = _load_product_costs()
        cogs_rows = []
        total_units = 0
        covered_units = 0
        known_cogs = 0.0
        for row in shipped_units:
            sku = row.get('sku')
            units = int(row.get('units') or 0)
            total_units += units
            unit_cogs = costs.get(sku)
            configured = unit_cogs is not None
            extended = round(units * unit_cogs, 2) if configured else None
            if configured:
                covered_units += units
                known_cogs += extended or 0.0
            cogs_rows.append({
                'sku': sku,
                'units': units,
                'unit_cogs': round(unit_cogs, 2) if configured else None,
                'extended_cogs': extended,
                'configured': configured,
            })

        coverage = round(100.0 * covered_units / total_units, 1) if total_units else 100.0
        complete = bool(total_units == covered_units)
        amazon_contribution = float(summary.get('operating_ledger_balance_28') or 0)
        after_cogs = round(amazon_contribution - known_cogs, 2) if complete else None
        summary['product_cogs_known_28'] = round(known_cogs, 2)
        summary['product_cogs_units_total_28'] = total_units
        summary['product_cogs_units_covered_28'] = covered_units
        summary['product_cogs_coverage_pct_28'] = coverage
        summary['product_cogs_complete_28'] = complete
        summary['contribution_after_product_cogs_28'] = after_cogs
        summary['remaining_off_amazon_room_28'] = max(after_cogs, 0) if after_cogs is not None else None

        types = _all(
            cur,
            """
            SELECT transaction_type,
                   count(*)::int AS transactions,
                   sum(total_amount)::numeric(16,2) AS amount
            FROM core.financial_transaction
            WHERE marketplace_id=%s AND posted_date>=%s::timestamptz-interval '90 days'
            GROUP BY transaction_type
            ORDER BY abs(sum(total_amount)) DESC
            """,
            (marketplace, cutoff),
        )

        daily = _all(
            cur,
            """
            WITH d AS (
              SELECT generate_series(
                (%s::timestamptz AT TIME ZONE 'America/Mexico_City')::date-89,
                (%s::timestamptz AT TIME ZONE 'America/Mexico_City')::date,
                interval '1 day'
              )::date AS business_date
            ), x AS (
              SELECT (posted_date AT TIME ZONE 'America/Mexico_City')::date AS business_date,
                     sum(total_amount) FILTER (WHERE transaction_type='Shipment')::numeric(16,2) AS shipment,
                     sum(total_amount) FILTER (WHERE transaction_type='ProductAdsPayment')::numeric(16,2) AS ads,
                     sum(total_amount) FILTER (WHERE transaction_type='Refund')::numeric(16,2) AS refunds,
                     sum(total_amount) FILTER (WHERE transaction_type='ServiceFee')::numeric(16,2) AS service_fees,
                     sum(total_amount) FILTER (WHERE transaction_type NOT IN ('Transfer','DebtRecovery','AdhocDisbursement'))::numeric(16,2) AS operating_balance
              FROM core.financial_transaction
              WHERE marketplace_id=%s AND posted_date>=%s::timestamptz-interval '90 days'
              GROUP BY 1
            )
            SELECT d.business_date,
                   COALESCE(x.shipment,0)::numeric(16,2) shipment,
                   COALESCE(x.ads,0)::numeric(16,2) ads,
                   COALESCE(x.refunds,0)::numeric(16,2) refunds,
                   COALESCE(x.service_fees,0)::numeric(16,2) service_fees,
                   COALESCE(x.operating_balance,0)::numeric(16,2) operating_balance
            FROM d LEFT JOIN x USING (business_date)
            ORDER BY d.business_date
            """,
            (cutoff, cutoff, marketplace, cutoff),
        )

        breakdowns = _all(
            cur,
            """
            SELECT breakdown_type,
                   count(*)::int AS entries,
                   sum(amount)::numeric(16,2) AS amount
            FROM mart.finance_leaf_breakdown
            WHERE marketplace_id=%s
              AND posted_date>=%s::timestamptz-interval '28 days'
              AND amount IS NOT NULL
            GROUP BY breakdown_type
            ORDER BY abs(sum(amount)) DESC
            LIMIT 20
            """,
            (marketplace, cutoff),
        )

        recent = _all(
            cur,
            """
            SELECT
              to_char(posted_date AT TIME ZONE 'America/Mexico_City','MM-DD HH24:MI') AS local_time,
              extract(epoch FROM (CURRENT_TIMESTAMP-posted_date))::bigint AS age_seconds,
              transaction_type,
              transaction_status,
              total_amount::numeric(16,2) AS amount,
              description,
              CASE WHEN amazon_order_id IS NOT NULL THEN right(amazon_order_id,9) END AS order_short
            FROM core.financial_transaction
            WHERE marketplace_id=%s
            ORDER BY posted_date DESC
            LIMIT 35
            """,
            (marketplace,),
        )

        local_clock = _one(cur, "SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'America/Mexico_City','HH24:MI') local_time")

    return {
        'summary': summary,
        'types': types,
        'daily': daily,
        'breakdowns': breakdowns,
        'recent': recent,
        'cogs': cogs_rows,
        'local_time': local_clock.get('local_time'),
    }
