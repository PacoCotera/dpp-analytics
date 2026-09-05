from __future__ import annotations

from datetime import date, datetime, timezone
import json
import os
import re
from typing import Any

from ads_shadow_rules import (
    SHADOW_RULE_VERSIONS,
    data_blocker_candidate,
    evaluate_product_shadow_candidates,
)
from decision_contract import finalize_candidate
from decision_store import persist_candidate


MARKETPLACE = os.getenv("SPAPI_MARKETPLACE_ID", "A1AM78C64UM0Y8")


def connect():
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(
        host=os.getenv("DB_HOST", "postgres"),
        port=int(os.getenv("DB_PORT", "5432")),
        dbname=os.environ["POSTGRES_DB"],
        user=os.environ["POSTGRES_USER"],
        password=os.environ["POSTGRES_PASSWORD"],
        row_factory=dict_row,
    )


def _lookback_days(value: Any) -> int:
    match = re.search(r"(\d+)\s*d", str(value or ""), re.IGNORECASE)
    return max(0, int(match.group(1))) if match else 7


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return str(value)


def _load_replay_facts(cur, marketplace_id: str, *, now: datetime) -> dict[str, Any]:
    cur.execute(
        """
        SELECT marketplace_id,through_date,period_start,observed_ads_days,
               expected_ads_days,missing_ads_days,ads_ingested_at
        FROM mart.ads_business_t28
        WHERE marketplace_id=%s
        """,
        (marketplace_id,),
    )
    summary = cur.fetchone()
    if not summary:
        day = now.date().isoformat()
        return {
            "window": {
                "id": "CURRENT_SOURCE_STATE",
                "start": day,
                "through": day,
                "state": "UNAVAILABLE",
                "cutoff": now,
                "currency": "MXN",
            },
            "source": {
                "marketplace_id": marketplace_id,
                "source_key": "amazon_ads",
                "label": "Amazon Ads",
                "trusted": False,
                "state": "NO_STORED_WINDOW",
                "reason": "No stored Advertising operating window is available.",
                "cutoff": now,
            },
            "products": [],
        }

    through = summary["through_date"]
    cur.execute(
        """
        SELECT count(DISTINCT account_id)::int AS accounts_seen,
               count(*) FILTER (WHERE quality_state<>'OK')::int AS issue_account_days,
               max(latest_ingested_at) AS latest_ingested_at
        FROM mart.ads_ingestion_quality
        WHERE marketplace_id=%s AND business_date BETWEEN %s::date-27 AND %s::date
        """,
        (marketplace_id, through, through),
    )
    quality = cur.fetchone() or {}
    complete = (
        int(summary.get("missing_ads_days") or 0) == 0
        and int(summary.get("observed_ads_days") or 0) >= int(summary.get("expected_ads_days") or 28)
    )
    trusted = bool(
        int(quality.get("accounts_seen") or 0) > 0
        and int(quality.get("issue_account_days") or 0) == 0
        and complete
    )
    state = "HEALTHY" if trusted else (
        "INCOMPLETE_WINDOW" if not complete else "RECONCILIATION_FAILED"
    )
    cutoff = quality.get("latest_ingested_at") or summary.get("ads_ingested_at") or now
    cur.execute(
        """
        SELECT max(attribution_window) FILTER (WHERE business_date=%s::date) AS attribution_window
        FROM mart.ads_business_daily
        WHERE marketplace_id=%s AND business_date BETWEEN %s::date-27 AND %s::date
        """,
        (through, marketplace_id, through, through),
    )
    attribution = cur.fetchone() or {}
    lookback_days = _lookback_days(attribution.get("attribution_window"))
    cur.execute(
        """
        SELECT p.marketplace_id,p.sku,p.asin,
               COALESCE(c.title,p.sku,p.asin) AS product,
               COALESCE(c.is_offer_owner,false) AS is_offer_owner,
               c.catalog_membership,c.status,c.inventory_action,c.available,c.inbound,
               c.days_cover_with_inbound,c.sessions_t28,
               p.spend,p.clicks,p.attributed_purchases,p.observed_ads_days,p.mature_ads_days,
               %s::int AS attribution_lookback_days,%s::boolean AS ads_trusted
        FROM mart.ads_product_business_t28 p
        LEFT JOIN mart.catalog_portfolio_product c
          ON c.marketplace_id=p.marketplace_id AND c.seller_sku=p.sku
        WHERE p.marketplace_id=%s
        ORDER BY p.spend DESC,p.sku,p.asin
        """,
        (lookback_days, trusted, marketplace_id),
    )
    products = list(cur.fetchall())
    return {
        "window": {
            "id": "ADS_FINALIZED_T28",
            "start": summary["period_start"],
            "through": through,
            "state": "RECONCILED" if trusted else state,
            "cutoff": cutoff,
            "currency": "MXN",
        },
        "source": {
            "marketplace_id": marketplace_id,
            "source_key": "amazon_ads",
            "label": "Amazon Ads",
            "trusted": trusted,
            "state": state,
            "reason": (
                "The stored Advertising window is complete and every account-day passes reconciliation."
                if trusted
                else "The stored Advertising window is incomplete or contains an account-day reconciliation defect."
            ),
            "cutoff": cutoff,
        },
        "products": products,
    }


def _expire_absent_candidates(cur, active_ids: set[str], *, marketplace_id: str) -> int:
    cur.execute(
        """
        SELECT candidate
        FROM decision.candidate_current
        WHERE rule_version=2
          AND rule_key = ANY(%s)
          AND rule_lifecycle='SHADOW'
          AND candidate_state='SHADOW_CANDIDATE'
          AND marketplace_id=%s
        ORDER BY candidate_id
        """,
        (list(SHADOW_RULE_VERSIONS), marketplace_id),
    )
    expired = 0
    for row in cur.fetchall():
        candidate = dict(row["candidate"])
        if candidate["id"] in active_ids:
            continue
        candidate["state"] = "EXPIRED"
        terminal = finalize_candidate(candidate)
        persist_candidate(cur, terminal, state_reason="No longer emitted by the current point-in-time replay.")
        expired += 1
    return expired


def replay_ads_shadow_candidates(
    conn, *, marketplace_id: str = MARKETPLACE, now: datetime | None = None
) -> dict[str, Any]:
    evaluated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    with conn.cursor() as cur:
        facts = _load_replay_facts(cur, marketplace_id, now=evaluated_at)
        candidates = []
        blocker = data_blocker_candidate(facts["source"], facts["window"], now=evaluated_at)
        if blocker is not None:
            candidates.append(blocker)
        candidates.extend(
            evaluate_product_shadow_candidates(facts["products"], facts["window"], now=evaluated_at)
        )
        snapshot_ids = [persist_candidate(cur, candidate) for candidate in candidates]
        expired = _expire_absent_candidates(
            cur,
            {candidate["id"] for candidate in candidates},
            marketplace_id=marketplace_id,
        )
    conn.commit()
    return {
        "status": "success",
        "marketplace_id": marketplace_id,
        "window": {
            key: _iso(value)
            for key, value in facts["window"].items()
            if key not in {"cutoff", "currency"}
        },
        "source_state": facts["source"]["state"],
        "source_trusted": facts["source"]["trusted"],
        "products_evaluated": len(facts["products"]),
        "candidates": len(candidates),
        "suppressed": sum(bool(candidate.get("suppression")) for candidate in candidates),
        "expired": expired,
        "snapshot_ids": snapshot_ids,
        "kinds": {
            kind: sum(candidate["kind"] == kind for candidate in candidates)
            for kind in sorted(SHADOW_RULE_VERSIONS)
        },
    }


def main() -> None:
    with connect() as conn:
        print(json.dumps(replay_ads_shadow_candidates(conn), sort_keys=True))


if __name__ == "__main__":
    main()
