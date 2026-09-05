from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
from hashlib import sha256
import json
import os
import re
from typing import Any

from ads_shadow_rules import (
    SHADOW_RULE_VERSIONS,
    data_blocker_candidate,
    evaluate_product_shadow_candidates,
)
from decision_contract import canonical_json, finalize_candidate
from decision_store import persist_candidate


MARKETPLACE = os.getenv("SPAPI_MARKETPLACE_ID", "A1AM78C64UM0Y8")
EVALUATOR_KEY = "ADS_INITIAL_SHADOW"
EVALUATOR_VERSION = 1


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


def _facts_fingerprint(facts: dict[str, Any]) -> str:
    return f"facts_{sha256(canonical_json(facts).encode('utf-8')).hexdigest()}"


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
            "captured_at": now,
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
            "source_cutoffs": {
                "amazon_ads": now,
                "inventory": None,
                "seller_traffic": None,
                "seller_listings": None,
            },
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
               inventory.snapshot_at AS inventory_snapshot_at,
               c.fetched_at AS listing_fetched_at,
               traffic.updated_at AS traffic_updated_at,
               p.spend,p.clicks,p.attributed_purchases,p.observed_ads_days,p.mature_ads_days,
               %s::int AS attribution_lookback_days,%s::boolean AS ads_trusted
        FROM mart.ads_product_business_t28 p
        LEFT JOIN mart.catalog_portfolio_product c
          ON c.marketplace_id=p.marketplace_id AND c.seller_sku=p.sku
        LEFT JOIN mart.inventory_attention inventory
          ON inventory.marketplace_id=p.marketplace_id AND inventory.seller_sku=p.sku
        LEFT JOIN LATERAL (
            SELECT max(source.updated_at) AS updated_at
            FROM core.asin_sales_traffic_daily source
            WHERE source.marketplace_id=p.marketplace_id
              AND source.asin=p.asin
              AND source.business_date BETWEEN p.through_date-27 AND p.through_date
        ) traffic ON true
        WHERE p.marketplace_id=%s
        ORDER BY p.spend DESC,p.sku,p.asin
        """,
        (lookback_days, trusted, marketplace_id),
    )
    products = list(cur.fetchall())
    for row in products:
        row["evaluation_captured_at"] = now
    inventory_cutoffs = [row.get("inventory_snapshot_at") for row in products if row.get("inventory_snapshot_at")]
    traffic_cutoffs = [row.get("traffic_updated_at") for row in products if row.get("traffic_updated_at")]
    listing_cutoffs = [row.get("listing_fetched_at") for row in products if row.get("listing_fetched_at")]
    return {
        "captured_at": now,
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
        "source_cutoffs": {
            "amazon_ads": cutoff,
            "inventory": max(inventory_cutoffs) if inventory_cutoffs else None,
            "seller_traffic": max(traffic_cutoffs) if traffic_cutoffs else None,
            "seller_listings": max(listing_cutoffs) if listing_cutoffs else None,
        },
    }


def _load_point_in_time_facts(
    cur, marketplace_id: str, *, as_of: datetime
) -> tuple[int, datetime, dict[str, Any]]:
    cur.execute(
        """
        SELECT evaluation_id,captured_at,facts
        FROM decision.shadow_evaluation
        WHERE evaluator_key=%s
          AND evaluator_version=%s
          AND marketplace_id=%s
          AND evaluation_mode='CURRENT'
          AND captured_at<=%s
        ORDER BY captured_at DESC,evaluation_id DESC
        LIMIT 1
        """,
        (EVALUATOR_KEY, EVALUATOR_VERSION, marketplace_id, as_of),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError(
            f"no immutable {EVALUATOR_KEY} fact capture exists at or before {as_of.isoformat()}"
        )
    captured_at = row["captured_at"]
    if captured_at.tzinfo is None:
        raise ValueError("stored shadow evaluation capture is missing its timezone")
    return int(row["evaluation_id"]), captured_at.astimezone(timezone.utc), dict(row["facts"])


def _record_shadow_evaluation(
    cur,
    *,
    marketplace_id: str,
    mode: str,
    captured_at: datetime,
    replay_of_evaluation_id: int | None,
    facts: dict[str, Any],
    candidates: list[dict[str, Any]],
    snapshot_ids: list[int],
    expired: int,
    summary: dict[str, Any],
) -> int:
    fingerprint = _facts_fingerprint(facts)
    cur.execute(
        """
        INSERT INTO decision.shadow_evaluation(
            evaluator_key,evaluator_version,marketplace_id,evaluation_mode,captured_at,
            replay_of_evaluation_id,fact_fingerprint,source_cutoffs,rule_versions,facts,
            candidates,candidate_count,suppressed_count,expired_count,
            candidate_snapshot_ids,summary
        ) VALUES (
            %s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s::jsonb,
            %s::jsonb,%s,%s,%s,%s::jsonb,%s::jsonb
        ) RETURNING evaluation_id
        """,
        (
            EVALUATOR_KEY,
            EVALUATOR_VERSION,
            marketplace_id,
            mode,
            captured_at,
            replay_of_evaluation_id,
            fingerprint,
            canonical_json(facts.get("source_cutoffs") or {}),
            canonical_json(SHADOW_RULE_VERSIONS),
            canonical_json(facts),
            canonical_json(candidates),
            len(candidates),
            sum(bool(candidate.get("suppression")) for candidate in candidates),
            expired,
            canonical_json(snapshot_ids),
            canonical_json(summary),
        ),
    )
    row = cur.fetchone()
    if not row:
        raise RuntimeError("shadow evaluation history was not persisted")
    return int(row["evaluation_id"])


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
    conn,
    *,
    marketplace_id: str = MARKETPLACE,
    now: datetime | None = None,
    as_of: datetime | None = None,
) -> dict[str, Any]:
    evaluated_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    with conn.cursor() as cur:
        cur.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s,0))",
            (f"{EVALUATOR_KEY}:{marketplace_id}",),
        )
        replay_of_evaluation_id = None
        if as_of is None:
            mode = "CURRENT"
            captured_at = evaluated_at
            facts = _load_replay_facts(cur, marketplace_id, now=evaluated_at)
        else:
            mode = "POINT_IN_TIME_REPLAY"
            cutoff = as_of.astimezone(timezone.utc)
            replay_of_evaluation_id, captured_at, facts = _load_point_in_time_facts(
                cur, marketplace_id, as_of=cutoff
            )
        candidates = []
        blocker = data_blocker_candidate(facts["source"], facts["window"], now=captured_at)
        if blocker is not None:
            candidates.append(blocker)
        candidates.extend(
            evaluate_product_shadow_candidates(facts["products"], facts["window"], now=captured_at)
        )
        if mode == "CURRENT":
            snapshot_ids = [persist_candidate(cur, candidate) for candidate in candidates]
            expired = _expire_absent_candidates(
                cur,
                {candidate["id"] for candidate in candidates},
                marketplace_id=marketplace_id,
            )
        else:
            snapshot_ids = []
            expired = 0
        result = {
            "status": "success",
            "mode": mode,
            "marketplace_id": marketplace_id,
            "captured_at": _iso(captured_at),
            "replay_of_evaluation_id": replay_of_evaluation_id,
            "fact_fingerprint": _facts_fingerprint(facts),
            "window": {
                key: _iso(value)
                for key, value in facts["window"].items()
                if key not in {"cutoff", "currency"}
            },
            "source_state": facts["source"]["state"],
            "source_trusted": facts["source"]["trusted"],
            "source_cutoffs": {
                key: _iso(value) for key, value in (facts.get("source_cutoffs") or {}).items()
            },
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
        evaluation_id = _record_shadow_evaluation(
            cur,
            marketplace_id=marketplace_id,
            mode=mode,
            captured_at=captured_at,
            replay_of_evaluation_id=replay_of_evaluation_id,
            facts=facts,
            candidates=candidates,
            snapshot_ids=snapshot_ids,
            expired=expired,
            summary=result,
        )
        result["evaluation_id"] = evaluation_id
    conn.commit()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Advertising V2 shadow rules")
    parser.add_argument(
        "--as-of",
        help="Replay the latest immutable CURRENT fact capture at or before this ISO-8601 timestamp.",
    )
    args = parser.parse_args()
    as_of = None
    if args.as_of:
        as_of = datetime.fromisoformat(args.as_of.replace("Z", "+00:00"))
        if as_of.tzinfo is None:
            parser.error("--as-of must include a timezone")
    with connect() as conn:
        print(json.dumps(replay_ads_shadow_candidates(conn, as_of=as_of), sort_keys=True))


if __name__ == "__main__":
    main()
