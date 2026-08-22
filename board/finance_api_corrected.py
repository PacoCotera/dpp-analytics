from __future__ import annotations

"""Canonical Finance adapter for Sales & Traffic tax basis and settlement cash.

Amazon Sales & Traffic orderedProductSales is empirically shopper spend including
IVA for DPP Mexico. Operating surfaces keep that amount gross. Finance removes
IVA explicitly so net revenue, withheld IVA and gross customer spend are three
separate values. Immutable closed history is read as stored; migration 037
appends corrected RESTATED versions rather than rewriting prior closes.

Cash is a separate contract. The latest Amazon settlement is reconstructed from
raw settlement lines and reconciled to Amazon's settlement total. It is shown as
cash timing, never as business-period revenue or contribution.
"""

from finance_api_legacy import finance_payload as _legacy_finance_payload


def _policy(connect, marketplace: str) -> dict:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT standard_vat_rate,sales_traffic_amount_basis
               FROM core.marketplace_tax_policy WHERE marketplace_id=%s""",
            (marketplace,),
        )
        return cur.fetchone() or {}


def _derive_finance_sales(row: dict, rate: float) -> None:
    """Convert the legacy OPEN/finalizing raw report amount from gross to Finance basis."""
    if not row:
        return
    gross = round(float(row.get("net_sales_ex_vat") or 0), 2)
    net = round(gross / (1.0 + rate), 2) if rate > 0 else gross
    iva = round(gross - net, 2)
    row["net_sales_ex_vat"] = net
    row["iva_on_sales"] = iva
    row["shopper_product_spend"] = gross
    if row.get("amazon_order_net") is not None:
        row["amazon_order_effect"] = round(float(row.get("amazon_order_net") or 0) - net, 2)
    if row.get("contribution_after_product_cogs") is not None:
        contribution = float(row.get("contribution_after_product_cogs") or 0)
        row["contribution_margin_pct"] = round(100.0 * contribution / net, 1) if net else None
    row["sales_source_basis"] = "SHOPPER_SPEND_INCL_TAX"
    row["finance_revenue_basis"] = "NET_SALES_EX_TAX"


def _latest_cash_bridge(connect, marketplace: str) -> dict:
    """Return one settlement-id cash identity using deliberately broad buckets.

    We do not need to pretend every Amazon fee subtype is perfectly classified to
    prove cash. Customer activity, withheld tax and settlement advertising are
    recognized explicitly; every remaining signed line is retained in either
    other deductions or other additions. The signed sum must reconcile to the
    settlement report total before the bridge is marked RECONCILED.
    """
    with connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            WITH latest AS (
              SELECT settlement_id,
                     min(settlement_start_date) AS settlement_start_date,
                     max(settlement_end_date) AS settlement_end_date,
                     max(deposit_date) AS deposit_date,
                     max(currency) AS currency,
                     max(total_amount) AS report_total
              FROM core.settlement_line
              WHERE marketplace_id=%s AND settlement_id IS NOT NULL
              GROUP BY settlement_id
              ORDER BY COALESCE(max(deposit_date),max(settlement_end_date),min(settlement_start_date)) DESC NULLS LAST,
                       settlement_id DESC
              LIMIT 1
            ), classified AS (
              SELECT l.*,
                     lower(COALESCE(l.amount_type,'')) AS at,
                     lower(COALESCE(l.amount_description,'')) AS ad
              FROM core.settlement_line l
              JOIN latest x USING(settlement_id)
              WHERE l.marketplace_id=%s
            ), agg AS (
              SELECT
                COALESCE(sum(amount),0)::numeric(16,2) AS line_sum,
                COALESCE(sum(amount) FILTER (
                  WHERE at='itemprice' AND ad='principal'
                ),0)::numeric(16,2) AS customer_principal,
                COALESCE(sum(amount) FILTER (
                  WHERE at='itemprice' AND ad LIKE '%%tax%%'
                ),0)::numeric(16,2) AS customer_tax,
                COALESCE(sum(amount) FILTER (
                  WHERE at='itemwithheldtax' OR ad LIKE '%%withheld%%tax%%'
                ),0)::numeric(16,2) AS tax_withheld,
                COALESCE(sum(amount) FILTER (
                  WHERE at='cost of advertising' OR ad LIKE '%%advertis%%'
                ),0)::numeric(16,2) AS advertising,
                COALESCE(sum(amount) FILTER (
                  WHERE NOT (at='itemprice' AND (ad='principal' OR ad LIKE '%%tax%%'))
                    AND NOT (at='itemwithheldtax' OR ad LIKE '%%withheld%%tax%%')
                    AND NOT (at='cost of advertising' OR ad LIKE '%%advertis%%')
                    AND amount < 0
                ),0)::numeric(16,2) AS other_deductions,
                COALESCE(sum(amount) FILTER (
                  WHERE NOT (at='itemprice' AND (ad='principal' OR ad LIKE '%%tax%%'))
                    AND NOT (at='itemwithheldtax' OR ad LIKE '%%withheld%%tax%%')
                    AND NOT (at='cost of advertising' OR ad LIKE '%%advertis%%')
                    AND amount > 0
                ),0)::numeric(16,2) AS other_additions,
                count(*)::int AS line_count
              FROM classified
            )
            SELECT x.*,a.*
            FROM latest x CROSS JOIN agg a
            """,
            (marketplace, marketplace),
        )
        row = cur.fetchone() or {}

    if not row or not row.get("settlement_id"):
        return {
            "status": "NO_DATA",
            "basis": "AMAZON_SETTLEMENT_REPORT",
            "note": "No settlement report is available yet.",
        }

    principal = round(float(row.get("customer_principal") or 0), 2)
    customer_tax = round(float(row.get("customer_tax") or 0), 2)
    customer_activity = round(principal + customer_tax, 2)
    tax_withheld = round(float(row.get("tax_withheld") or 0), 2)
    advertising = round(float(row.get("advertising") or 0), 2)
    other_deductions = round(float(row.get("other_deductions") or 0), 2)
    other_additions = round(float(row.get("other_additions") or 0), 2)
    line_sum = round(float(row.get("line_sum") or 0), 2)
    report_total = row.get("report_total")
    payout = round(float(report_total if report_total is not None else line_sum), 2)
    delta = round(line_sum - payout, 2)
    status = "RECONCILED" if abs(delta) <= 0.02 else "UNRECONCILED"

    return {
        "status": status,
        "basis": "AMAZON_SETTLEMENT_REPORT",
        "settlement_id": row.get("settlement_id"),
        "settlement_start_date": row.get("settlement_start_date"),
        "settlement_end_date": row.get("settlement_end_date"),
        "deposit_date": row.get("deposit_date"),
        "currency": row.get("currency"),
        "customer_principal": principal,
        "customer_tax": customer_tax,
        "customer_activity_incl_tax": customer_activity,
        "tax_withheld": tax_withheld,
        "advertising": advertising,
        "other_deductions": other_deductions,
        "other_additions": other_additions,
        "line_sum": line_sum,
        "payout": payout,
        "reconciliation_delta": delta,
        "line_count": int(row.get("line_count") or 0),
        "classification": "BROAD_RECONCILED_BUCKETS",
        "note": (
            "Cash settlement identity, not business-period P&L. Customer activity is net of any refunds present in this settlement. "
            "Detailed selling/FBA fee subtypes remain grouped until separately validated."
        ),
    }


def finance_payload(connect, marketplace: str) -> dict:
    payload = _legacy_finance_payload(connect, marketplace)
    policy = _policy(connect, marketplace)
    rate = float(policy.get("standard_vat_rate") or 0)
    source_basis = policy.get("sales_traffic_amount_basis") or "UNKNOWN"

    if source_basis == "SHOPPER_SPEND_INCL_TAX":
        _derive_finance_sales(payload.get("current_month") or {}, rate)
        for row in payload.get("finalizing_months") or []:
            _derive_finance_sales(row, rate)

    payload["cash_bridge"] = _latest_cash_bridge(connect, marketplace)
    payload["metric_basis"] = {
        "sales_traffic_source": "Amazon Sales & Traffic orderedProductSales",
        "sales_traffic_amount_basis": source_basis,
        "standard_vat_rate": rate,
        "finance_net_sales": "Gross Sales & Traffic shopper spend / (1 + VAT rate)",
        "iva_withheld": "Gross shopper spend - net sales ex IVA",
        "gross_customer_spend": "Amazon Sales & Traffic shopper spend including IVA",
        "payout": "Amazon settlement cash after withheld tax and signed settlement deductions/additions; never revenue",
        "cash_bridge": "Latest settlement-id signed line sum reconciled to Amazon settlement report total",
    }
    return payload
