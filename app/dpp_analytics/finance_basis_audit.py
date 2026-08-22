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
