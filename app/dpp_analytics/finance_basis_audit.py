from __future__ import annotations

import argparse
import json
from datetime import date

import httpx

from . import db
from .settings import settings


def _money(value) -> float:
    return round(float(value or 0), 2)


def _close(a, b, tolerance: float = 0.02) -> bool:
    return abs(float(a or 0) - float(b or 0)) <= tolerance


def _month(value) -> date:
    return date.fromisoformat(str(value)[:10]).replace(day=1)


def _next_month(value: date) -> date:
    return date(value.year + (1 if value.month == 12 else 0), 1 if value.month == 12 else value.month + 1, 1)


def _report_gross(cur, marketplace: str, month: date) -> float:
    cur.execute(
        """SELECT COALESCE(sum(sales),0)::numeric(16,2) AS gross
           FROM mart.business_daily
           WHERE marketplace_id=%s AND reconciled_daily_report
             AND business_date >= %s::date AND business_date < %s::date""",
        (marketplace, month, _next_month(month)),
    )
    return _money((cur.fetchone() or {}).get("gross"))


def _latest_settlement_bridge(cur, marketplace: str) -> dict:
    """Recompute the API's broad cash buckets directly from raw settlement lines."""
    cur.execute(
        """
        WITH latest AS (
          SELECT settlement_id,
                 max(total_amount) AS report_total,
                 max(currency) AS currency
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
        )
        SELECT
          x.settlement_id,x.report_total,x.currency,
          COALESCE(sum(c.amount),0)::numeric(16,2) AS line_sum,
          COALESCE(sum(c.amount) FILTER (WHERE c.at='itemprice' AND c.ad='principal'),0)::numeric(16,2) AS customer_principal,
          COALESCE(sum(c.amount) FILTER (WHERE c.at='itemprice' AND c.ad LIKE '%%tax%%'),0)::numeric(16,2) AS customer_tax,
          COALESCE(sum(c.amount) FILTER (WHERE c.at='itemwithheldtax' OR c.ad LIKE '%%withheld%%tax%%'),0)::numeric(16,2) AS tax_withheld,
          COALESCE(sum(c.amount) FILTER (WHERE c.at='cost of advertising' OR c.ad LIKE '%%advertis%%'),0)::numeric(16,2) AS advertising,
          COALESCE(sum(c.amount) FILTER (
            WHERE NOT (c.at='itemprice' AND (c.ad='principal' OR c.ad LIKE '%%tax%%'))
              AND NOT (c.at='itemwithheldtax' OR c.ad LIKE '%%withheld%%tax%%')
              AND NOT (c.at='cost of advertising' OR c.ad LIKE '%%advertis%%')
              AND c.amount < 0
          ),0)::numeric(16,2) AS other_deductions,
          COALESCE(sum(c.amount) FILTER (
            WHERE NOT (c.at='itemprice' AND (c.ad='principal' OR c.ad LIKE '%%tax%%'))
              AND NOT (c.at='itemwithheldtax' OR c.ad LIKE '%%withheld%%tax%%')
              AND NOT (c.at='cost of advertising' OR c.ad LIKE '%%advertis%%')
              AND c.amount > 0
          ),0)::numeric(16,2) AS other_additions,
          count(c.*)::int AS line_count
        FROM latest x LEFT JOIN classified c USING(settlement_id)
        GROUP BY x.settlement_id,x.report_total,x.currency
        """,
        (marketplace, marketplace),
    )
    row = cur.fetchone() or {}
    if not row.get("settlement_id"):
        return {}
    principal = _money(row.get("customer_principal"))
    tax = _money(row.get("customer_tax"))
    return {
        "settlement_id": row.get("settlement_id"),
        "currency": row.get("currency"),
        "customer_activity_incl_tax": round(principal + tax, 2),
        "tax_withheld": _money(row.get("tax_withheld")),
        "advertising": _money(row.get("advertising")),
        "other_deductions": _money(row.get("other_deductions")),
        "other_additions": _money(row.get("other_additions")),
        "line_sum": _money(row.get("line_sum")),
        "payout": _money(row.get("report_total") if row.get("report_total") is not None else row.get("line_sum")),
        "line_count": int(row.get("line_count") or 0),
    }


def audit(board_url: str) -> dict:
    failures: list[str] = []
    evidence: dict[str, object] = {}

    with httpx.Client(base_url=board_url.rstrip("/"), timeout=20) as client:
        response = client.get("/api/finance")
        response.raise_for_status()
        finance = response.json()

    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT m.currency,p.standard_vat_rate,p.sales_traffic_amount_basis
               FROM core.marketplace m
               LEFT JOIN core.marketplace_tax_policy p USING(marketplace_id)
               WHERE m.marketplace_id=%s""",
            (settings.marketplace_id,),
        )
        policy = cur.fetchone() or {}
        vat_rate = float(policy.get("standard_vat_rate") or 0)
        source_basis = str(policy.get("sales_traffic_amount_basis") or "UNKNOWN")
        evidence["marketplace_policy"] = policy

        if source_basis != "SHOPPER_SPEND_INCL_TAX":
            failures.append(f"marketplace Sales & Traffic basis is {source_basis}, expected SHOPPER_SPEND_INCL_TAX")

        periods: list[tuple[str, dict]] = []
        current = finance.get("current_month") or {}
        if current:
            periods.append(("OPEN", current))
        periods.extend((str(row.get("month") or ""), row) for row in finance.get("finalizing_months") or [])

        source_periods = []
        for label, row in periods:
            month_value = _month(row.get("month"))
            gross = _report_gross(cur, settings.marketplace_id, month_value)
            expected_net = round(gross / (1.0 + vat_rate), 2) if vat_rate > 0 else gross
            expected_iva = round(gross - expected_net, 2)
            source_periods.append(
                {
                    "label": label,
                    "month": str(month_value),
                    "sales_traffic_gross": gross,
                    "expected_net_ex_iva": expected_net,
                    "expected_iva": expected_iva,
                    "api_gross": _money(row.get("shopper_product_spend")),
                    "api_net_ex_iva": _money(row.get("net_sales_ex_vat")),
                    "api_iva": _money(row.get("iva_on_sales")),
                }
            )
            if not _close(row.get("shopper_product_spend"), gross):
                failures.append(f"Finance {label}: gross customer spend != Sales & Traffic gross ({_money(row.get('shopper_product_spend'))} != {gross})")
            if not _close(row.get("net_sales_ex_vat"), expected_net):
                failures.append(f"Finance {label}: net sales ex IVA != gross/(1+IVA) ({_money(row.get('net_sales_ex_vat'))} != {expected_net})")
            if not _close(row.get("iva_on_sales"), expected_iva):
                failures.append(f"Finance {label}: IVA != gross-net ({_money(row.get('iva_on_sales'))} != {expected_iva})")
        evidence["open_and_finalizing_source_reconciliation"] = source_periods

        cur.execute(
            """SELECT month,version,state,restatement_reason,
                      net_sales_ex_vat,iva_on_sales,shopper_product_spend,
                      close_basis->>'sales_tax_basis' AS sales_tax_basis,
                      close_basis->>'sales_traffic_amount_basis' AS stored_source_basis
               FROM mart.finance_month_close_latest
               WHERE marketplace_id=%s
               ORDER BY month""",
            (settings.marketplace_id,),
        )
        closed_rows = list(cur.fetchall())
        evidence["latest_closed_versions"] = closed_rows

        cash_db = _latest_settlement_bridge(cur, settings.marketplace_id)
        evidence["latest_settlement_cash_db"] = cash_db

    closed_api = {str(row.get("month") or "")[:10]: row for row in finance.get("closed_months") or []}
    for row in closed_rows:
        month_key = str(row.get("month") or "")[:10]
        if row.get("sales_tax_basis") != "SHOPPER_SPEND_INCL_VAT_SOURCE":
            failures.append(f"Finance {month_key}: latest immutable close lacks corrected gross Sales & Traffic tax-basis marker")
        gross = _money(row.get("shopper_product_spend"))
        expected_net = round(gross / (1.0 + vat_rate), 2) if vat_rate > 0 else gross
        expected_iva = round(gross - expected_net, 2)
        if not _close(row.get("net_sales_ex_vat"), expected_net):
            failures.append(f"Finance {month_key}: closed net sales ex IVA does not derive from stored gross")
        if not _close(row.get("iva_on_sales"), expected_iva):
            failures.append(f"Finance {month_key}: closed IVA does not equal gross-net")
        if str(row.get("state") or "") == "RESTATED" and not str(row.get("restatement_reason") or "").strip():
            failures.append(f"Finance {month_key}: RESTATED close has no audit reason")
        api_row = closed_api.get(month_key)
        if not api_row:
            failures.append(f"Finance {month_key}: latest immutable close missing from Finance API")
            continue
        for key in ("net_sales_ex_vat", "iva_on_sales", "shopper_product_spend"):
            if not _close(api_row.get(key), row.get(key)):
                failures.append(f"Finance {month_key}: API {key} != latest immutable close")

    metric_basis = finance.get("metric_basis") or {}
    if str(metric_basis.get("sales_traffic_amount_basis") or "") != source_basis:
        failures.append("Finance API metric_basis does not expose the marketplace Sales & Traffic tax basis")
    if not _close(metric_basis.get("standard_vat_rate"), vat_rate, 0.000001):
        failures.append("Finance API metric_basis VAT rate != marketplace tax policy")

    cash_api = finance.get("cash_bridge") or {}
    if cash_db:
        if cash_api.get("status") != "RECONCILED":
            failures.append(f"Finance cash bridge is {cash_api.get('status')}, expected RECONCILED")
        if cash_api.get("basis") != "AMAZON_SETTLEMENT_REPORT":
            failures.append("Finance cash bridge basis is not AMAZON_SETTLEMENT_REPORT")
        if str(cash_api.get("settlement_id") or "") != str(cash_db.get("settlement_id") or ""):
            failures.append("Finance cash bridge does not use latest settlement id")
        for key in (
            "customer_activity_incl_tax",
            "tax_withheld",
            "advertising",
            "other_deductions",
            "other_additions",
            "line_sum",
            "payout",
        ):
            if not _close(cash_api.get(key), cash_db.get(key)):
                failures.append(f"Finance cash bridge API {key} != raw settlement calculation")
        if int(cash_api.get("line_count") or 0) != int(cash_db.get("line_count") or 0):
            failures.append("Finance cash bridge line count != raw settlement")
        if not _close(cash_db.get("line_sum"), cash_db.get("payout")):
            failures.append(
                f"Latest Amazon settlement does not reconcile: signed lines {_money(cash_db.get('line_sum'))} != report payout {_money(cash_db.get('payout'))}"
            )
        bridge_sum = round(
            _money(cash_api.get("customer_activity_incl_tax"))
            + _money(cash_api.get("tax_withheld"))
            + _money(cash_api.get("advertising"))
            + _money(cash_api.get("other_deductions"))
            + _money(cash_api.get("other_additions")),
            2,
        )
        if not _close(bridge_sum, cash_api.get("payout")):
            failures.append(f"Finance cash bridge arithmetic {bridge_sum} != payout {_money(cash_api.get('payout'))}")
    elif cash_api.get("status") not in (None, "NO_DATA"):
        failures.append("Finance API exposes settlement cash despite no raw settlement data")

    return {
        "status": "PASS" if not failures else "FAIL",
        "marketplace": settings.marketplace_id,
        "failures": failures,
        "evidence": evidence,
        "summary": {
            "sales_traffic_amount_basis": source_basis,
            "vat_rate": vat_rate,
            "open_gross": _money(current.get("shopper_product_spend")) if current else None,
            "open_net_ex_iva": _money(current.get("net_sales_ex_vat")) if current else None,
            "open_iva": _money(current.get("iva_on_sales")) if current else None,
            "latest_closed_months": len(closed_rows),
            "restated_latest_months": sum(1 for row in closed_rows if str(row.get("state") or "") == "RESTATED"),
            "latest_settlement": cash_db.get("settlement_id") if cash_db else None,
            "latest_settlement_payout": cash_db.get("payout") if cash_db else None,
            "latest_settlement_reconciled": bool(cash_db and _close(cash_db.get("line_sum"), cash_db.get("payout"))),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--board-url", default="http://board:8080")
    args = parser.parse_args()
    result = audit(args.board_url)
    print(json.dumps(result, default=str, indent=2, sort_keys=True))
    if result["status"] != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
