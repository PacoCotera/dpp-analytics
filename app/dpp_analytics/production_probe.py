from __future__ import annotations

import datetime as dt
import json

from . import db
from .settings import settings
from .spapi import SpApiClient, SpApiError


def _iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def _attempt(name: str, fn):
    try:
        payload = fn()
        return {"status": "ok", **payload}
    except SpApiError as exc:
        return {"status": "error", "error": str(exc)[:700]}
    except Exception as exc:
        return {"status": "error", "error": f"{type(exc).__name__}: {str(exc)[:700]}"}


def _json_value(value):
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return value


def probe() -> dict[str, object]:
    if not settings.is_production:
        raise RuntimeError(f"production probe refused in environment={settings.spapi_environment}")
    if not settings.spapi_credentials_present:
        raise RuntimeError("SP-API production credentials are not present")

    client = SpApiClient()
    try:
        now = dt.datetime.now(dt.timezone.utc)
        before = now - dt.timedelta(minutes=5)
        after = before - dt.timedelta(days=7)

        orders = _attempt("orders", lambda: _orders_probe(client, after, before))
        inventory = _attempt("inventory", lambda: _inventory_probe(client))
        finances = _attempt("finances", lambda: _finances_probe(client, after, before))
        data_kiosk = _attempt("data_kiosk", lambda: _data_kiosk_probe(client))
        warehouse = _attempt("warehouse", _warehouse_probe)

        checks = {
            "orders": orders,
            "inventory": inventory,
            "finances": finances,
            "data_kiosk": data_kiosk,
        }
        return {
            "environment": settings.spapi_environment,
            "endpoint": settings.spapi_endpoint,
            "marketplace": settings.marketplace_id,
            "production_ingestion_enabled": settings.production_ingestion_enabled,
            "checks": checks,
            "warehouse": warehouse,
            "all_authorized": all(v.get("status") == "ok" for v in checks.values()),
        }
    finally:
        client.close()


def _orders_probe(client: SpApiClient, after: dt.datetime, before: dt.datetime) -> dict[str, object]:
    payload = client.get(
        "/orders/2026-01-01/orders",
        params={
            "lastUpdatedAfter": _iso(after),
            "lastUpdatedBefore": _iso(before),
            "marketplaceIds": settings.marketplace_id,
            "maxResultsPerPage": 1,
            "includedData": "PROCEEDS,FULFILLMENT,PROMOTION",
        },
    )
    return {
        "operation": "orders.searchOrders.v2026-01-01",
        "sample_count": len(payload.get("orders") or []),
        "has_next_page": bool((payload.get("pagination") or {}).get("nextToken")),
    }


def _inventory_probe(client: SpApiClient) -> dict[str, object]:
    payload = client.get(
        "/fba/inventory/v1/summaries",
        params={
            "details": "true",
            "granularityType": "Marketplace",
            "granularityId": settings.marketplace_id,
            "marketplaceIds": settings.marketplace_id,
        },
    )
    body = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    summaries = body.get("inventorySummaries") or []
    return {
        "operation": "fbaInventory.getInventorySummaries.v1",
        "summary_count": len(summaries),
    }


def _finances_probe(client: SpApiClient, after: dt.datetime, before: dt.datetime) -> dict[str, object]:
    payload = client.get(
        "/finances/2024-06-19/transactions",
        params={
            "postedAfter": _iso(after),
            "postedBefore": _iso(before),
            "marketplaceId": settings.marketplace_id,
        },
    )
    body = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    transactions = body.get("transactions") or []
    next_token = body.get("nextToken") or payload.get("nextToken")
    return {
        "operation": "finances.listTransactions.v2024-06-19",
        "sample_count": len(transactions),
        "has_next_page": bool(next_token),
    }


def _data_kiosk_probe(client: SpApiClient) -> dict[str, object]:
    payload = client.get("/dataKiosk/2023-11-15/queries")
    body = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
    queries = body.get("queries") or []
    return {
        "operation": "dataKiosk.getQueries.v2023-11-15",
        "visible_query_count": len(queries),
    }


def _latest_run(cur, source: str, job_name: str) -> dict[str, object]:
    cur.execute(
        """
        SELECT status, records_read, records_written, started_at, finished_at, error_message
        FROM ops.ingestion_runs
        WHERE source=%s AND job_name=%s
        ORDER BY started_at DESC
        LIMIT 1
        """,
        (source, job_name),
    )
    row = cur.fetchone() or {}
    return {key: _json_value(value) for key, value in row.items()}


def _cursor(cur, source: str, job_name: str, cursor_name: str = "default") -> dict[str, object] | None:
    cur.execute(
        """
        SELECT cursor_value, updated_at
        FROM ops.ingestion_cursor
        WHERE source=%s AND job_name=%s AND cursor_name=%s
        """,
        (source, job_name, cursor_name),
    )
    row = cur.fetchone()
    if not row:
        return None
    return {
        "value": row["cursor_value"],
        "updated_at": _json_value(row["updated_at"]),
    }


def _finance_shape(cur) -> dict[str, object]:
    """Describe only field names/category labels, never identifiers or payload values."""
    cur.execute(
        """
        SELECT COALESCE(array_agg(DISTINCT k.key ORDER BY k.key), ARRAY[]::text[]) AS keys
        FROM raw.api_payload p
        CROSS JOIN LATERAL jsonb_object_keys(p.payload) AS k(key)
        WHERE p.source='amazon_spapi' AND p.resource_type='financial_transaction'
        """
    )
    top_keys = list((cur.fetchone() or {}).get("keys") or [])

    cur.execute(
        """
        SELECT COALESCE(array_agg(DISTINCT k.key ORDER BY k.key), ARRAY[]::text[]) AS keys
        FROM raw.api_payload p
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(p.payload->'breakdowns')='array'
                 THEN p.payload->'breakdowns' ELSE '[]'::jsonb END
        ) AS b(obj)
        CROSS JOIN LATERAL jsonb_object_keys(b.obj) AS k(key)
        WHERE p.source='amazon_spapi' AND p.resource_type='financial_transaction'
        """
    )
    breakdown_keys = list((cur.fetchone() or {}).get("keys") or [])

    cur.execute(
        """
        SELECT COALESCE(array_agg(DISTINCT k.key ORDER BY k.key), ARRAY[]::text[]) AS keys
        FROM raw.api_payload p
        CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(p.payload->'items')='array'
                 THEN p.payload->'items' ELSE '[]'::jsonb END
        ) AS i(obj)
        CROSS JOIN LATERAL jsonb_object_keys(i.obj) AS k(key)
        WHERE p.source='amazon_spapi' AND p.resource_type='financial_transaction'
        """
    )
    item_keys = list((cur.fetchone() or {}).get("keys") or [])

    cur.execute(
        """
        SELECT label, count(*) AS n
        FROM (
            SELECT COALESCE(
                b.obj->>'breakdownType', b.obj->>'type', b.obj->>'name', b.obj->>'description'
            ) AS label
            FROM raw.api_payload p
            CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(p.payload->'breakdowns')='array'
                     THEN p.payload->'breakdowns' ELSE '[]'::jsonb END
            ) AS b(obj)
            WHERE p.source='amazon_spapi' AND p.resource_type='financial_transaction'
        ) x
        WHERE label IS NOT NULL
        GROUP BY label
        ORDER BY count(*) DESC, label
        LIMIT 40
        """
    )
    breakdown_labels = [
        {"label": row["label"], "count": int(row["n"] or 0)} for row in cur.fetchall()
    ]

    return {
        "top_level_keys": top_keys,
        "breakdown_keys": breakdown_keys,
        "item_keys": item_keys,
        "breakdown_labels": breakdown_labels,
    }


def _finance_item_evidence(cur) -> dict[str, object]:
    """Report structural coverage without exposing identifiers or asserting economics."""
    cur.execute(
        """
        WITH current_raw AS (
            SELECT
                ft.transaction_id,
                CASE WHEN jsonb_typeof(payload.payload->'items')='array'
                     THEN jsonb_array_length(payload.payload->'items') ELSE 0 END AS item_count
            FROM core.financial_transaction ft
            LEFT JOIN raw.api_payload payload ON payload.id=ft.source_payload_id
        )
        SELECT
            count(*)::bigint AS current_transactions,
            count(*) FILTER (WHERE item_count > 0)::bigint AS raw_transactions_with_items,
            COALESCE(sum(item_count),0)::bigint AS raw_item_rows,
            (SELECT count(*) FROM core.financial_transaction_item)::bigint
                AS normalized_item_rows,
            (SELECT count(DISTINCT transaction_id)
             FROM core.financial_transaction_item)::bigint
                AS normalized_transactions_with_items
        FROM current_raw
        """
    )
    coverage = cur.fetchone() or {}

    cur.execute(
        """
        SELECT identity_state, count(*)::bigint AS item_count
        FROM mart.finance_transaction_item_identity
        GROUP BY identity_state
        ORDER BY identity_state
        """
    )
    identity_states = {
        row["identity_state"]: int(row["item_count"] or 0) for row in cur.fetchall()
    }

    cur.execute(
        """
        SELECT
            count(*)::bigint AS context_rows,
            count(*) FILTER (WHERE seller_sku IS NOT NULL)::bigint AS contexts_with_sku,
            count(*) FILTER (WHERE asin IS NOT NULL)::bigint AS contexts_with_asin,
            count(*) FILTER (
                WHERE seller_sku IS NOT NULL AND asin IS NOT NULL
            )::bigint AS contexts_with_sku_and_asin,
            (SELECT count(*) FROM core.financial_transaction_identifier)::bigint
                AS transaction_identifier_rows,
            (SELECT count(*) FROM core.financial_transaction_item_identifier)::bigint
                AS item_identifier_rows,
            (SELECT count(*) FROM mart.finance_item_breakdown_flat)::bigint
                AS item_breakdown_rows,
            (SELECT count(*) FROM mart.finance_item_leaf_breakdown)::bigint
                AS item_leaf_breakdown_rows
        FROM core.financial_transaction_item_context
        """
    )
    detail = cur.fetchone() or {}

    # Test candidate accounting relationships before adopting one as policy.
    # These aggregates describe whether each source structure happens to tie;
    # they do not declare that Amazon guarantees any of the relationships.
    cur.execute(
        """
        WITH item_leaf AS (
            SELECT transaction_id,item_ordinal,COALESCE(sum(amount),0) AS leaf_amount
            FROM mart.finance_item_leaf_breakdown
            GROUP BY transaction_id,item_ordinal
        ), item_rollup AS (
            SELECT
                item.transaction_id,
                count(*)::bigint AS item_count,
                sum(item.total_amount) AS item_total,
                sum(item_leaf.leaf_amount) AS item_leaf_total
            FROM core.financial_transaction_item item
            LEFT JOIN item_leaf USING (transaction_id,item_ordinal)
            GROUP BY item.transaction_id
        ), transaction_leaf AS (
            SELECT transaction_id,COALESCE(sum(amount),0) AS transaction_leaf_total
            FROM mart.finance_leaf_breakdown
            GROUP BY transaction_id
        ), comparison AS (
            SELECT
                ft.transaction_type,
                ft.total_amount AS transaction_total,
                item_rollup.item_total,
                item_rollup.item_leaf_total,
                transaction_leaf.transaction_leaf_total,
                ft.total_amount-item_rollup.item_total AS item_total_delta,
                ft.total_amount-item_rollup.item_leaf_total AS item_leaf_delta,
                ft.total_amount-transaction_leaf.transaction_leaf_total
                    AS transaction_leaf_delta
            FROM core.financial_transaction ft
            JOIN item_rollup USING (transaction_id)
            LEFT JOIN transaction_leaf USING (transaction_id)
        )
        SELECT
            transaction_type,
            count(*)::bigint AS transactions,
            count(item_total)::bigint AS transactions_with_item_total,
            count(item_leaf_total)::bigint AS transactions_with_item_leaf,
            count(transaction_leaf_total)::bigint AS transactions_with_transaction_leaf,
            count(*) FILTER (WHERE abs(item_total_delta) <= 0.01)::bigint
                AS item_total_matches,
            count(*) FILTER (WHERE abs(item_leaf_delta) <= 0.01)::bigint
                AS item_leaf_matches,
            count(*) FILTER (WHERE abs(transaction_leaf_delta) <= 0.01)::bigint
                AS transaction_leaf_matches,
            COALESCE(sum(transaction_total),0) AS transaction_total,
            COALESCE(sum(item_total),0) AS item_total,
            COALESCE(sum(item_leaf_total),0) AS item_leaf_total,
            COALESCE(sum(transaction_leaf_total),0) AS transaction_leaf_total,
            COALESCE(sum(item_total_delta),0) AS item_total_delta,
            COALESCE(sum(item_leaf_delta),0) AS item_leaf_delta,
            COALESCE(sum(transaction_leaf_delta),0) AS transaction_leaf_delta,
            COALESCE(max(abs(item_total_delta)),0) AS max_abs_item_total_delta,
            COALESCE(max(abs(item_leaf_delta)),0) AS max_abs_item_leaf_delta,
            COALESCE(max(abs(transaction_leaf_delta)),0)
                AS max_abs_transaction_leaf_delta
        FROM comparison
        GROUP BY transaction_type
        ORDER BY count(*) DESC,transaction_type
        """
    )
    reconciliation_candidates = [
        {
            key: int(value or 0)
            if key
            in {
                "transactions",
                "transactions_with_item_total",
                "transactions_with_item_leaf",
                "transactions_with_transaction_leaf",
                "item_total_matches",
                "item_leaf_matches",
                "transaction_leaf_matches",
            }
            else str(value or 0)
            if key != "transaction_type"
            else value
            for key, value in row.items()
        }
        for row in cur.fetchall()
    ]

    cur.execute(
        """
        SELECT
            transaction_type,
            breakdown_path,
            currency,
            count(*)::bigint AS rows,
            COALESCE(sum(amount),0) AS amount
        FROM mart.finance_item_leaf_breakdown
        GROUP BY transaction_type,breakdown_path,currency
        ORDER BY count(*) DESC,transaction_type,breakdown_path,currency
        LIMIT 80
        """
    )
    leaf_breakdown_categories = [
        {
            "transaction_type": row["transaction_type"],
            "breakdown_path": row["breakdown_path"],
            "currency": row["currency"],
            "rows": int(row["rows"] or 0),
            "amount": str(row["amount"] or 0),
        }
        for row in cur.fetchall()
    ]

    cur.execute(
        """
        SELECT source_level,identifier_name,count(*)::bigint AS rows
        FROM (
            SELECT 'TRANSACTION'::text AS source_level,identifier_name
            FROM core.financial_transaction_identifier
            UNION ALL
            SELECT 'ITEM'::text,identifier_name
            FROM core.financial_transaction_item_identifier
        ) identifiers
        GROUP BY source_level,identifier_name
        ORDER BY source_level,count(*) DESC,identifier_name
        """
    )
    identifier_categories = [
        {
            "source_level": row["source_level"],
            "identifier_name": row["identifier_name"],
            "rows": int(row["rows"] or 0),
        }
        for row in cur.fetchall()
    ]

    cur.execute(
        """
        WITH item_rollup AS (
            SELECT
                item.transaction_id,
                count(*)::bigint AS item_rows,
                count(*) FILTER (WHERE identity.identity_state='EXACT')::bigint
                    AS exact_identity_items,
                count(*) FILTER (WHERE identity.identity_state<>'EXACT')::bigint
                    AS unresolved_identity_items,
                COALESCE(sum(item.total_amount),0) AS item_total,
                COALESCE(sum(item.total_amount) FILTER (
                    WHERE identity.identity_state='EXACT'
                ),0) AS exact_identity_item_amount,
                COALESCE(sum(item.total_amount) FILTER (
                    WHERE identity.identity_state<>'EXACT'
                ),0) AS unresolved_identity_item_amount
            FROM core.financial_transaction_item item
            JOIN mart.finance_transaction_item_identity identity
                USING (transaction_id,item_ordinal)
            GROUP BY item.transaction_id
        )
        SELECT
            transaction.transaction_type,
            count(*)::bigint AS transactions,
            count(item_rollup.transaction_id)::bigint AS transactions_with_items,
            COALESCE(sum(item_rollup.item_rows),0)::bigint AS item_rows,
            COALESCE(sum(item_rollup.exact_identity_items),0)::bigint
                AS exact_identity_items,
            COALESCE(sum(item_rollup.unresolved_identity_items),0)::bigint
                AS unresolved_identity_items,
            COALESCE(sum(transaction.total_amount),0) AS transaction_total,
            COALESCE(sum(item_rollup.item_total),0) AS item_total,
            COALESCE(sum(
                transaction.total_amount-COALESCE(item_rollup.item_total,0)
            ),0) AS transaction_without_item_amount,
            COALESCE(sum(item_rollup.exact_identity_item_amount),0)
                AS exact_identity_item_amount,
            COALESCE(sum(item_rollup.unresolved_identity_item_amount),0)
                AS unresolved_identity_item_amount,
            COALESCE(sum(
                transaction.total_amount
                - COALESCE(item_rollup.exact_identity_item_amount,0)
            ),0) AS product_allocation_residual
        FROM core.financial_transaction transaction
        LEFT JOIN item_rollup USING (transaction_id)
        GROUP BY transaction.transaction_type
        ORDER BY count(*) DESC,transaction.transaction_type
        """
    )
    product_allocation_by_transaction_type = [
        {
            key: int(value or 0)
            if key
            in {
                "transactions",
                "transactions_with_items",
                "item_rows",
                "exact_identity_items",
                "unresolved_identity_items",
            }
            else str(value or 0)
            if key != "transaction_type"
            else value
            for key, value in row.items()
        }
        for row in cur.fetchall()
    ]

    cur.execute(
        """
        SELECT
            leaf.transaction_type,
            leaf.breakdown_path,
            identity.identity_state,
            leaf.currency,
            count(*)::bigint AS rows,
            COALESCE(sum(leaf.amount),0) AS amount
        FROM mart.finance_item_leaf_breakdown leaf
        JOIN mart.finance_transaction_item_identity identity
            USING (transaction_id,item_ordinal)
        GROUP BY
            leaf.transaction_type,leaf.breakdown_path,
            identity.identity_state,leaf.currency
        ORDER BY
            leaf.transaction_type,leaf.breakdown_path,
            identity.identity_state,leaf.currency
        LIMIT 200
        """
    )
    product_breakdown_identity = [
        {
            "transaction_type": row["transaction_type"],
            "breakdown_path": row["breakdown_path"],
            "identity_state": row["identity_state"],
            "currency": row["currency"],
            "rows": int(row["rows"] or 0),
            "amount": str(row["amount"] or 0),
        }
        for row in cur.fetchall()
    ]

    cur.execute(
        """
        WITH exact_item AS (
            SELECT
                item.transaction_id,item.item_ordinal,item.total_amount,
                transaction.marketplace_id,identity.seller_sku,identity.asin
            FROM core.financial_transaction_item item
            JOIN core.financial_transaction transaction USING (transaction_id)
            JOIN mart.finance_transaction_item_identity identity
                USING (transaction_id,item_ordinal)
            WHERE identity.identity_state='EXACT'
        ), classified AS (
            SELECT
                exact_item.*,
                EXISTS (
                    SELECT 1
                    FROM mart.catalog_portfolio_product product
                    WHERE product.marketplace_id=exact_item.marketplace_id
                      AND product.seller_sku=exact_item.seller_sku
                      AND product.asin=exact_item.asin
                      AND product.catalog_membership='CURRENT_OFFER'
                ) AS current_offer_match,
                EXISTS (
                    SELECT 1
                    FROM mart.catalog_portfolio_product product
                    WHERE product.marketplace_id=exact_item.marketplace_id
                      AND product.seller_sku=exact_item.seller_sku
                      AND product.asin=exact_item.asin
                      AND product.catalog_membership='CURRENT_OFFER'
                      AND product.is_offer_owner
                ) AS current_owner_match
            FROM exact_item
        )
        SELECT
            count(*)::bigint AS exact_items,
            count(*) FILTER (WHERE current_offer_match)::bigint
                AS current_offer_items,
            count(*) FILTER (WHERE current_owner_match)::bigint
                AS current_owner_items,
            count(*) FILTER (WHERE NOT current_offer_match)::bigint
                AS historical_or_unmapped_items,
            COALESCE(sum(total_amount),0) AS exact_item_amount,
            COALESCE(sum(total_amount) FILTER (WHERE current_offer_match),0)
                AS current_offer_amount,
            COALESCE(sum(total_amount) FILTER (WHERE current_owner_match),0)
                AS current_owner_amount,
            COALESCE(sum(total_amount) FILTER (WHERE NOT current_offer_match),0)
                AS historical_or_unmapped_amount
        FROM classified
        """
    )
    catalog_identity = cur.fetchone() or {}

    integer_keys = (
        "current_transactions",
        "raw_transactions_with_items",
        "raw_item_rows",
        "normalized_item_rows",
        "normalized_transactions_with_items",
    )
    result = {key: int(coverage.get(key) or 0) for key in integer_keys}
    result.update({key: int(value or 0) for key, value in detail.items()})
    result["identity_states"] = identity_states
    result["reconciliation_candidates"] = reconciliation_candidates
    result["leaf_breakdown_categories"] = leaf_breakdown_categories
    result["identifier_categories"] = identifier_categories
    result["product_allocation_by_transaction_type"] = (
        product_allocation_by_transaction_type
    )
    result["product_breakdown_identity"] = product_breakdown_identity
    result["current_catalog_identity"] = {
        key: int(value or 0)
        if key
        in {
            "exact_items",
            "current_offer_items",
            "current_owner_items",
            "historical_or_unmapped_items",
        }
        else str(value or 0)
        for key, value in catalog_identity.items()
    }
    result["raw_normalized_item_delta"] = (
        result["raw_item_rows"] - result["normalized_item_rows"]
    )
    result["backfill_complete"] = result["raw_normalized_item_delta"] == 0
    return result


def _ads_entity_evidence(cur) -> dict[str, object]:
    cur.execute(
        """
        WITH latest_complete AS (
            SELECT max(snapshot_at) AS snapshot_at
            FROM ads.entity_snapshot_batch
            WHERE status='COMPLETE'
        ), latest_failed AS (
            SELECT max(snapshot_at) AS snapshot_at
            FROM ads.entity_snapshot_batch
            WHERE status='FAILED'
        )
        SELECT
            latest_complete.snapshot_at AS latest_complete_at,
            latest_failed.snapshot_at AS latest_failed_at,
            count(*) FILTER (WHERE entity.entity_type='CAMPAIGN')::bigint AS campaigns,
            count(*) FILTER (WHERE entity.entity_type='AD_GROUP')::bigint AS ad_groups,
            count(*) FILTER (WHERE entity.entity_type='PRODUCT_AD')::bigint AS product_ads,
            count(*) FILTER (WHERE entity.entity_type='TARGET')::bigint AS targets,
            count(*) FILTER (WHERE entity.entity_type='KEYWORD')::bigint AS keywords,
            count(DISTINCT entity.account_id)::bigint AS accounts
        FROM latest_complete
        CROSS JOIN latest_failed
        LEFT JOIN ads.current_entity_snapshot entity ON true
        GROUP BY latest_complete.snapshot_at,latest_failed.snapshot_at
        """
    )
    row = cur.fetchone() or {}
    return {
        "latest_complete_at": _json_value(row.get("latest_complete_at")),
        "latest_failed_at": _json_value(row.get("latest_failed_at")),
        "accounts": int(row.get("accounts") or 0),
        "entity_counts": {
            "CAMPAIGN": int(row.get("campaigns") or 0),
            "AD_GROUP": int(row.get("ad_groups") or 0),
            "PRODUCT_AD": int(row.get("product_ads") or 0),
            "TARGET": int(row.get("targets") or 0),
            "KEYWORD": int(row.get("keywords") or 0),
        },
    }


def _ads_spend_reconciliation_evidence(cur) -> dict[str, object]:
    cur.execute(
        """
        WITH cutoff AS (
            SELECT max(business_date) AS through_date
            FROM mart.ads_account_product_spend_reconciliation
        )
        SELECT
            min(reconciliation.business_date) AS start_date,
            max(reconciliation.business_date) AS through_date,
            count(*)::bigint AS account_days,
            count(*) FILTER (WHERE reconciliation_state='RECONCILED')::bigint
                AS reconciled_days,
            count(*) FILTER (WHERE reconciliation_state='INCOMPLETE')::bigint
                AS incomplete_days,
            count(*) FILTER (WHERE reconciliation_state='RESIDUAL')::bigint
                AS residual_days,
            COALESCE(sum(campaign_spend),0) AS campaign_spend,
            COALESCE(sum(product_spend),0) AS product_spend,
            COALESCE(sum(unassigned_product_spend),0) AS unassigned_product_spend,
            COALESCE(max(abs(unassigned_product_spend)),0)
                AS max_abs_daily_unassigned_spend
        FROM mart.ads_account_product_spend_reconciliation reconciliation
        CROSS JOIN cutoff
        WHERE reconciliation.business_date
              BETWEEN cutoff.through_date-27 AND cutoff.through_date
        """
    )
    row = cur.fetchone() or {}
    return {
        "start_date": _json_value(row.get("start_date")),
        "through_date": _json_value(row.get("through_date")),
        "account_days": int(row.get("account_days") or 0),
        "reconciled_days": int(row.get("reconciled_days") or 0),
        "incomplete_days": int(row.get("incomplete_days") or 0),
        "residual_days": int(row.get("residual_days") or 0),
        "campaign_spend": str(row.get("campaign_spend") or 0),
        "product_spend": str(row.get("product_spend") or 0),
        "unassigned_product_spend": str(row.get("unassigned_product_spend") or 0),
        "max_abs_daily_unassigned_spend": str(
            row.get("max_abs_daily_unassigned_spend") or 0
        ),
    }


def _ads_granular_report_evidence(cur) -> dict[str, object]:
    """Expose populated coverage and reconciliation without leaking ad identifiers."""
    cur.execute(
        """
        WITH fact AS (
            SELECT
                'AD_GROUP'::text AS report_grain,account_id,business_date,
                campaign_id,source_report_id
            FROM ads.daily_ad_group
            UNION ALL
            SELECT
                'PLACEMENT'::text,account_id,business_date,campaign_id,
                source_report_id
            FROM ads.daily_placement
            UNION ALL
            SELECT
                'PURCHASED_PRODUCT'::text,account_id,business_date,campaign_id,
                source_report_id
            FROM ads.daily_purchased_product
        )
        SELECT
            report_grain,count(*)::bigint AS rows,
            count(DISTINCT account_id)::bigint AS accounts,
            count(DISTINCT (account_id,campaign_id))::bigint AS campaigns,
            count(DISTINCT source_report_id)::bigint AS source_reports,
            min(business_date) AS first_date,max(business_date) AS through_date
        FROM fact
        GROUP BY report_grain
        ORDER BY report_grain
        """
    )
    facts = {
        row["report_grain"]: {
            "rows": int(row["rows"] or 0),
            "accounts": int(row["accounts"] or 0),
            "campaigns": int(row["campaigns"] or 0),
            "source_reports": int(row["source_reports"] or 0),
            "first_date": _json_value(row.get("first_date")),
            "through_date": _json_value(row.get("through_date")),
        }
        for row in cur.fetchall()
    }

    cur.execute(
        """
        WITH cutoff AS (
            SELECT max(business_date) AS through_date
            FROM mart.ads_account_granular_spend_reconciliation
        )
        SELECT
            report_grain,min(reconciliation.business_date) AS start_date,
            max(reconciliation.business_date) AS through_date,
            count(*)::bigint AS account_days,
            count(*) FILTER (WHERE reconciliation_state='RECONCILED')::bigint
                AS reconciled_days,
            count(*) FILTER (WHERE reconciliation_state='INCOMPLETE')::bigint
                AS incomplete_days,
            count(*) FILTER (WHERE reconciliation_state='RESIDUAL')::bigint
                AS residual_days,
            COALESCE(sum(campaign_spend),0) AS campaign_spend,
            COALESCE(sum(grain_spend),0) AS grain_spend,
            COALESCE(sum(unassigned_spend),0) AS unassigned_spend,
            COALESCE(max(abs(unassigned_spend)),0) AS max_abs_daily_unassigned_spend
        FROM mart.ads_account_granular_spend_reconciliation reconciliation
        CROSS JOIN cutoff
        WHERE reconciliation.business_date
              BETWEEN cutoff.through_date-27 AND cutoff.through_date
        GROUP BY report_grain
        ORDER BY report_grain
        """
    )
    reconciliations = {
        row["report_grain"]: {
            "start_date": _json_value(row.get("start_date")),
            "through_date": _json_value(row.get("through_date")),
            "account_days": int(row["account_days"] or 0),
            "reconciled_days": int(row["reconciled_days"] or 0),
            "incomplete_days": int(row["incomplete_days"] or 0),
            "residual_days": int(row["residual_days"] or 0),
            "campaign_spend": str(row["campaign_spend"] or 0),
            "grain_spend": str(row["grain_spend"] or 0),
            "unassigned_spend": str(row["unassigned_spend"] or 0),
            "max_abs_daily_unassigned_spend": str(
                row["max_abs_daily_unassigned_spend"] or 0
            ),
        }
        for row in cur.fetchall()
    }
    return {"fact_grains": facts, "spend_reconciliation": reconciliations}


def _ads_invalid_traffic_evidence(cur) -> dict[str, object]:
    cur.execute(
        """
        WITH latest AS (
            SELECT account_id,max(ingested_at) AS ingested_at
            FROM mart.ads_gross_invalid_traffic_report
            GROUP BY account_id
        )
        SELECT
            count(*)::bigint AS retained_reports,
            COALESCE(sum(report.source_rows),0)::bigint AS retained_source_rows,
            min(report.window_start) AS first_window_start,
            max(report.window_end) AS through_date,
            count(*) FILTER (
                WHERE report.identity_state='IDENTITY_RECONCILED'
            )::bigint AS identity_reconciled_reports,
            count(*) FILTER (
                WHERE report.identity_state<>'IDENTITY_RECONCILED'
            )::bigint AS identity_unresolved_reports,
            COALESCE(sum(report.gross_impressions) FILTER (
                WHERE report.ingested_at=latest.ingested_at
            ),0)::bigint AS latest_gross_impressions,
            COALESCE(sum(report.invalid_impressions) FILTER (
                WHERE report.ingested_at=latest.ingested_at
            ),0)::bigint AS latest_invalid_impressions,
            COALESCE(sum(report.gross_click_throughs) FILTER (
                WHERE report.ingested_at=latest.ingested_at
            ),0)::bigint AS latest_gross_click_throughs,
            COALESCE(sum(report.invalid_click_throughs) FILTER (
                WHERE report.ingested_at=latest.ingested_at
            ),0)::bigint AS latest_invalid_click_throughs
        FROM mart.ads_gross_invalid_traffic_report report
        JOIN latest USING (account_id)
        """
    )
    row = cur.fetchone() or {}
    integer_keys = (
        "retained_reports",
        "retained_source_rows",
        "identity_reconciled_reports",
        "identity_unresolved_reports",
        "latest_gross_impressions",
        "latest_invalid_impressions",
        "latest_gross_click_throughs",
        "latest_invalid_click_throughs",
    )
    result = {key: int(row.get(key) or 0) for key in integer_keys}
    result["first_window_start"] = _json_value(row.get("first_window_start"))
    result["through_date"] = _json_value(row.get("through_date"))
    return result


def _brand_search_query_evidence(cur) -> dict[str, object]:
    cur.execute(
        """
        SELECT
            report_period,count(*)::bigint AS rows,
            count(DISTINCT (start_date,end_date))::bigint AS periods,
            count(DISTINCT asin)::bigint AS asins,
            count(DISTINCT search_query_key)::bigint AS normalized_queries,
            min(start_date) AS first_period_start,max(end_date) AS through_date
        FROM brand.search_query_performance
        GROUP BY report_period
        ORDER BY report_period
        """
    )
    return {
        row["report_period"]: {
            "rows": int(row["rows"] or 0),
            "periods": int(row["periods"] or 0),
            "asins": int(row["asins"] or 0),
            "normalized_queries": int(row["normalized_queries"] or 0),
            "first_period_start": _json_value(row.get("first_period_start")),
            "through_date": _json_value(row.get("through_date")),
        }
        for row in cur.fetchall()
    }


def _brand_search_catalog_evidence(cur) -> dict[str, object]:
    cur.execute(
        """
        SELECT
            report_period,count(*)::bigint AS rows,
            count(DISTINCT (start_date,end_date))::bigint AS periods,
            count(DISTINCT asin)::bigint AS asins,
            min(start_date) AS first_period_start,max(end_date) AS through_date,
            count(*) FILTER (WHERE impression_count IS NOT NULL)::bigint AS rows_with_impressions,
            count(*) FILTER (WHERE click_count IS NOT NULL)::bigint AS rows_with_clicks,
            count(*) FILTER (WHERE purchase_count IS NOT NULL)::bigint AS rows_with_purchases,
            count(*) FILTER (WHERE search_traffic_sales IS NOT NULL)::bigint AS rows_with_search_sales
        FROM brand.search_catalog_performance
        GROUP BY report_period
        ORDER BY report_period
        """
    )
    integer_keys = (
        "rows", "periods", "asins", "rows_with_impressions", "rows_with_clicks",
        "rows_with_purchases", "rows_with_search_sales",
    )
    return {
        row["report_period"]: {
            **{key: int(row[key] or 0) for key in integer_keys},
            "first_period_start": _json_value(row.get("first_period_start")),
            "through_date": _json_value(row.get("through_date")),
        }
        for row in cur.fetchall()
    }


def _brand_search_terms_evidence(cur) -> dict[str, object]:
    cur.execute(
        """
        SELECT
            report_period,count(*)::bigint AS rows,
            count(DISTINCT (start_date,end_date))::bigint AS periods,
            count(DISTINCT department_name)::bigint AS departments,
            count(DISTINCT search_term_key)::bigint AS normalized_terms,
            count(DISTINCT clicked_asin)::bigint AS clicked_asins,
            count(*) FILTER (WHERE click_share IS NOT NULL)::bigint AS rows_with_click_share,
            count(*) FILTER (WHERE conversion_share IS NOT NULL)::bigint AS rows_with_conversion_share,
            count(DISTINCT clicked_asin) FILTER (
                WHERE EXISTS (
                    SELECT 1 FROM mart.catalog_portfolio_product product
                    WHERE product.marketplace_id=term.marketplace_id
                      AND product.asin=term.clicked_asin
                      AND product.catalog_membership='CURRENT_OFFER'
                )
            )::bigint AS current_owned_clicked_asins,
            min(start_date) AS first_period_start,max(end_date) AS through_date
        FROM brand.amazon_search_term term
        GROUP BY report_period
        ORDER BY report_period
        """
    )
    integer_keys = (
        "rows", "periods", "departments", "normalized_terms", "clicked_asins",
        "rows_with_click_share", "rows_with_conversion_share",
        "current_owned_clicked_asins",
    )
    return {
        row["report_period"]: {
            **{key: int(row[key] or 0) for key in integer_keys},
            "first_period_start": _json_value(row.get("first_period_start")),
            "through_date": _json_value(row.get("through_date")),
        }
        for row in cur.fetchall()
    }


def _warehouse_probe() -> dict[str, object]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) AS order_count, min(created_time) AS first_order, max(created_time) AS last_order
            FROM core.amazon_order
            """
        )
        orders = cur.fetchone()
        cur.execute("SELECT count(*) AS item_count FROM core.amazon_order_item")
        items = cur.fetchone()
        cur.execute("SELECT count(*) AS sku_count FROM core.sku")
        skus = cur.fetchone()

        cur.execute(
            """
            SELECT count(*) AS snapshot_count, max(snapshot_at) AS latest_snapshot
            FROM core.inventory_snapshot
            """
        )
        inventory = cur.fetchone()

        cur.execute(
            """
            SELECT count(*) AS transaction_count, min(posted_date) AS first_posted, max(posted_date) AS last_posted
            FROM core.financial_transaction
            """
        )
        finances = cur.fetchone()

        cur.execute(
            """
            SELECT count(*) AS day_count, min(business_date) AS first_date, max(business_date) AS last_date
            FROM core.sales_traffic_daily
            WHERE marketplace_id=%s
            """,
            (settings.marketplace_id,),
        )
        sales_traffic = cur.fetchone()

        cur.execute(
            """
            SELECT count(*) AS row_count, count(DISTINCT asin) AS asin_count,
                   min(business_date) AS first_date, max(business_date) AS last_date
            FROM core.asin_sales_traffic_daily
            WHERE marketplace_id=%s
            """,
            (settings.marketplace_id,),
        )
        asin_traffic = cur.fetchone()

        cur.execute(
            """
            SELECT transaction_type, count(*) AS n, COALESCE(sum(total_amount),0) AS amount
            FROM core.financial_transaction
            GROUP BY transaction_type
            ORDER BY count(*) DESC
            LIMIT 12
            """
        )
        finance_types = [
            {
                "type": row["transaction_type"],
                "count": int(row["n"] or 0),
                "amount": str(row["amount"]),
            }
            for row in cur.fetchall()
        ]
        finance_shape = _finance_shape(cur)
        finance_item_evidence = _finance_item_evidence(cur)
        ads_entity_evidence = _ads_entity_evidence(cur)
        ads_spend_reconciliation = _ads_spend_reconciliation_evidence(cur)
        ads_granular_report_evidence = _ads_granular_report_evidence(cur)
        ads_invalid_traffic_evidence = _ads_invalid_traffic_evidence(cur)
        brand_search_query_evidence = _brand_search_query_evidence(cur)
        brand_search_catalog_evidence = _brand_search_catalog_evidence(cur)
        brand_search_terms_evidence = _brand_search_terms_evidence(cur)

        orders_cursor = _cursor(cur, "amazon_spapi", "orders_v2026")
        finance_cursor = _cursor(cur, "amazon_spapi", "finances_v2024")
        kiosk_cursor = _cursor(
            cur,
            "amazon_data_kiosk",
            "sales_traffic_2024_04_24",
            "last_complete_date",
        )

        latest_orders_run = _latest_run(cur, "amazon_spapi", "orders_v2026")
        latest_finance_run = _latest_run(cur, "amazon_spapi", "finances_v2024")
        latest_kiosk_run = _latest_run(
            cur,
            "amazon_data_kiosk",
            "sales_traffic_2024_04_24",
        )

    return {
        "orders": int(orders["order_count"] or 0),
        "order_items": int(items["item_count"] or 0),
        "skus": int(skus["sku_count"] or 0),
        "inventory_snapshots": int(inventory["snapshot_count"] or 0),
        "financial_transactions": int(finances["transaction_count"] or 0),
        "sales_traffic_days": int(sales_traffic["day_count"] or 0),
        "asin_sales_traffic_rows": int(asin_traffic["row_count"] or 0),
        "asin_sales_traffic_asins": int(asin_traffic["asin_count"] or 0),
        "first_order": _json_value(orders["first_order"]),
        "last_order": _json_value(orders["last_order"]),
        "latest_inventory_snapshot": _json_value(inventory["latest_snapshot"]),
        "first_finance_posted": _json_value(finances["first_posted"]),
        "last_finance_posted": _json_value(finances["last_posted"]),
        "sales_traffic_first_date": _json_value(sales_traffic["first_date"]),
        "sales_traffic_last_date": _json_value(sales_traffic["last_date"]),
        "asin_traffic_first_date": _json_value(asin_traffic["first_date"]),
        "asin_traffic_last_date": _json_value(asin_traffic["last_date"]),
        "orders_cursor": orders_cursor,
        "finance_cursor": finance_cursor,
        "data_kiosk_cursor": kiosk_cursor,
        "latest_orders_run": latest_orders_run,
        "latest_finance_run": latest_finance_run,
        "latest_data_kiosk_run": latest_kiosk_run,
        "finance_types": finance_types,
        "finance_shape": finance_shape,
        "finance_item_evidence": finance_item_evidence,
        "ads_entity_evidence": ads_entity_evidence,
        "ads_spend_reconciliation": ads_spend_reconciliation,
        "ads_granular_report_evidence": ads_granular_report_evidence,
        "ads_invalid_traffic_evidence": ads_invalid_traffic_evidence,
        "brand_search_query_evidence": brand_search_query_evidence,
        "brand_search_catalog_evidence": brand_search_catalog_evidence,
        "brand_search_terms_evidence": brand_search_terms_evidence,
    }


def main() -> None:
    result = probe()
    print(json.dumps(result, sort_keys=True))
    if not result["all_authorized"]:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
