from __future__ import annotations

import re
from typing import Any

from ads_decisions import (
    ECONOMICS_CONTRACT,
    INTERPRETATION_RULES,
    SEARCH_OPPORTUNITY_RULES,
    SEARCH_QUERY_LIMIT,
    build_search_query_opportunities,
    build_action_groups,
    demand_page,
    enrich_products,
    metric_contract,
    normalize_demand_signal,
    product_reference_index,
    refs_for_row,
)
from ads_state import ads_connection_state


def _one(cur, sql: str, params=()):
    cur.execute(sql, params)
    return cur.fetchone() or {}


def _all(cur, sql: str, params=()):
    cur.execute(sql, params)
    return list(cur.fetchall())


def _query_values(query: dict[str, Any] | None) -> dict[str, str]:
    values: dict[str, str] = {}
    for key, raw in (query or {}).items():
        value = raw[0] if isinstance(raw, list) and raw else raw
        values[key] = str(value or "").strip()
    return values


def _attribution_lookback_days(value: Any) -> int:
    match = re.search(r"(\d+)\s*d", str(value or ""), re.IGNORECASE)
    return max(0, int(match.group(1))) if match else 7


def _empty(status: str, connection: dict, freshness=None) -> dict:
    return {
        "status": status,
        "connection": connection,
        "freshness": freshness,
        "quality": {
            "state": "NO_DATA",
            "trusted_for_operating_decisions": False,
            "issue_days": 0,
            "issues": [],
            "accounts": [],
        },
        "summary": {},
        "daily": [],
        "campaigns": [],
        "products": [],
        "demand": {"items": [], "total": 0, "page": 1, "page_size": 20, "page_count": 1},
        "demand_totals": {"targets": 0, "search_terms": 0},
        "search_opportunities": {
            "status": "UNAVAILABLE",
            "period": None,
            "items": [],
            "shown": 0,
            "qualified": 0,
            "source_rows": 0,
            "rules": SEARCH_OPPORTUNITY_RULES,
            "basis": "Brand Analytics Search Query Performance is not available in this response.",
        },
        "actions": [],
        "action_groups": [],
        "interpretation_rules": INTERPRETATION_RULES,
        "economics": ECONOMICS_CONTRACT,
    }


def _search_opportunities_contract(cur, marketplace: str, ready: dict, decorate_products=None) -> dict:
    contract = {
        "status": "UNAVAILABLE",
        "period": None,
        "items": [],
        "shown": 0,
        "qualified": 0,
        "source_rows": 0,
        "rules": SEARCH_OPPORTUNITY_RULES,
        "basis": (
            "Amazon Brand Analytics Search Query Performance is inclusive marketplace-search evidence. "
            "It does not separate organic and paid activity or prove advertising incrementality."
        ),
        "scenario_basis": (
            "Purchase ranges are arithmetic sensitivities for closing 25% to 50% of an observed funnel gap, "
            "not forecasts or causal lift estimates."
        ),
        "paid_support_basis": (
            "Exact normalized Ads query evidence uses the same calendar month and remains query-level, "
            "not attributable to the selected ASIN."
        ),
    }
    if not ready.get("search_query_rel"):
        return contract
    period = _one(
        cur,
        """
        SELECT max(start_date) start_date
        FROM brand.search_query_performance
        WHERE marketplace_id=%s AND report_period='MONTH'
        """,
        (marketplace,),
    )
    start_date = period.get("start_date")
    if not start_date:
        contract["status"] = "NO_DATA"
        return contract
    rows = _all(
        cur,
        """
        SELECT q.start_date,q.end_date,q.asin,q.search_query,q.search_query_key,
          q.search_query_score,q.search_query_volume,q.total_query_impression_count,
          q.asin_impression_count,q.asin_impression_share,q.total_click_count,q.asin_click_count,
          q.total_cart_add_count,q.asin_cart_add_count,q.total_purchase_count,q.asin_purchase_count,
          p.seller_sku sku,coalesce(p.title,p.seller_sku,q.asin) product,p.image_url
        FROM brand.search_query_performance q
        JOIN mart.catalog_portfolio_product p
          ON p.marketplace_id=q.marketplace_id AND p.asin=q.asin AND p.is_offer_owner
        WHERE q.marketplace_id=%s AND q.report_period='MONTH' AND q.start_date=%s
        """,
        (marketplace, start_date),
    )
    if not rows:
        contract["status"] = "NO_DATA"
        return contract
    if decorate_products:
        rows = decorate_products(rows)
    end_date = max(row["end_date"] for row in rows)
    paid_rows = []
    if ready.get("search_term_rel"):
        paid_rows = _all(
            cur,
            """
            SELECT d.search_term,d.campaign_id,max(c.campaign_name) campaign_name,
              sum(d.spend) spend,sum(d.clicks)::bigint clicks,sum(d.purchases)::bigint purchases,
              sum(d.attributed_sales) attributed_sales
            FROM mart.ads_search_term_daily d
            LEFT JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id
            WHERE d.marketplace_id=%s AND d.business_date BETWEEN %s AND %s
            GROUP BY d.search_term,d.campaign_id
            """,
            (marketplace, start_date, end_date),
        )
    all_items = build_search_query_opportunities(rows, paid_rows, limit=len(rows))
    items = all_items[:SEARCH_QUERY_LIMIT]
    contract.update(
        {
            "status": "READY",
            "period": {"start_date": start_date.isoformat(), "end_date": end_date.isoformat()},
            "items": items,
            "shown": len(items),
            "qualified": len(all_items),
            "source_rows": len(rows),
        }
    )
    return contract


def _readiness_contract(connection: dict, quality: dict, freshness: dict, through) -> dict:
    trusted = bool(quality.get("trusted_for_operating_decisions"))
    summary = (
        f"{freshness['period_observed_days']}/{freshness['period_expected_days']} days observed · "
        f"{freshness['mature_days']} mature · {quality.get('issue_days') or 0} quality issues"
    )
    if trusted and connection.get("degraded"):
        state = "DEGRADED"
        label = connection.get("badge") or "Ads refresh delayed"
        summary = f"Stored data through {through} · {summary}"
    elif trusted and connection.get("refreshing"):
        state = "REFRESHING"
        label = connection.get("badge") or "Ads refresh running"
        summary = f"Stored data through {through} · {summary}"
    else:
        state = "READY" if trusted else "ATTENTION"
        label = "Ready for review" if trusted else "Use with caution"
    return {
        "state": state,
        "label": label,
        "summary": summary,
        "methodology": quality.get("basis"),
    }


def _quality(cur, marketplace: str, through, summary: dict, ready: dict) -> tuple[dict, dict]:
    quality = {
        "state": "NO_DATA",
        "trusted_for_operating_decisions": False,
        "issue_days": 0,
        "issue_account_days": 0,
        "healthy_account_days": 0,
        "accounts_seen": 0,
        "issues": [],
        "accounts": [],
        "basis": (
            "Independent Amazon campaign and advertised-product report grains must reconcile before Ads is "
            "decision-ready. Account rollup consistency is an ingestion invariant, not incrementality evidence."
        ),
    }
    daily_quality = {}
    if not ready.get("quality_rel"):
        return quality, daily_quality
    report = _one(
        cur,
        """
        SELECT count(DISTINCT account_id)::int accounts_seen,
          count(*) FILTER(WHERE quality_state='OK')::int healthy_account_days,
          count(*) FILTER(WHERE quality_state<>'OK')::int issue_account_days,
          count(DISTINCT business_date) FILTER(WHERE quality_state<>'OK')::int issue_days,
          max(latest_ingested_at) latest_ingested_at,
          CASE WHEN count(*)=0 THEN 'NO_DATA'
               WHEN count(*) FILTER(WHERE quality_state<>'OK')=0 THEN 'HEALTHY'
               ELSE 'ATTENTION' END quality_state
        FROM mart.ads_ingestion_quality
        WHERE marketplace_id=%s AND business_date BETWEEN %s::date-27 AND %s::date
        """,
        (marketplace, through, through),
    )
    issues = _all(
        cur,
        """
        SELECT quality_state,count(*)::int account_days,count(DISTINCT business_date)::int days
        FROM mart.ads_ingestion_quality
        WHERE marketplace_id=%s AND business_date BETWEEN %s::date-27 AND %s::date
          AND quality_state<>'OK'
        GROUP BY quality_state ORDER BY days DESC,account_days DESC,quality_state
        """,
        (marketplace, through, through),
    )
    for row in _all(
        cur,
        """
        SELECT business_date,count(*)::int accounts_seen,
          count(*) FILTER(WHERE quality_state<>'OK')::int issue_accounts,
          CASE WHEN count(*) FILTER(WHERE quality_state<>'OK')=0 THEN 'HEALTHY' ELSE 'ATTENTION' END quality_state
        FROM mart.ads_ingestion_quality
        WHERE marketplace_id=%s AND business_date BETWEEN %s::date-89 AND %s::date
        GROUP BY business_date
        """,
        (marketplace, through, through),
    ):
        daily_quality[str(row.get("business_date"))] = row
    accounts = (
        _all(
            cur,
            """
            SELECT account_id,first_date,latest_date,days_seen,healthy_days,issue_days,
              rollup_issue_days,independent_report_issue_days,attribution_contract_issue_days,
              latest_ingested_at,quality_state
            FROM mart.ads_ingestion_quality_summary
            WHERE marketplace_id=%s ORDER BY account_id
            """,
            (marketplace,),
        )
        if ready.get("quality_summary_rel")
        else []
    )
    state = report.get("quality_state") or "NO_DATA"
    complete = int(summary.get("missing_ads_days") or 0) == 0 and int(
        summary.get("observed_ads_days") or 0
    ) >= int(summary.get("expected_ads_days") or 28)
    quality.update(
        {
            "state": state,
            "trusted_for_operating_decisions": state == "HEALTHY" and complete,
            "issue_days": int(report.get("issue_days") or 0),
            "issue_account_days": int(report.get("issue_account_days") or 0),
            "healthy_account_days": int(report.get("healthy_account_days") or 0),
            "accounts_seen": int(report.get("accounts_seen") or 0),
            "latest_ingested_at": report.get("latest_ingested_at"),
            "window_complete": complete,
            "issues": issues,
            "accounts": accounts,
        }
    )
    return quality, daily_quality


def ads_payload(connect, marketplace: str, decorate_products=None, query: dict[str, Any] | None = None) -> dict:
    query_values = _query_values(query)
    with connect() as conn, conn.cursor() as cur:
        connection = ads_connection_state(cur)
        ready = _one(
            cur,
            """
            SELECT to_regclass('mart.ads_business_t28') business_rel,
              to_regclass('mart.ads_product_business_t28') product_rel,
              to_regclass('mart.ads_ingestion_quality') quality_rel,
              to_regclass('mart.ads_ingestion_quality_summary') quality_summary_rel,
              to_regclass('mart.ads_search_term_daily') search_term_rel,
              to_regclass('brand.search_query_performance') search_query_rel
            """,
        )
        if not ready.get("business_rel"):
            return _empty("not_initialized", connection)
        summary = _one(
            cur,
            """
            SELECT marketplace_id,through_date,period_start,spend,attributed_sales,impressions,clicks,
              attributed_purchases AS purchases,attributed_units AS units,total_business_sales,
              ctr,cpc,roas,acos,tacos,attributed_sales_share,observed_ads_days,expected_ads_days,
              missing_ads_days,mature_ads_days,ads_source_generated_at AS source_generated_at,
              ads_ingested_at AS ingested_at,prior_spend,prior_attributed_sales,prior_total_business_sales,
              spend_delta_pct,attributed_sales_delta_pct,tacos_delta_points
            FROM mart.ads_business_t28 WHERE marketplace_id=%s
            """,
            (marketplace,),
        )
        through = summary.get("through_date")
        if not through:
            return _empty("awaiting_ads_data", connection)
        attribution = _one(
            cur,
            """
            SELECT max(business_date) FILTER(WHERE attribution_mature) mature_through_date,
              max(attribution_window) FILTER(WHERE business_date=%s::date) attribution_window,
              max(attribution_method) FILTER(WHERE business_date=%s::date) attribution_method,
              max(attribution_state) FILTER(WHERE business_date=%s::date) latest_attribution_state
            FROM mart.ads_business_daily
            WHERE marketplace_id=%s AND business_date BETWEEN %s::date-89 AND %s::date
            """,
            (through, through, through, marketplace, through, through),
        )
        lookback_days = _attribution_lookback_days(attribution.get("attribution_window"))
        summary.update(
            {
                "period_end": through.isoformat(),
                "period_start": summary.get("period_start").isoformat() if summary.get("period_start") else None,
                "basis": (
                    "Latest 28 Ads dates aligned to independently reconciled seller sales. Amazon-attributed "
                    "conversions can revise; attribution is not incrementality and the residual is not exact organic sales."
                ),
                "attribution_window": attribution.get("attribution_window"),
                "attribution_method": attribution.get("attribution_method"),
                "attribution_lookback_days": lookback_days,
                "prior": {
                    "spend": summary.get("prior_spend") or 0,
                    "attributed_sales": summary.get("prior_attributed_sales") or 0,
                    "total_business_sales": summary.get("prior_total_business_sales") or 0,
                },
            }
        )
        summary = metric_contract(summary)
        mature = attribution.get("mature_through_date")
        latest = attribution.get("latest_attribution_state") or "provisional_attribution"
        freshness = {
            "through_date": through,
            "source_generated_at": summary.get("source_generated_at"),
            "ingested_at": summary.get("ingested_at"),
            "period_expected_days": summary.get("expected_ads_days") or 28,
            "period_observed_days": summary.get("observed_ads_days") or 0,
            "period_missing_days": summary.get("missing_ads_days") or 0,
            "mature_days": summary.get("mature_ads_days") or 0,
            "mature_through_date": mature.isoformat() if mature else None,
            "latest_days_state": latest,
            "attribution_window": attribution.get("attribution_window"),
            "attribution_method": attribution.get("attribution_method"),
            "freshness_note": (
                "Attribution maturity is supplied by the warehouse reporting contract. Recent conversion metrics "
                "can revise until the applicable Amazon Ads lookback window has ended."
            ),
        }
        quality, daily_quality = _quality(cur, marketplace, through, summary, ready)
        daily = _all(
            cur,
            """
            SELECT business_date,ad_spend AS spend,attributed_sales,impressions,clicks,
              attributed_purchases AS purchases,attributed_units AS units,total_business_sales,
              ctr,cpc,roas,acos,tacos,attributed_sales_share,attribution_method,attribution_window,
              attribution_mature,attribution_state
            FROM mart.ads_business_daily
            WHERE marketplace_id=%s AND business_date BETWEEN %s::date-89 AND %s::date
            ORDER BY business_date
            """,
            (marketplace, through, through),
        )
        for index, row in enumerate(daily):
            row = metric_contract(row)
            quality_row = daily_quality.get(str(row.get("business_date")))
            row["quality_state"] = quality_row.get("quality_state") if quality_row else "NO_DATA"
            row["quality_issue_accounts"] = int(quality_row.get("issue_accounts") or 0) if quality_row else 0
            row["quality_accounts_seen"] = int(quality_row.get("accounts_seen") or 0) if quality_row else 0
            daily[index] = row
        campaigns = _all(
            cur,
            """
            SELECT d.account_id,c.campaign_id,max(c.campaign_name) campaign_name,max(c.ad_product) ad_product,
              sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,sum(d.impressions) impressions,
              sum(d.clicks) clicks,sum(d.purchases) purchases,sum(d.units) units
            FROM ads.daily_campaign d
            JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id
            JOIN ads.account a ON a.account_id=d.account_id
            WHERE a.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date
            GROUP BY d.account_id,c.campaign_id ORDER BY spend DESC LIMIT 40
            """,
            (marketplace, through, through),
        )
        products = (
            _all(
                cur,
                """
                SELECT p.sku,p.asin,coalesce(sl.item_name,ci.title,s.title,p.sku,p.asin) product,
                  coalesce(sl.image_url,ci.image_url) image_url,p.spend,p.attributed_sales,p.impressions,
                  p.clicks,p.attributed_purchases AS purchases,p.attributed_units AS units,
                  p.total_business_sales,p.total_business_orders,p.total_business_units,p.ctr,p.cpc,p.roas,
                  p.acos,p.tacos,p.attributed_sales_share,p.observed_ads_days,p.mature_ads_days,
                  p.through_date,p.period_start
                FROM mart.ads_product_business_t28 p
                LEFT JOIN core.sku s ON s.sku=p.sku
                LEFT JOIN core.seller_listing sl ON sl.marketplace_id=p.marketplace_id AND sl.seller_sku=p.sku
                LEFT JOIN core.catalog_item ci
                  ON ci.marketplace_id=p.marketplace_id AND ci.asin=coalesce(p.asin,s.asin)
                WHERE p.marketplace_id=%s ORDER BY p.spend DESC LIMIT 60
                """,
                (marketplace,),
            )
            if ready.get("product_rel")
            else []
        )
        if decorate_products:
            products = decorate_products(products)
        products = enrich_products(
            products,
            trusted=bool(quality.get("trusted_for_operating_decisions")),
            attribution_lookback_days=lookback_days,
        )
        associations = _all(
            cur,
            """
            SELECT p.account_id,p.campaign_id,p.ad_group_id,
              nullif(p.advertised_sku,'') sku,nullif(p.advertised_asin,'') asin,sum(p.spend) spend
            FROM ads.daily_advertised_product p
            JOIN ads.account a USING(account_id)
            WHERE a.marketplace_id=%s AND p.business_date BETWEEN %s::date-27 AND %s::date
            GROUP BY p.account_id,p.campaign_id,p.ad_group_id,
              nullif(p.advertised_sku,''),nullif(p.advertised_asin,'')
            """,
            (marketplace, through, through),
        )
        product_index = product_reference_index(products, associations)
        campaigns = [metric_contract(row) for row in campaigns]
        for row in campaigns:
            row["product_refs"] = refs_for_row(row, product_index)
        targets = (
            _all(
                cur,
                """
                SELECT d.account_id,d.target_id,d.campaign_id,d.ad_group_id,
                  max(c.campaign_name) campaign_name,max(d.target_type) target_type,
                  max(d.target_expression) target_expression,max(d.match_type) match_type,
                  sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,sum(d.impressions) impressions,
                  sum(d.clicks) clicks,sum(d.purchases) purchases,sum(d.units) units
                FROM mart.ads_target_daily d
                LEFT JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id
                WHERE d.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date
                GROUP BY d.account_id,d.target_id,d.campaign_id,d.ad_group_id
                ORDER BY spend DESC LIMIT 500
                """,
                (marketplace, through, through),
            )
            if _one(cur, "SELECT to_regclass('mart.ads_target_daily') rel").get("rel")
            else []
        )
        search_terms = (
            _all(
                cur,
                """
                SELECT d.account_id,d.search_term,d.campaign_id,d.ad_group_id,d.target_id,
                  max(c.campaign_name) campaign_name,max(d.match_type) match_type,
                  sum(d.spend) spend,sum(d.attributed_sales) attributed_sales,sum(d.impressions) impressions,
                  sum(d.clicks) clicks,sum(d.purchases) purchases,sum(d.units) units
                FROM mart.ads_search_term_daily d
                LEFT JOIN ads.campaign c ON c.account_id=d.account_id AND c.campaign_id=d.campaign_id
                WHERE d.marketplace_id=%s AND d.business_date BETWEEN %s::date-27 AND %s::date
                GROUP BY d.account_id,d.search_term,d.campaign_id,d.ad_group_id,d.target_id
                ORDER BY spend DESC LIMIT 500
                """,
                (marketplace, through, through),
            )
            if _one(cur, "SELECT to_regclass('mart.ads_search_term_daily') rel").get("rel")
            else []
        )
        search_opportunities = _search_opportunities_contract(
            cur, marketplace, ready, decorate_products
        )

    trusted = bool(quality.get("trusted_for_operating_decisions"))
    observed_days = int(freshness.get("period_observed_days") or 0)
    mature_days = int(freshness.get("mature_days") or 0)
    demand_signals = [
        normalize_demand_signal(
            row,
            source="target",
            product_refs=refs_for_row(row, product_index),
            trusted=trusted,
            mature_days=mature_days,
            observed_days=observed_days,
            attribution_lookback_days=lookback_days,
        )
        for row in targets
    ] + [
        normalize_demand_signal(
            row,
            source="search_term",
            product_refs=refs_for_row(row, product_index),
            trusted=trusted,
            mature_days=mature_days,
            observed_days=observed_days,
            attribution_lookback_days=lookback_days,
        )
        for row in search_terms
    ]
    actions, action_groups = build_action_groups(products, demand_signals) if trusted else ([], [])
    readiness = _readiness_contract(connection, quality, freshness, through)
    return {
        "status": "ready",
        "connection": connection,
        "freshness": freshness,
        "quality": quality,
        "readiness": readiness,
        "summary": summary,
        "daily": daily,
        "campaigns": campaigns,
        "products": products,
        "demand": demand_page(demand_signals, query_values),
        "demand_totals": {"targets": len(targets), "search_terms": len(search_terms)},
        "search_opportunities": search_opportunities,
        "actions": actions,
        "action_groups": action_groups,
        "interpretation_rules": INTERPRETATION_RULES,
        "economics": ECONOMICS_CONTRACT,
    }
