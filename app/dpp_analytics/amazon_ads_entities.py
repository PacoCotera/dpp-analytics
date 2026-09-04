from __future__ import annotations

import datetime as dt
import hashlib
import json
import time
from decimal import Decimal, InvalidOperation
from typing import Any

from psycopg.types.json import Jsonb

from . import db
from .amazon_ads import AmazonAdsClient, SOURCE, discover_scopes
from .settings import settings

JOB = "sponsored_products_entity_snapshots"
MAX_RESULTS = 100
MAX_ATTEMPTS = 5
RETRY_BASE_SECONDS = 1.0
RETRY_MAX_SECONDS = 30.0

ENTITY_CONFIGS = (
    (
        "CAMPAIGN",
        "/sp/campaigns/list",
        "application/vnd.spCampaign.v3+json",
        "campaigns",
        "campaignId",
    ),
    (
        "AD_GROUP",
        "/sp/adGroups/list",
        "application/vnd.spAdGroup.v3+json",
        "adGroups",
        "adGroupId",
    ),
    (
        "PRODUCT_AD",
        "/sp/productAds/list",
        "application/vnd.spProductAd.v3+json",
        "productAds",
        "adId",
    ),
    (
        "TARGET",
        "/sp/targets/list",
        "application/vnd.spTargetingClause.v3+json",
        "targetingClauses",
        "targetId",
    ),
    (
        "KEYWORD",
        "/sp/keywords/list",
        "application/vnd.spKeyword.v3+json",
        "keywords",
        "keywordId",
    ),
)


def _decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def _entity_values(entity_type: str, row: dict[str, Any]) -> dict[str, Any]:
    extended = row.get("extendedData") if isinstance(row.get("extendedData"), dict) else {}
    budget = row.get("budget") if isinstance(row.get("budget"), dict) else {}
    dynamic = row.get("dynamicBidding") if isinstance(row.get("dynamicBidding"), dict) else {}
    return {
        "campaign_id": row.get("campaignId"),
        "ad_group_id": row.get("adGroupId"),
        "name": row.get("name") or row.get("keywordText"),
        "state": row.get("state"),
        "serving_status": extended.get("servingStatus"),
        "serving_status_details": extended.get("servingStatusDetails") or [],
        "bid": _decimal(row.get("bid") if entity_type != "AD_GROUP" else row.get("defaultBid")),
        "budget": _decimal(budget.get("budget")),
        "budget_type": budget.get("budgetType"),
        "targeting_type": row.get("targetingType"),
        "portfolio_id": row.get("portfolioId"),
        "seller_sku": row.get("sku"),
        "asin": row.get("asin"),
        "match_type": row.get("matchType"),
        "expression_type": row.get("expressionType"),
        "expression": row.get("expression") or [],
        "resolved_expression": row.get("resolvedExpression") or [],
        "bidding_strategy": dynamic.get("strategy"),
        "placement_bidding": dynamic.get("placementBidding") or [],
        "source_created_at": extended.get("creationDateTime"),
        "source_updated_at": extended.get("lastUpdateDateTime"),
    }


def _request_page(
    client: AmazonAdsClient,
    scope: str,
    path: str,
    media_type: str,
    next_token: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "includeExtendedDataFields": True,
        "maxResults": MAX_RESULTS,
    }
    if next_token:
        body["nextToken"] = next_token

    response = None
    for attempt in range(MAX_ATTEMPTS):
        response = client.authenticated_request(
            "post",
            f"{client.base}{path}",
            scope,
            content_type=media_type,
            accept=media_type,
            json=body,
        )
        if response.status_code not in {429, 500, 502, 503, 504}:
            break
        if attempt + 1 >= MAX_ATTEMPTS:
            break
        retry_after = response.headers.get("Retry-After")
        try:
            delay = float(retry_after) if retry_after is not None else 0.0
        except ValueError:
            delay = 0.0
        if delay <= 0:
            delay = RETRY_BASE_SECONDS * (2**attempt)
        time.sleep(min(RETRY_MAX_SECONDS, delay))

    assert response is not None
    if response.status_code >= 400:
        detail = response.text.strip().replace("\n", " ")[:700]
        raise RuntimeError(
            f"Amazon Ads entity read {path} failed: HTTP {response.status_code}: "
            f"{detail or '<empty response>'}"
        )
    payload = response.json() if response.content else {}
    if not isinstance(payload, dict):
        raise RuntimeError(f"Amazon Ads entity read {path} returned a non-object payload")
    return payload


def _begin_batch(account_id: str, snapshot_at: dt.datetime, run_id: int) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO ads.entity_snapshot_batch(
                account_id,snapshot_at,status,ingestion_run_id
            ) VALUES (%s,%s,'IN_PROGRESS',%s)
            """,
            (account_id, snapshot_at, run_id),
        )
        conn.commit()


def _finish_batch(
    account_id: str,
    snapshot_at: dt.datetime,
    *,
    status: str,
    counts: dict[str, int],
    error: str | None = None,
) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            UPDATE ads.entity_snapshot_batch
            SET status=%s,entity_counts=%s,completed_at=now(),error_message=%s
            WHERE account_id=%s AND snapshot_at=%s
            """,
            (status, Jsonb(counts), error[:4000] if error else None, account_id, snapshot_at),
        )
        conn.commit()


def _save_page(
    *,
    account_id: str,
    snapshot_at: dt.datetime,
    entity_type: str,
    id_field: str,
    page_number: int,
    payload: dict[str, Any],
    rows: list[dict[str, Any]],
    run_id: int,
) -> int:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    digest = hashlib.sha256(encoded).hexdigest()
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO raw.api_payload(
                source,resource_type,resource_id,marketplace_id,fetched_at,
                payload,payload_sha256,ingestion_run_id
            ) VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING id
            """,
            (
                SOURCE,
                "ads_entity_snapshot_page",
                f"{account_id}:{snapshot_at.isoformat()}:{entity_type}:{page_number}",
                settings.marketplace_id,
                snapshot_at,
                Jsonb(payload),
                digest,
                run_id,
            ),
        )
        raw_id = cur.fetchone()["id"]
        written = 0
        for row in rows:
            entity_id = row.get(id_field)
            if not entity_id:
                continue
            values = _entity_values(entity_type, row)
            cur.execute(
                """
                INSERT INTO ads.entity_snapshot(
                    account_id,snapshot_at,entity_type,entity_id,campaign_id,
                    ad_group_id,name,state,serving_status,serving_status_details,
                    bid,budget,budget_type,targeting_type,portfolio_id,seller_sku,
                    asin,match_type,expression_type,expression,resolved_expression,
                    bidding_strategy,placement_bidding,source_created_at,
                    source_updated_at,source_payload_id,source_record
                ) VALUES (
                    %s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,
                    %s,%s,%s,%s,%s,%s,%s,%s,%s
                )
                """,
                (
                    account_id,
                    snapshot_at,
                    entity_type,
                    str(entity_id),
                    values["campaign_id"],
                    values["ad_group_id"],
                    values["name"],
                    values["state"],
                    values["serving_status"],
                    Jsonb(values["serving_status_details"]),
                    values["bid"],
                    values["budget"],
                    values["budget_type"],
                    values["targeting_type"],
                    values["portfolio_id"],
                    values["seller_sku"],
                    values["asin"],
                    values["match_type"],
                    values["expression_type"],
                    Jsonb(values["expression"]),
                    Jsonb(values["resolved_expression"]),
                    values["bidding_strategy"],
                    Jsonb(values["placement_bidding"]),
                    values["source_created_at"],
                    values["source_updated_at"],
                    raw_id,
                    Jsonb(row),
                ),
            )
            written += 1
        conn.commit()
    return written


def ingest_ads_entities(client: AmazonAdsClient | None = None) -> dict[str, Any]:
    if not settings.ads_enabled:
        return {"status": "disabled", "records_read": 0, "records_written": 0}
    if not settings.ads_credentials_present:
        return {"status": "missing_credentials", "records_read": 0, "records_written": 0}

    own_client = client is None
    client = client or AmazonAdsClient()
    totals: dict[str, Any] = {"records_read": 0, "records_written": 0, "accounts": 0}
    try:
        scopes, discovery = discover_scopes(client)
        if not scopes:
            return {"status": "no_mx_profiles", **totals, **discovery}
        with db.ingestion_run(SOURCE, JOB, discovery) as run:
            totals["accounts"] = len(scopes)
            for account_id in scopes:
                snapshot_at = dt.datetime.now(dt.timezone.utc)
                counts: dict[str, int] = {}
                _begin_batch(account_id, snapshot_at, run["id"])
                try:
                    for entity_type, path, media_type, list_key, id_field in ENTITY_CONFIGS:
                        next_token: str | None = None
                        page_number = 0
                        entity_count = 0
                        while True:
                            page_number += 1
                            payload = _request_page(
                                client, account_id, path, media_type, next_token
                            )
                            raw_rows = payload.get(list_key) or []
                            rows = [row for row in raw_rows if isinstance(row, dict)]
                            totals["records_read"] += len(rows)
                            written = _save_page(
                                account_id=account_id,
                                snapshot_at=snapshot_at,
                                entity_type=entity_type,
                                id_field=id_field,
                                page_number=page_number,
                                payload=payload,
                                rows=rows,
                                run_id=run["id"],
                            )
                            totals["records_written"] += written
                            entity_count += written
                            run["records_read"] = totals["records_read"]
                            run["records_written"] = totals["records_written"]
                            next_token = payload.get("nextToken")
                            if not next_token:
                                break
                        counts[entity_type] = entity_count
                    _finish_batch(
                        account_id,
                        snapshot_at,
                        status="COMPLETE",
                        counts=counts,
                    )
                except Exception as exc:
                    _finish_batch(
                        account_id,
                        snapshot_at,
                        status="FAILED",
                        counts=counts,
                        error=f"{type(exc).__name__}: {exc}",
                    )
                    raise
        return {"status": "success", **totals}
    finally:
        if own_client:
            client.close()
