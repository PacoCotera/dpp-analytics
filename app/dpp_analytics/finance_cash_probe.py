from __future__ import annotations

import json

from . import db
from .settings import settings


def _money(value) -> float:
    return round(float(value or 0), 2)


def probe() -> dict:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """SELECT count(*)::int AS rows,
                      count(DISTINCT settlement_id)::int AS settlements,
                      min(posted_date_time) AS first_posted,
                      max(posted_date_time) AS last_posted
               FROM core.settlement_line
               WHERE marketplace_id=%s""",
            (settings.marketplace_id,),
        )
        coverage = cur.fetchone() or {}

        cur.execute(
            """SELECT finance_category,amount_type,amount_description,
                      count(*)::int AS rows,
                      COALESCE(sum(amount),0)::numeric(16,2) AS amount
               FROM mart.settlement_finance_line
               WHERE marketplace_id=%s
               GROUP BY finance_category,amount_type,amount_description
               ORDER BY abs(sum(amount)) DESC,finance_category,amount_type,amount_description""",
            (settings.marketplace_id,),
        )
        classifications = list(cur.fetchall())

        cur.execute(
            """WITH s AS (
                 SELECT settlement_id,
                        min(settlement_start_date) AS settlement_start_date,
                        max(settlement_end_date) AS settlement_end_date,
                        max(deposit_date) AS deposit_date,
                        min(total_amount) AS min_report_total,
                        max(total_amount) AS max_report_total,
                        COALESCE(sum(amount),0)::numeric(16,2) AS line_sum,
                        count(*)::int AS rows
                 FROM core.settlement_line
                 WHERE marketplace_id=%s AND settlement_id IS NOT NULL
                 GROUP BY settlement_id
               )
               SELECT * FROM s
               ORDER BY COALESCE(deposit_date,settlement_end_date,settlement_start_date) DESC NULLS LAST
               LIMIT 12""",
            (settings.marketplace_id,),
        )
        settlements = list(cur.fetchall())

        latest_ids = [row.get("settlement_id") for row in settlements if row.get("settlement_id")][:5]
        latest_breakdowns = []
        if latest_ids:
            cur.execute(
                """SELECT settlement_id,finance_category,
                          count(*)::int AS rows,
                          COALESCE(sum(amount),0)::numeric(16,2) AS amount
                   FROM mart.settlement_finance_line
                   WHERE marketplace_id=%s AND settlement_id = ANY(%s)
                   GROUP BY settlement_id,finance_category
                   ORDER BY settlement_id,finance_category""",
                (settings.marketplace_id, latest_ids),
            )
            latest_breakdowns = list(cur.fetchall())

        cur.execute(
            """SELECT amount_type,amount_description,count(*)::int AS rows,
                      COALESCE(sum(amount),0)::numeric(16,2) AS amount
               FROM mart.settlement_finance_line
               WHERE marketplace_id=%s AND finance_category='other'
               GROUP BY amount_type,amount_description
               ORDER BY abs(sum(amount)) DESC,amount_type,amount_description""",
            (settings.marketplace_id,),
        )
        unclassified = list(cur.fetchall())

    settlement_checks = []
    for row in settlements:
        report_total_min = _money(row.get("min_report_total"))
        report_total_max = _money(row.get("max_report_total"))
        line_sum = _money(row.get("line_sum"))
        stable_report_total = abs(report_total_max - report_total_min) <= 0.02
        matches = stable_report_total and abs(line_sum - report_total_max) <= 0.02
        settlement_checks.append({
            **row,
            "line_sum": line_sum,
            "min_report_total": report_total_min,
            "max_report_total": report_total_max,
            "stable_report_total": stable_report_total,
            "line_sum_matches_report_total": matches,
        })

    category_totals: dict[str, float] = {}
    for row in classifications:
        category = str(row.get("finance_category") or "other")
        category_totals[category] = round(category_totals.get(category, 0.0) + _money(row.get("amount")), 2)

    return {
        "marketplace": settings.marketplace_id,
        "coverage": coverage,
        "category_totals": category_totals,
        "classifications": classifications,
        "recent_settlements": settlement_checks,
        "recent_category_breakdowns": latest_breakdowns,
        "unclassified": unclassified,
        "summary": {
            "settlement_rows": int(coverage.get("rows") or 0),
            "settlements": int(coverage.get("settlements") or 0),
            "recent_settlements_checked": len(settlement_checks),
            "recent_settlements_reconcile": sum(1 for row in settlement_checks if row["line_sum_matches_report_total"]),
            "unclassified_rows": sum(int(row.get("rows") or 0) for row in unclassified),
            "unclassified_amount": round(sum(_money(row.get("amount")) for row in unclassified), 2),
        },
    }


def main() -> None:
    print(json.dumps(probe(), default=str, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
