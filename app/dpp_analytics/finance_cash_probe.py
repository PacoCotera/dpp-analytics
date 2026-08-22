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
                      count(DISTINCT report_id)::int AS reports,
                      min(posted_date_time) AS first_posted,
                      max(posted_date_time) AS last_posted
               FROM core.settlement_line
               WHERE marketplace_id=%s""",
            (settings.marketplace_id,),
        )
        raw_coverage = cur.fetchone() or {}

        cur.execute(
            """SELECT count(*)::int AS rows,
                      count(DISTINCT settlement_id)::int AS settlements,
                      count(DISTINCT report_id)::int AS selected_reports,
                      min(posted_date_time) AS first_posted,
                      max(posted_date_time) AS last_posted
               FROM mart.settlement_line_canonical
               WHERE marketplace_id=%s""",
            (settings.marketplace_id,),
        )
        canonical_coverage = cur.fetchone() or {}

        cur.execute(
            """SELECT finance_category,amount_type,amount_description,
                      count(*)::int AS rows,
                      COALESCE(sum(amount),0)::numeric(16,2) AS amount
               FROM mart.settlement_finance_line_canonical
               WHERE marketplace_id=%s
               GROUP BY finance_category,amount_type,amount_description
               ORDER BY abs(sum(amount)) DESC,finance_category,amount_type,amount_description""",
            (settings.marketplace_id,),
        )
        classifications = list(cur.fetchall())

        cur.execute(
            """SELECT settlement_id,report_id,report_versions,
                      settlement_start_date,settlement_end_date,deposit_date,
                      min_report_total,max_report_total,line_sum,line_count AS rows,
                      is_reconciled
               FROM mart.settlement_canonical_report
               WHERE marketplace_id=%s
               ORDER BY COALESCE(deposit_date,settlement_end_date,settlement_start_date) DESC NULLS LAST,
                        settlement_id DESC
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
                   FROM mart.settlement_finance_line_canonical
                   WHERE marketplace_id=%s AND settlement_id = ANY(%s)
                   GROUP BY settlement_id,finance_category
                   ORDER BY settlement_id,finance_category""",
                (settings.marketplace_id, latest_ids),
            )
            latest_breakdowns = list(cur.fetchall())

        cur.execute(
            """SELECT settlement_id,report_id,report_versions,is_reconciled,
                      min_report_total,max_report_total,line_sum,line_count,
                      created_time,processing_end_time,fetched_at,canonical_rank
               FROM mart.settlement_report_candidate
               WHERE marketplace_id=%s AND report_versions > 1
               ORDER BY settlement_id DESC,canonical_rank,processing_end_time DESC NULLS LAST,
                        created_time DESC NULLS LAST,report_id DESC
               LIMIT 50""",
            (settings.marketplace_id,),
        )
        duplicate_report_evidence = list(cur.fetchall())

        cur.execute(
            """SELECT amount_type,amount_description,count(*)::int AS rows,
                      COALESCE(sum(amount),0)::numeric(16,2) AS amount
               FROM mart.settlement_finance_line_canonical
               WHERE marketplace_id=%s AND finance_category='other'
               GROUP BY amount_type,amount_description
               ORDER BY abs(sum(amount)) DESC,amount_type,amount_description""",
            (settings.marketplace_id,),
        )
        unclassified = list(cur.fetchall())

    settlement_checks = []
    failures: list[str] = []
    for row in settlements:
        report_total_min = _money(row.get("min_report_total"))
        report_total_max = _money(row.get("max_report_total"))
        line_sum = _money(row.get("line_sum"))
        stable_report_total = abs(report_total_max - report_total_min) <= 0.02
        matches = bool(row.get("is_reconciled")) and stable_report_total and abs(line_sum - report_total_max) <= 0.02
        check = {
            **row,
            "line_sum": line_sum,
            "min_report_total": report_total_min,
            "max_report_total": report_total_max,
            "stable_report_total": stable_report_total,
            "line_sum_matches_report_total": matches,
        }
        settlement_checks.append(check)
        if not matches:
            failures.append(
                f"Settlement {row.get('settlement_id')} canonical report {row.get('report_id')} does not reconcile: "
                f"signed lines {line_sum} vs Amazon total {report_total_max}"
            )

    category_totals: dict[str, float] = {}
    for row in classifications:
        category = str(row.get("finance_category") or "other")
        category_totals[category] = round(category_totals.get(category, 0.0) + _money(row.get("amount")), 2)

    duplicate_settlements = len({str(row.get("settlement_id")) for row in duplicate_report_evidence if row.get("settlement_id")})
    raw_reports = int(raw_coverage.get("reports") or 0)
    selected_reports = int(canonical_coverage.get("selected_reports") or 0)

    return {
        "status": "PASS" if not failures else "FAIL",
        "marketplace": settings.marketplace_id,
        "failures": failures,
        "raw_coverage": raw_coverage,
        "canonical_coverage": canonical_coverage,
        "report_selection": "ONE_CANONICAL_RECONCILED_REPORT_PER_SETTLEMENT",
        "category_totals": category_totals,
        "classifications": classifications,
        "recent_settlements": settlement_checks,
        "recent_category_breakdowns": latest_breakdowns,
        "duplicate_report_evidence": duplicate_report_evidence,
        "unclassified": unclassified,
        "summary": {
            "raw_settlement_rows": int(raw_coverage.get("rows") or 0),
            "canonical_settlement_rows": int(canonical_coverage.get("rows") or 0),
            "settlements": int(canonical_coverage.get("settlements") or 0),
            "raw_reports": raw_reports,
            "selected_reports": selected_reports,
            "duplicate_report_copies_excluded": max(raw_reports - selected_reports, 0),
            "settlements_with_multiple_report_versions_in_evidence": duplicate_settlements,
            "recent_settlements_checked": len(settlement_checks),
            "recent_settlements_reconcile": sum(1 for row in settlement_checks if row["line_sum_matches_report_total"]),
            "recent_settlements_unreconciled": sum(1 for row in settlement_checks if not row["line_sum_matches_report_total"]),
            "unclassified_rows": sum(int(row.get("rows") or 0) for row in unclassified),
            "unclassified_amount": round(sum(_money(row.get("amount")) for row in unclassified), 2),
        },
    }


def main() -> None:
    result = probe()
    print(json.dumps(result, default=str, indent=2, sort_keys=True))
    if result["status"] != "PASS":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
