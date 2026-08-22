from __future__ import annotations

import json
from decimal import Decimal

from . import db
from .settings import settings


def _f(value) -> float:
    return round(float(value or 0), 2)


def main() -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT m.timezone,m.currency,p.standard_vat_rate
               FROM core.marketplace m
               LEFT JOIN core.marketplace_tax_policy p USING(marketplace_id)
               WHERE m.marketplace_id=%s""",
            (settings.marketplace_id,),
        )
        market = cur.fetchone() or {}
        vat = float(market.get("standard_vat_rate") or 0)

        cur.execute(
            """SELECT max(business_date) AS d
               FROM mart.business_daily
               WHERE marketplace_id=%s AND reconciled_daily_report""",
            (settings.marketplace_id,),
        )
        cutoff = (cur.fetchone() or {}).get("d")

        cur.execute(
            """
            WITH report AS (
              SELECT business_date,
                     sales::numeric(14,2) AS report_sales,
                     units::bigint AS report_units
              FROM mart.business_daily
              WHERE marketplace_id=%s
                AND reconciled_daily_report
                AND business_date BETWEEN %s::date-27 AND %s::date
            ), orders AS (
              SELECT business_date,
                     COALESCE(sum(customer_spend),0)::numeric(14,2) AS shopper_spend_incl_iva,
                     COALESCE(sum(units),0)::bigint AS order_units
              FROM mart.order_item_customer_spend
              WHERE marketplace_id=%s
                AND business_date BETWEEN %s::date-27 AND %s::date
              GROUP BY business_date
            )
            SELECT r.business_date,r.report_sales,r.report_units,
                   COALESCE(o.shopper_spend_incl_iva,0)::numeric(14,2) AS shopper_spend_incl_iva,
                   COALESCE(o.order_units,0)::bigint AS order_units,
                   CASE WHEN %s::numeric>0
                        THEN round(COALESCE(o.shopper_spend_incl_iva,0)/(1+%s::numeric),2)
                        ELSE COALESCE(o.shopper_spend_incl_iva,0) END AS shopper_spend_ex_iva,
                   (r.report_units=COALESCE(o.order_units,0)) AS unit_match
            FROM report r
            LEFT JOIN orders o USING(business_date)
            ORDER BY r.business_date
            """,
            (settings.marketplace_id, cutoff, cutoff, settings.marketplace_id, cutoff, cutoff, vat, vat),
        )
        days = list(cur.fetchall())

    matched = [r for r in days if r.get("unit_match") and int(r.get("report_units") or 0) > 0]
    report_total = sum(_f(r.get("report_sales")) for r in matched)
    gross_total = sum(_f(r.get("shopper_spend_incl_iva")) for r in matched)
    net_total = sum(_f(r.get("shopper_spend_ex_iva")) for r in matched)
    diff_gross = abs(report_total - gross_total)
    diff_net = abs(report_total - net_total)
    if not matched:
        classification = "INSUFFICIENT_MATCHED_DAYS"
    elif diff_net + 0.02 < diff_gross:
        classification = "REPORT_CLOSEST_TO_EX_IVA"
    elif diff_gross + 0.02 < diff_net:
        classification = "REPORT_CLOSEST_TO_SHOPPER_SPEND_INCL_IVA"
    else:
        classification = "AMBIGUOUS"

    payload = {
        "marketplace": settings.marketplace_id,
        "currency": market.get("currency"),
        "vat_rate": vat,
        "cutoff": str(cutoff) if cutoff else None,
        "classification": classification,
        "matched_days": len(matched),
        "matched_report_sales": round(report_total, 2),
        "matched_shopper_spend_incl_iva": round(gross_total, 2),
        "matched_shopper_spend_ex_iva": round(net_total, 2),
        "difference_to_gross": round(diff_gross, 2),
        "difference_to_ex_iva": round(diff_net, 2),
        "days": [
            {
                "date": str(r.get("business_date")),
                "report_sales": _f(r.get("report_sales")),
                "report_units": int(r.get("report_units") or 0),
                "shopper_spend_incl_iva": _f(r.get("shopper_spend_incl_iva")),
                "shopper_spend_ex_iva": _f(r.get("shopper_spend_ex_iva")),
                "order_units": int(r.get("order_units") or 0),
                "unit_match": bool(r.get("unit_match")),
            }
            for r in days
        ],
    }
    print(json.dumps(payload, indent=2, sort_keys=True, default=str))


if __name__ == "__main__":
    main()
