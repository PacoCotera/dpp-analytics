from __future__ import annotations

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import os
import re
import time
from collections.abc import Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from . import db
from .amazon_ads import AmazonAdsClient
from .settings import settings
from .spapi import SpApiClient, SpApiError

BUSINESS_TIMEZONE = ZoneInfo("America/Mexico_City")
PROBE_MARKER = "amazon-source-readiness-v1"
REPORT_TIMEOUT_SECONDS = int(
    os.getenv("AMAZON_SOURCE_PROBE_REPORT_TIMEOUT_SECONDS", "3600")
)
REPORT_POLL_SECONDS = int(os.getenv("AMAZON_SOURCE_PROBE_REPORT_POLL_SECONDS", "10"))


@dataclass(frozen=True)
class Capability:
    key: str
    domain: str
    source: str
    grain: str
    identity: str
    freshness: str
    retention: str
    decision_use: str
    authority: str
    initial_disposition: str
    probe: str | None = None


@dataclass(frozen=True)
class ReportSpec:
    key: str
    report_type: str
    window: str = "none"
    report_period: str | None = None
    asin_option: str | None = None
    extra_options: tuple[tuple[str, str], ...] = ()
    prefer_recent: bool = False


CAPABILITIES: tuple[Capability, ...] = (
    Capability(
        "orders_extended",
        "Commerce",
        "Orders v2026 includedData",
        "order and item",
        "order, SKU, ASIN",
        "near current",
        "source API",
        "Cancellation, tax, proceeds, promotion, fulfillment and expense context",
        "supporting and reconciling",
        "ingest now",
        "spapi_inline",
    ),
    Capability(
        "finances_items",
        "Economics",
        "Finances v2024 transactions",
        "transaction, item and breakdown",
        "order, SKU, ASIN",
        "posted transactions",
        "source API",
        "Actual Amazon charges, refunds, ad payments and item economics",
        "authoritative after reconciliation",
        "ingest now",
        "warehouse_and_inline",
    ),
    Capability(
        "data_kiosk_sales_traffic",
        "Commerce",
        "Data Kiosk seller sales and traffic",
        "account/day and child ASIN/day",
        "ASIN",
        "daily, revisable",
        "DPP history plus Amazon query retention",
        "Ordered sales, sessions, conversion and refunds",
        "authoritative retail evidence",
        "already ingested",
        "spapi_inline",
    ),
    Capability(
        "catalog_full",
        "Product",
        "Catalog Items v2022",
        "ASIN snapshot",
        "ASIN and variation family",
        "daily snapshot",
        "DPP retained",
        "Product identity, relationships, dimensions, ranks and presentation",
        "supporting",
        "expand now",
        "spapi_inline",
    ),
    Capability(
        "competitive_pricing",
        "Product",
        "Product Pricing v2022",
        "ASIN offer snapshot",
        "ASIN",
        "point in time",
        "DPP retained",
        "Featured offer and reference-price context",
        "supporting only",
        "ingest now",
        "spapi_inline",
    ),
    Capability(
        "product_fee_estimate",
        "Economics",
        "Product Fees v0",
        "SKU or ASIN estimate",
        "SKU and ASIN",
        "point in time estimate",
        "DPP retained",
        "Current referral and fulfillment fee planning input",
        "estimate, never accounting fact",
        "ingest now",
        "spapi_inline",
    ),
    Capability(
        "listings_snapshot",
        "Product",
        "All Listings report",
        "seller SKU snapshot",
        "SKU and ASIN",
        "6-hour collection",
        "DPP retained",
        "Listing status, fulfillment, price and offer membership",
        "supporting safety gate",
        "already ingested",
        "warehouse",
    ),
    Capability(
        "settlement_v2",
        "Economics",
        "Settlement V2 report",
        "settlement line",
        "order and SKU where supplied",
        "Amazon-generated settlement",
        "DPP retained",
        "Closed-period accounting and actual charges",
        "authoritative after reconciliation",
        "already ingested",
        "warehouse",
    ),
    Capability(
        "brand_sqp_week",
        "Demand",
        "Brand Analytics Search Query Performance",
        "ASIN, query, week",
        "ASIN and query",
        "completed week",
        "Amazon period limits; retain in DPP",
        "Query funnel, share and conversion diagnosis",
        "supporting, not ad incrementality",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "brand_search_catalog_week",
        "Demand",
        "Brand Analytics Search Catalog Performance",
        "ASIN, week",
        "ASIN",
        "completed week",
        "retain in DPP",
        "Organic-plus-paid discovery and listing funnel diagnosis",
        "supporting",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "brand_market_basket",
        "Demand",
        "Brand Analytics Market Basket",
        "ASIN pair and period",
        "ASIN",
        "completed week",
        "retain in DPP",
        "Cross-sell and halo context",
        "supporting",
        "retain for later",
        "spapi_report",
    ),
    Capability(
        "brand_search_terms",
        "Demand",
        "Brand Analytics Amazon Search Terms",
        "market query and clicked ASIN",
        "query and ASIN",
        "completed week",
        "retain in DPP",
        "Market demand and competitor click/conversion share",
        "supporting",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "brand_repeat_purchase",
        "Demand",
        "Brand Analytics Repeat Purchase",
        "ASIN and period",
        "ASIN",
        "completed week",
        "retain in DPP",
        "Repeat behavior and customer-value context",
        "supporting",
        "retain for later",
        "spapi_report",
    ),
    Capability(
        "fba_shipments",
        "Commerce",
        "FBA Customer Shipment Sales",
        "shipped order item",
        "order, SKU, ASIN",
        "1-3 hours usually",
        "retain in DPP",
        "Shipped units and price cross-check",
        "reconciliation source",
        "supporting evidence",
        "spapi_report",
    ),
    Capability(
        "inventory_ledger",
        "Inventory",
        "FBA Inventory Ledger detail",
        "inventory movement",
        "SKU, FNSKU, ASIN",
        "daily/requested",
        "18 months at source",
        "Returns, losses, damage, receipts and shipment movement",
        "authoritative inventory evidence",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "reserved_inventory",
        "Inventory",
        "FBA Reserved Inventory",
        "SKU snapshot",
        "SKU, FNSKU, ASIN",
        "near real time",
        "retain in DPP",
        "Inventory that cannot safely support increased spend",
        "safety gate",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "inventory_health",
        "Inventory",
        "FBA Manage Inventory Health",
        "SKU snapshot",
        "SKU, FNSKU, ASIN",
        "current snapshot",
        "retain in DPP",
        "Aged/excess units, sell-through, days of supply and storage exposure",
        "safety and supporting",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "stranded_inventory",
        "Inventory",
        "FBA Stranded Inventory",
        "SKU snapshot",
        "SKU, FNSKU, ASIN",
        "near real time",
        "retain in DPP",
        "Suppress spend increases when inventory is stranded",
        "hard safety gate",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "restock_recommendations",
        "Inventory",
        "FBA Restock Inventory",
        "SKU snapshot",
        "SKU, FNSKU, ASIN",
        "near real time",
        "retain in DPP",
        "Supply timing and constraint evidence",
        "supporting; Amazon recommendation is not authoritative",
        "supporting evidence",
        "spapi_report",
    ),
    Capability(
        "fba_fee_preview",
        "Economics",
        "FBA Fee Preview",
        "active FBA offer",
        "SKU, FNSKU, ASIN",
        "at least every 72 hours",
        "retain in DPP",
        "Estimated referral and fulfillment fee basis",
        "estimate, never actual charge",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "referral_fee_preview",
        "Economics",
        "Referral Fee Preview",
        "open listing",
        "SKU",
        "up to 24 hours old",
        "retain in DPP",
        "Independent referral-fee estimate cross-check",
        "estimate, never actual charge",
        "supporting evidence",
        "spapi_report",
    ),
    Capability(
        "storage_fees",
        "Economics",
        "FBA Storage Fees",
        "ASIN and fulfillment center",
        "ASIN and FNSKU",
        "monthly estimate",
        "retain in DPP",
        "Inventory carrying-cost evidence",
        "estimate until settled",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "fba_returns",
        "Economics",
        "FBA Customer Returns",
        "returned unit",
        "order, SKU, ASIN",
        "daily",
        "retain in DPP",
        "Return reason and disposition by product",
        "authoritative operational evidence",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "fba_reimbursements",
        "Economics",
        "FBA Reimbursements",
        "reimbursement item",
        "order, SKU, ASIN",
        "daily",
        "retain in DPP",
        "Reimbursement offsets and inventory-loss economics",
        "authoritative after settlement reconciliation",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "fba_replacements",
        "Economics",
        "FBA Replacements",
        "replacement item",
        "original and replacement order, SKU, ASIN",
        "daily",
        "retain in DPP",
        "Hidden replacement cost and product-quality evidence",
        "supporting",
        "ingest now",
        "spapi_report",
    ),
    Capability(
        "promotion_performance",
        "Commerce",
        "Promotion Performance report",
        "promotion and product",
        "promotion and ASIN/SKU when supplied",
        "requested period",
        "retain in DPP",
        "Separate promotion effects from advertising effects",
        "confounder evidence",
        "probe then decide",
        "spapi_report",
    ),
    Capability(
        "coupon_performance",
        "Commerce",
        "Coupon Performance report",
        "coupon and product",
        "coupon and ASIN/SKU when supplied",
        "requested period",
        "retain in DPP",
        "Separate coupon effects from advertising effects",
        "confounder evidence",
        "probe then decide",
        "spapi_report",
    ),
    Capability(
        "ads_product_extended",
        "Advertising",
        "SP Advertised Product report",
        "advertised SKU/ASIN and campaign",
        "campaign, ad group, SKU, ASIN",
        "daily; attribution revises",
        "95 days at source",
        "Same-SKU versus halo economics by advertised product",
        "attributed, not incremental",
        "ingest now",
        "ads_report",
    ),
    Capability(
        "ads_placement",
        "Advertising",
        "SP Campaign Placement report",
        "campaign and placement",
        "campaign and placement",
        "daily; attribution revises",
        "95 days at source",
        "Placement-level capital allocation",
        "attributed, not incremental",
        "ingest now",
        "ads_report",
    ),
    Capability(
        "ads_purchased_product",
        "Advertising",
        "SP Purchased Product report",
        "advertised and purchased ASIN",
        "campaign, target/keyword, advertised ASIN, purchased ASIN",
        "daily; attribution revises",
        "95 days at source",
        "Quantify product halo without calling it incrementality",
        "attributed, not incremental",
        "ingest now",
        "ads_report",
    ),
    Capability(
        "ads_target_extended",
        "Advertising",
        "SP Targeting report",
        "target or keyword",
        "campaign, ad group, target/keyword",
        "daily; attribution revises",
        "95 days at source",
        "Bid, status, same-SKU and halo target economics",
        "attributed, not incremental",
        "ingest now",
        "ads_report",
    ),
    Capability(
        "ads_search_term_extended",
        "Advertising",
        "SP Search Term report",
        "clicked shopper query",
        "campaign, ad group, target/keyword, query",
        "daily; click-qualified only",
        "65 days at source",
        "Harvest, negate or test query decisions",
        "attributed, not incremental",
        "ingest now and backfill immediately",
        "ads_report",
    ),
    Capability(
        "ads_entities",
        "Advertising",
        "SP campaign-management lists",
        "entity snapshot",
        "campaign, ad group, ad, target, keyword",
        "point in time",
        "retain changes in DPP",
        "Names, state, bids, strategy, serving status and change evidence",
        "authoritative entity state",
        "ingest now",
        "ads_management",
    ),
    Capability(
        "ads_negatives",
        "Advertising",
        "SP negative keyword/target lists",
        "negative entity snapshot",
        "campaign, ad group, keyword/target",
        "point in time",
        "retain changes in DPP",
        "Avoid unsafe duplicate or conflicting recommendations",
        "hard recommendation guard",
        "ingest now",
        "ads_management",
    ),
    Capability(
        "ads_portfolios",
        "Advertising",
        "Portfolios v3",
        "portfolio snapshot",
        "portfolio and campaign",
        "point in time",
        "retain changes in DPP",
        "Owner capital pools, caps and campaign grouping",
        "authoritative entity state",
        "ingest now",
        "ads_management",
    ),
    Capability(
        "ads_budget_usage",
        "Advertising",
        "SP campaign budget usage",
        "campaign snapshot",
        "campaign",
        "near current",
        "retain observations in DPP",
        "Budget exhaustion and pacing diagnosis",
        "authoritative observation",
        "ingest now",
        "ads_management",
    ),
    Capability(
        "ads_budget_recommendations",
        "Advertising",
        "SP budget recommendations",
        "campaign estimate",
        "campaign",
        "daily estimate",
        "retain evidence in DPP",
        "Missed-opportunity ranges and percent time in budget",
        "Amazon estimate, never forecast fact",
        "supporting evidence",
        "ads_management",
    ),
    Capability(
        "ads_budget_rules",
        "Advertising",
        "SP budget rules",
        "rule and campaign",
        "campaign and rule",
        "point in time",
        "retain changes in DPP",
        "Explain automated budget changes and prevent conflicts",
        "hard recommendation guard",
        "ingest now",
        "ads_management",
    ),
    Capability(
        "ads_product_recommendations",
        "Advertising",
        "SP product-target recommendations",
        "advertised ASIN and suggested target ASIN",
        "ASIN",
        "current recommendation",
        "retain evidence in DPP",
        "Candidate discovery for controlled tests",
        "Amazon suggestion only",
        "retain for later",
        None,
    ),
    Capability(
        "marketing_stream",
        "Advertising",
        "Amazon Marketing Stream",
        "hourly delta plus messages",
        "campaign, ad group, ad, target and placement",
        "near real time",
        "forward-only after subscription",
        "Intraday placement/target combinations, budget and entity changes",
        "supporting until reconciled to daily reports",
        "retain for later; AWS dependency",
        "ads_management",
    ),
)


REPORT_SPECS: tuple[ReportSpec, ...] = (
    ReportSpec(
        "brand_sqp_week",
        "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT",
        "last_week",
        "WEEK",
        "asin",
    ),
    ReportSpec(
        "brand_search_catalog_week",
        "GET_BRAND_ANALYTICS_SEARCH_CATALOG_PERFORMANCE_REPORT",
        "last_week",
        "WEEK",
        "asins",
    ),
    ReportSpec(
        "brand_market_basket",
        "GET_BRAND_ANALYTICS_MARKET_BASKET_REPORT",
        "last_week",
        "WEEK",
    ),
    ReportSpec(
        "brand_search_terms",
        "GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT",
        "last_week",
        "WEEK",
    ),
    ReportSpec(
        "brand_repeat_purchase",
        "GET_BRAND_ANALYTICS_REPEAT_PURCHASE_REPORT",
        "last_week",
        "WEEK",
    ),
    ReportSpec(
        "fba_shipments",
        "GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_SALES_DATA",
        "last_30_days",
    ),
    ReportSpec(
        "inventory_ledger",
        "GET_LEDGER_DETAIL_VIEW_DATA",
        "last_30_days",
        extra_options=(("eventType", ""),),
    ),
    ReportSpec("reserved_inventory", "GET_RESERVED_INVENTORY_DATA"),
    ReportSpec("inventory_health", "GET_FBA_INVENTORY_PLANNING_DATA"),
    ReportSpec("stranded_inventory", "GET_STRANDED_INVENTORY_UI_DATA"),
    ReportSpec(
        "restock_recommendations", "GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT"
    ),
    ReportSpec(
        "fba_fee_preview",
        "GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA",
        "last_4_days",
        prefer_recent=True,
    ),
    ReportSpec(
        "referral_fee_preview", "GET_REFERRAL_FEE_PREVIEW_REPORT", prefer_recent=True
    ),
    ReportSpec(
        "storage_fees",
        "GET_FBA_STORAGE_FEE_CHARGES_DATA",
        "last_closed_month",
        prefer_recent=True,
    ),
    ReportSpec(
        "fba_returns", "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA", "last_60_days"
    ),
    ReportSpec("fba_reimbursements", "GET_FBA_REIMBURSEMENTS_DATA", "last_60_days"),
    ReportSpec(
        "fba_replacements",
        "GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA",
        "last_60_days",
    ),
    ReportSpec(
        "promotion_performance", "GET_PROMOTION_PERFORMANCE_REPORT", "last_90_days"
    ),
    ReportSpec("coupon_performance", "GET_COUPON_PERFORMANCE_REPORT", "last_90_days"),
)


ADS_REPORT_CONFIGS: dict[str, dict[str, Any]] = {
    "ads_product_extended": {
        "reportTypeId": "spAdvertisedProduct",
        "groupBy": ["advertiser"],
        "columns": [
            "campaignId",
            "campaignName",
            "adGroupId",
            "adId",
            "advertisedSku",
            "advertisedAsin",
            "portfolioId",
            "impressions",
            "clicks",
            "cost",
            "purchases7d",
            "purchasesSameSku7d",
            "sales7d",
            "attributedSalesSameSku7d",
            "salesOtherSku7d",
            "unitsSoldOtherSku7d",
            "campaignBudgetAmount",
            "campaignBudgetType",
            "campaignStatus",
        ],
    },
    "ads_placement": {
        "reportTypeId": "spCampaigns",
        "groupBy": ["campaignPlacement"],
        "columns": [
            "campaignId",
            "campaignName",
            "placementClassification",
            "impressions",
            "clicks",
            "cost",
            "purchases7d",
            "purchasesSameSku7d",
            "sales7d",
            "attributedSalesSameSku7d",
            "campaignBiddingStrategy",
            "campaignBudgetAmount",
            "campaignBudgetType",
            "campaignRuleBasedBudgetAmount",
            "campaignApplicableBudgetRuleId",
            "campaignApplicableBudgetRuleName",
            "topOfSearchImpressionShare",
        ],
    },
    "ads_purchased_product": {
        "reportTypeId": "spPurchasedProduct",
        "groupBy": ["asin"],
        "columns": [
            "campaignId",
            "campaignName",
            "adGroupId",
            "keywordId",
            "keyword",
            "keywordType",
            "matchType",
            "advertisedSku",
            "advertisedAsin",
            "purchasedAsin",
            "purchases7d",
            "sales7d",
            "purchasesOtherSku7d",
            "salesOtherSku7d",
            "unitsSoldOtherSku7d",
        ],
    },
    "ads_target_extended": {
        "reportTypeId": "spTargeting",
        "groupBy": ["targeting"],
        "columns": [
            "campaignId",
            "campaignName",
            "adGroupId",
            "keywordId",
            "keyword",
            "keywordType",
            "targeting",
            "matchType",
            "keywordBid",
            "adKeywordStatus",
            "portfolioId",
            "impressions",
            "clicks",
            "cost",
            "purchases7d",
            "purchasesSameSku7d",
            "sales7d",
            "attributedSalesSameSku7d",
            "salesOtherSku7d",
            "unitsSoldOtherSku7d",
            "topOfSearchImpressionShare",
        ],
    },
    "ads_search_term_extended": {
        "reportTypeId": "spSearchTerm",
        "groupBy": ["searchTerm"],
        "columns": [
            "campaignId",
            "campaignName",
            "adGroupId",
            "keywordId",
            "keyword",
            "keywordType",
            "targeting",
            "searchTerm",
            "matchType",
            "keywordBid",
            "adKeywordStatus",
            "portfolioId",
            "impressions",
            "clicks",
            "cost",
            "purchases7d",
            "purchasesSameSku7d",
            "sales7d",
            "attributedSalesSameSku7d",
            "salesOtherSku7d",
            "unitsSoldOtherSku7d",
        ],
    },
}


def _payload(value: dict[str, Any]) -> dict[str, Any]:
    nested = value.get("payload")
    return nested if isinstance(nested, dict) else value


def _safe_error(exc: BaseException | str) -> str:
    text = str(exc)
    text = re.sub(r"Atza\|[^\s\"']+", "[ACCESS_TOKEN]", text)
    text = re.sub(
        r"\b[0-9a-f]{8}-[0-9a-f-]{27,}\b",
        "[UUID]",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\b\d{3}-\d{7}-\d{7}\b", "[ORDER_ID]", text)
    text = re.sub(r"\b[A-Z0-9]{10}\b", "[ASIN]", text)
    text = re.sub(r"\b\d{12,}\b", "[NUMERIC_ID]", text)
    # Vendor errors can echo a campaign name, query or request value. Preserve
    # the error category and HTTP status while removing quoted payload values.
    text = re.sub(r'"(?:\\.|[^"\\])*"', '"[VALUE]"', text)
    text = re.sub(r"'(?:\\.|[^'\\])*'", "'[VALUE]'", text)
    return text[:700]


def _attempt(fn: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - every independent probe must report its own state
        message = _safe_error(exc)
        lowered = message.lower()
        if "http 401" in lowered or "http 403" in lowered or "access denied" in lowered:
            state = "unauthorized"
        elif "not supported" in lowered or "invalid reporttype" in lowered:
            state = "unsupported"
        else:
            state = "error"
        return {
            "state": state,
            "authorized": False if state == "unauthorized" else None,
            "error": message,
        }


def field_paths(value: Any, *, limit: int = 120) -> list[str]:
    found: set[str] = set()

    def walk(item: Any, prefix: str, depth: int) -> None:
        if len(found) >= limit or depth > 6:
            return
        if isinstance(item, dict):
            for key in sorted(str(k) for k in item):
                path = f"{prefix}.{key}" if prefix else key
                found.add(path)
                walk(item.get(key), path, depth + 1)
        elif isinstance(item, list):
            for child in item[:3]:
                walk(child, prefix, depth + 1)

    walk(value, "", 0)
    return sorted(found)[:limit]


def _first_list(value: Any) -> list[Any]:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for candidate in value.values():
            rows = _first_list(candidate)
            if rows:
                return rows
    return []


def summarize_payload(value: Any) -> dict[str, Any]:
    rows = _first_list(value)
    return {
        "sample_count": len(rows),
        "field_paths": field_paths(value),
        "populated": bool(rows) or bool(value),
    }


def last_completed_week(today: dt.date) -> tuple[dt.date, dt.date]:
    days_since_saturday = (today.weekday() - 5) % 7
    end = today - dt.timedelta(days=days_since_saturday)
    if end >= today:
        end -= dt.timedelta(days=7)
    return end - dt.timedelta(days=6), end


def _window(spec: ReportSpec, today: dt.date) -> tuple[dt.date, dt.date] | None:
    if spec.window == "none":
        return None
    if spec.window == "last_week":
        return last_completed_week(today)
    if spec.window == "last_closed_month":
        end = today.replace(day=1) - dt.timedelta(days=1)
        return end.replace(day=1), end
    days = int(spec.window.removeprefix("last_").removesuffix("_days"))
    end = today - dt.timedelta(days=1)
    return end - dt.timedelta(days=days - 1), end


def report_request_body(spec: ReportSpec, asin: str, today: dt.date) -> dict[str, Any]:
    body: dict[str, Any] = {
        "reportType": spec.report_type,
        "marketplaceIds": [settings.marketplace_id],
    }
    period = _window(spec, today)
    if period:
        body["dataStartTime"] = f"{period[0].isoformat()}T00:00:00Z"
        body["dataEndTime"] = f"{period[1].isoformat()}T23:59:59Z"
    options = dict(spec.extra_options)
    if spec.report_period:
        options["reportPeriod"] = spec.report_period
    if spec.asin_option:
        options[spec.asin_option] = asin
    if options:
        body["reportOptions"] = options
    return body


def _sample_product() -> dict[str, Any]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT sku, asin, COALESCE(list_price, 1) AS price
            FROM core.sku
            WHERE active AND NULLIF(btrim(asin),'') IS NOT NULL
            ORDER BY updated_at DESC NULLS LAST, sku
            LIMIT 1
            """
        )
        row = cur.fetchone() or {}
    if not row.get("sku") or not row.get("asin"):
        raise RuntimeError("No active SKU/ASIN is available for capability probes")
    return dict(row)


def _inline_spapi(
    client: SpApiClient, sample: dict[str, Any]
) -> dict[str, dict[str, Any]]:
    now = dt.datetime.now(dt.timezone.utc)
    before = now - dt.timedelta(minutes=5)
    after = before - dt.timedelta(days=30)
    results: dict[str, dict[str, Any]] = {}

    def orders() -> dict[str, Any]:
        payload = client.get(
            "/orders/2026-01-01/orders",
            params={
                "lastUpdatedAfter": after.isoformat().replace("+00:00", "Z"),
                "lastUpdatedBefore": before.isoformat().replace("+00:00", "Z"),
                "marketplaceIds": settings.marketplace_id,
                "maxResultsPerPage": 5,
                "includedData": "PROCEEDS,EXPENSE,PROMOTION,CANCELLATION,FULFILLMENT,TAX",
            },
        )
        summary = summarize_payload(payload.get("orders") or [])
        return {
            "state": "authorized_populated"
            if summary["sample_count"]
            else "authorized_empty",
            "authorized": True,
            **summary,
        }

    results["orders_extended"] = _attempt(orders)

    def finances() -> dict[str, Any]:
        payload = client.get(
            "/finances/2024-06-19/transactions",
            params={
                "postedAfter": after.isoformat().replace("+00:00", "Z"),
                "postedBefore": before.isoformat().replace("+00:00", "Z"),
                "marketplaceId": settings.marketplace_id,
            },
        )
        transactions = _payload(payload).get("transactions") or []
        item_transactions = sum(
            bool(row.get("items")) for row in transactions if isinstance(row, dict)
        )
        context_transactions = sum(
            bool(row.get("contexts")) for row in transactions if isinstance(row, dict)
        )
        item_context_transactions = sum(
            any(
                bool(item.get("contexts"))
                for item in row.get("items") or []
                if isinstance(item, dict)
            )
            for row in transactions
            if isinstance(row, dict)
        )
        return {
            "state": "authorized_populated" if transactions else "authorized_empty",
            "authorized": True,
            "sample_count": len(transactions),
            "transactions_with_items": item_transactions,
            "transactions_with_contexts": context_transactions,
            "transactions_with_item_contexts": item_context_transactions,
            "field_paths": field_paths(transactions),
            "populated": bool(transactions),
        }

    results["finances_items"] = _attempt(finances)

    def kiosk() -> dict[str, Any]:
        payload = client.get("/dataKiosk/2023-11-15/queries")
        queries = _payload(payload).get("queries") or []
        states: dict[str, int] = {}
        for query in queries:
            if not isinstance(query, dict):
                continue
            state = str(
                query.get("processingStatus") or query.get("status") or "UNKNOWN"
            )
            states[state] = states.get(state, 0) + 1
        return {
            "state": "authorized_populated" if queries else "authorized_empty",
            "authorized": True,
            "sample_count": len(queries),
            "query_states": states,
            "field_paths": field_paths(queries),
            "populated": bool(queries),
        }

    results["data_kiosk_sales_traffic"] = _attempt(kiosk)

    def catalog() -> dict[str, Any]:
        payload = client.get(
            f"/catalog/2022-04-01/items/{sample['asin']}",
            params={
                "marketplaceIds": settings.marketplace_id,
                "includedData": "attributes,classifications,dimensions,identifiers,images,productTypes,relationships,salesRanks,summaries,vendorDetails",
            },
        )
        return {
            "state": "authorized_populated",
            "authorized": True,
            "sample_count": 1,
            "field_paths": field_paths(payload),
            "populated": bool(payload),
        }

    results["catalog_full"] = _attempt(catalog)

    def pricing() -> dict[str, Any]:
        payload = client.post(
            "/batches/products/pricing/2022-05-01/items/competitiveSummary",
            json_body={
                "requests": [
                    {
                        "asin": sample["asin"],
                        "marketplaceId": settings.marketplace_id,
                        "includedData": ["featuredBuyingOptions", "referencePrices"],
                        "uri": "/products/pricing/2022-05-01/items/competitiveSummary",
                        "method": "GET",
                    }
                ]
            },
        )
        return {
            "state": "authorized_populated"
            if payload.get("responses")
            else "authorized_empty",
            "authorized": True,
            **summarize_payload(payload),
        }

    results["competitive_pricing"] = _attempt(pricing)

    def fees() -> dict[str, Any]:
        price = max(float(sample.get("price") or 1), 1.0)
        payload = client.post(
            f"/products/fees/v0/items/{sample['asin']}/feesEstimate",
            json_body={
                "FeesEstimateRequest": {
                    "MarketplaceId": settings.marketplace_id,
                    "IsAmazonFulfilled": True,
                    "PriceToEstimateFees": {
                        "ListingPrice": {"CurrencyCode": "MXN", "Amount": price},
                        "Shipping": {"CurrencyCode": "MXN", "Amount": 0},
                    },
                    "Identifier": PROBE_MARKER,
                }
            },
        )
        return {
            "state": "authorized_populated" if payload else "authorized_empty",
            "authorized": True,
            "sample_count": 1 if payload else 0,
            "field_paths": field_paths(payload),
            "populated": bool(payload),
        }

    results["product_fee_estimate"] = _attempt(fees)
    return results


def _download_spapi_report(client: SpApiClient, document_id: str) -> dict[str, Any]:
    meta = _payload(
        client.get(
            f"/reports/2021-06-30/documents/{document_id}",
            params={"enableContentEncodingUrlHeader": "true"},
        )
    )
    url = meta.get("url")
    if not url:
        raise SpApiError("Report document did not contain a download URL")
    with httpx.Client(
        timeout=httpx.Timeout(120.0, connect=20.0), follow_redirects=True
    ) as http:
        response = http.get(str(url))
        response.raise_for_status()
        raw = response.content
    # httpx transparently decodes a Content-Encoding response. Only decompress
    # when the returned bytes still carry the gzip signature.
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    text = raw.decode("utf-8-sig", errors="replace")
    stripped = text.lstrip()
    if stripped.startswith(("{", "[")):
        payload = json.loads(text)
        return {"format": "json", **summarize_payload(payload)}
    reader = csv.DictReader(io.StringIO(text), delimiter="\t")
    rows = list(reader)
    return {
        "format": "tab",
        "sample_count": len(rows),
        "field_paths": sorted(reader.fieldnames or []),
        "populated": bool(rows),
    }


def _recent_report(client: SpApiClient, spec: ReportSpec) -> dict[str, Any] | None:
    created_since = (
        (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2))
        .isoformat()
        .replace("+00:00", "Z")
    )
    payload = _payload(
        client.get(
            "/reports/2021-06-30/reports",
            params={
                "reportTypes": spec.report_type,
                "pageSize": 10,
                "createdSince": created_since,
            },
        )
    )
    reports = [row for row in payload.get("reports") or [] if isinstance(row, dict)]
    reports.sort(key=lambda row: str(row.get("createdTime") or ""), reverse=True)
    return reports[0] if reports else None


def _request_report(
    client: SpApiClient, spec: ReportSpec, asin: str, today: dt.date
) -> dict[str, Any]:
    if spec.prefer_recent:
        recent = _recent_report(client, spec)
        if recent:
            return recent
    try:
        created = _payload(
            client.post(
                "/reports/2021-06-30/reports",
                json_body=report_request_body(spec, asin, today),
            )
        )
    except Exception:
        recent = _recent_report(client, spec)
        if recent:
            return recent
        raise
    report_id = created.get("reportId")
    if not report_id:
        raise SpApiError(f"Reports API returned no reportId for {spec.report_type}")
    return {"reportId": str(report_id), "processingStatus": "IN_QUEUE"}


def _probe_spapi_reports(
    client: SpApiClient, asin: str, today: dt.date
) -> dict[str, dict[str, Any]]:
    pending: dict[str, tuple[ReportSpec, str]] = {}
    results: dict[str, dict[str, Any]] = {}
    for spec in REPORT_SPECS:
        requested = _attempt(
            lambda spec=spec: _request_report(client, spec, asin, today)
        )
        report_id = requested.get("reportId")
        if report_id:
            pending[spec.key] = (spec, str(report_id))
        else:
            results[spec.key] = requested
        time.sleep(1)

    deadline = time.monotonic() + REPORT_TIMEOUT_SECONDS
    while pending and time.monotonic() < deadline:
        completed: list[str] = []
        for key, (_spec, report_id) in list(pending.items()):
            status_result = _attempt(
                lambda report_id=report_id: _payload(
                    client.get(f"/reports/2021-06-30/reports/{report_id}")
                )
            )
            if "error" in status_result:
                results[key] = status_result
                completed.append(key)
                continue
            status = str(status_result.get("processingStatus") or "").upper()
            if status == "DONE":
                document_id = status_result.get("reportDocumentId")
                if not document_id:
                    results[key] = {
                        "state": "error",
                        "authorized": True,
                        "error": "DONE report had no document ID",
                    }
                else:
                    summary = _attempt(
                        lambda document_id=str(document_id): _download_spapi_report(
                            client, document_id
                        )
                    )
                    if "error" in summary:
                        results[key] = {**summary, "authorized": True}
                    else:
                        results[key] = {
                            "state": "authorized_populated"
                            if summary.get("populated")
                            else "authorized_empty",
                            "authorized": True,
                            **summary,
                        }
                completed.append(key)
            elif status in {"FATAL", "CANCELLED"}:
                results[key] = {
                    "state": "authorized_report_unavailable",
                    "authorized": True,
                    "vendor_status": status,
                    "error": "Amazon accepted the report type but did not produce a data document for this sample window",
                }
                completed.append(key)
        for key in completed:
            pending.pop(key, None)
        if pending:
            time.sleep(REPORT_POLL_SECONDS)

    for key in pending:
        results[key] = {
            "state": "timeout",
            "authorized": True,
            "error": f"Report remained pending after {REPORT_TIMEOUT_SECONDS}s",
        }
    return results


def _ads_json_call(
    client: AmazonAdsClient,
    scope: str,
    method: str,
    path: str,
    *,
    media_type: str = "application/json",
    body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], Any]:
    kwargs: dict[str, Any] = {}
    if body is not None:
        kwargs["json"] = body
    if params is not None:
        kwargs["params"] = params
    response = client.authenticated_request(
        method,
        f"{client.base}{path}",
        scope,
        content_type=media_type,
        accept=media_type,
        **kwargs,
    )
    if response.status_code >= 400:
        raise RuntimeError(
            f"Amazon Ads {method.upper()} {path} failed: HTTP {response.status_code}: {_safe_error(response.text)}"
        )
    payload = response.json() if response.content else {}
    return summarize_payload(payload), payload


def _ads_scope(client: AmazonAdsClient) -> tuple[str, int]:
    if settings.ads_account_ids:
        return settings.ads_account_ids[0], len(settings.ads_account_ids)
    profiles = client.discover_legacy_profiles()
    mx = [
        row
        for row in profiles
        if not row.get("countryCode") or str(row.get("countryCode")).upper() == "MX"
    ]
    if not mx or not mx[0].get("profileId"):
        raise RuntimeError("No Mexico Amazon Ads profile was discovered")
    return str(mx[0]["profileId"]), len(mx)


def _probe_ads_management(
    client: AmazonAdsClient, scope: str
) -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    entity_calls = (
        (
            "campaigns",
            "/sp/campaigns/list",
            "application/vnd.spCampaign.v3+json",
            "campaigns",
        ),
        (
            "ad_groups",
            "/sp/adGroups/list",
            "application/vnd.spAdGroup.v3+json",
            "adGroups",
        ),
        (
            "product_ads",
            "/sp/productAds/list",
            "application/vnd.spProductAd.v3+json",
            "productAds",
        ),
        (
            "targets",
            "/sp/targets/list",
            "application/vnd.spTargetingClause.v3+json",
            "targetingClauses",
        ),
        (
            "keywords",
            "/sp/keywords/list",
            "application/vnd.spKeyword.v3+json",
            "keywords",
        ),
    )
    entity_payloads: dict[str, Any] = {}
    entity_parts: dict[str, Any] = {}
    for name, path, media, _list_key in entity_calls:

        def call(path=path, media=media, name=name) -> dict[str, Any]:
            summary, payload = _ads_json_call(
                client,
                scope,
                "post",
                path,
                media_type=media,
                body={"includeExtendedDataFields": True, "maxResults": 100},
            )
            entity_payloads[name] = payload
            return {
                "state": "authorized_populated"
                if summary["sample_count"]
                else "authorized_empty",
                "authorized": True,
                **summary,
            }

        entity_parts[name] = _attempt(call)
    results["ads_entities"] = {
        "state": "authorized_populated"
        if any(
            part.get("sample_count")
            for part in entity_parts.values()
            if isinstance(part, dict)
        )
        else "partial",
        "authorized": all(
            part.get("authorized") is True
            for part in entity_parts.values()
            if isinstance(part, dict)
        ),
        "components": entity_parts,
        "sample_count": sum(
            int(part.get("sample_count") or 0)
            for part in entity_parts.values()
            if isinstance(part, dict)
        ),
        "field_paths": sorted(
            {
                path
                for part in entity_parts.values()
                if isinstance(part, dict)
                for path in part.get("field_paths") or []
            }
        ),
    }

    negative_calls = (
        (
            "ad_group_keywords",
            "/sp/negativeKeywords/list",
            "application/vnd.spNegativeKeyword.v3+json",
        ),
        (
            "ad_group_targets",
            "/sp/negativeTargets/list",
            "application/vnd.spNegativeTargetingClause.v3+json",
        ),
        (
            "campaign_keywords",
            "/sp/campaignNegativeKeywords/list",
            "application/vnd.spCampaignNegativeKeyword.v3+json",
        ),
        (
            "campaign_targets",
            "/sp/campaignNegativeTargets/list",
            "application/vnd.spCampaignNegativeTargetingClause.v3+json",
        ),
    )
    negative_parts: dict[str, Any] = {}
    for name, path, media in negative_calls:
        negative_parts[name] = _attempt(
            lambda path=path, media=media: (
                {
                    "state": "authorized_populated"
                    if (
                        summary := _ads_json_call(
                            client,
                            scope,
                            "post",
                            path,
                            media_type=media,
                            body={"includeExtendedDataFields": True, "maxResults": 100},
                        )[0]
                    )["sample_count"]
                    else "authorized_empty",
                    "authorized": True,
                    **summary,
                }
            )
        )
    results["ads_negatives"] = {
        "state": "authorized_populated"
        if any(
            part.get("sample_count")
            for part in negative_parts.values()
            if isinstance(part, dict)
        )
        else "authorized_empty",
        "authorized": all(
            part.get("authorized") is True
            for part in negative_parts.values()
            if isinstance(part, dict)
        ),
        "components": negative_parts,
        "sample_count": sum(
            int(part.get("sample_count") or 0)
            for part in negative_parts.values()
            if isinstance(part, dict)
        ),
        "field_paths": sorted(
            {
                path
                for part in negative_parts.values()
                if isinstance(part, dict)
                for path in part.get("field_paths") or []
            }
        ),
    }

    def portfolios() -> dict[str, Any]:
        summary, _payload_value = _ads_json_call(
            client,
            scope,
            "post",
            "/portfolios/list",
            media_type="application/vnd.spPortfolio.v3+json",
            body={"maxResults": 100},
        )
        return {
            "state": "authorized_populated"
            if summary["sample_count"]
            else "authorized_empty",
            "authorized": True,
            **summary,
        }

    results["ads_portfolios"] = _attempt(portfolios)

    campaigns = _first_list(entity_payloads.get("campaigns") or {})
    campaign_id = next(
        (
            str(row.get("campaignId"))
            for row in campaigns
            if isinstance(row, dict) and row.get("campaignId")
        ),
        None,
    )
    if campaign_id:
        budget_calls = {
            "ads_budget_usage": (
                "/sp/campaigns/budget/usage",
                "application/vnd.spcampaignbudgetusage.v1+json",
            ),
            "ads_budget_recommendations": (
                "/sp/campaigns/budgetRecommendations",
                "application/vnd.budgetrecommendation.v3+json",
            ),
        }
        for key, (path, media) in budget_calls.items():
            results[key] = _attempt(
                lambda path=path, media=media: (
                    {
                        "state": "authorized_populated"
                        if (
                            summary := _ads_json_call(
                                client,
                                scope,
                                "post",
                                path,
                                media_type=media,
                                body={"campaignIds": [campaign_id]},
                            )[0]
                        )["sample_count"]
                        else "authorized_empty",
                        "authorized": True,
                        **summary,
                    }
                )
            )
    else:
        for key in ("ads_budget_usage", "ads_budget_recommendations"):
            results[key] = {
                "state": "not_sampled",
                "authorized": None,
                "error": "No campaign was returned for a bounded probe",
            }

    results["ads_budget_rules"] = _attempt(
        lambda: (
            {
                "state": "authorized_populated"
                if (
                    summary := _ads_json_call(
                        client, scope, "get", "/sp/budgetRules", params={"pageSize": 30}
                    )[0]
                )["sample_count"]
                else "authorized_empty",
                "authorized": True,
                **summary,
            }
        )
    )
    results["marketing_stream"] = _attempt(
        lambda: (
            {
                "state": "authorized_populated"
                if (
                    summary := _ads_json_call(
                        client, scope, "get", "/streams/subscriptions"
                    )[0]
                )["sample_count"]
                else "authorized_empty",
                "authorized": True,
                **summary,
            }
        )
    )
    return results


def _probe_ads_reports(
    client: AmazonAdsClient, scope: str, today: dt.date
) -> dict[str, dict[str, Any]]:
    start = today - dt.timedelta(days=10)
    end = today - dt.timedelta(days=4)
    results: dict[str, dict[str, Any]] = {}
    for key, configuration in ADS_REPORT_CONFIGS.items():

        def run(key=key, configuration=configuration) -> dict[str, Any]:
            payload = {
                "name": f"dpp-capability-{key}-{today.isoformat()}",
                "startDate": start.isoformat(),
                "endDate": end.isoformat(),
                "configuration": {
                    "adProduct": "SPONSORED_PRODUCTS",
                    **configuration,
                    "timeUnit": "SUMMARY",
                    "format": "GZIP_JSON",
                },
            }
            response = client.authenticated_request(
                "post",
                f"{client.base}/reporting/reports",
                scope,
                content_type="application/vnd.createasyncreportrequest.v3+json",
                accept="application/vnd.createasyncreportresponse.v3+json",
                json=payload,
            )
            body = response.json() if response.content else {}
            if response.status_code >= 400 and response.status_code != 425:
                raise RuntimeError(
                    f"Amazon Ads createReport {key} failed: HTTP {response.status_code}: {_safe_error(response.text)}"
                )
            report_id = body.get("reportId") or body.get("report_id")
            if not report_id:
                raise RuntimeError(
                    f"Amazon Ads createReport {key} returned no reusable report ID"
                )
            status = client.wait_for_report(scope, str(report_id))
            location = status.get("url") or status.get("location")
            if not location:
                raise RuntimeError(
                    f"Amazon Ads report {key} completed without a download location"
                )
            rows = client.download_report(str(location))
            return {
                "state": "authorized_populated" if rows else "authorized_empty",
                "authorized": True,
                "sample_count": len(rows),
                "field_paths": field_paths(rows),
                "populated": bool(rows),
            }

        results[key] = _attempt(run)
    return results


def _warehouse_evidence() -> dict[str, dict[str, Any]]:
    results: dict[str, dict[str, Any]] = {}
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """
            SELECT count(*) AS n,
                   count(*) FILTER (WHERE jsonb_array_length(CASE WHEN jsonb_typeof(payload->'items')='array' THEN payload->'items' ELSE '[]'::jsonb END)>0) AS with_items,
                   COALESCE(sum(jsonb_array_length(CASE WHEN jsonb_typeof(payload->'items')='array' THEN payload->'items' ELSE '[]'::jsonb END)),0) AS items
            FROM raw.api_payload
            WHERE source='amazon_spapi' AND resource_type='financial_transaction'
            """
        )
        finance = cur.fetchone() or {}
        cur.execute(
            """
            SELECT payload
            FROM raw.api_payload
            WHERE source='amazon_spapi' AND resource_type='financial_transaction'
            ORDER BY fetched_at DESC LIMIT 1
            """
        )
        finance_payload = (cur.fetchone() or {}).get("payload") or {}
        results["finances_items"] = {
            "state": "warehouse_populated" if finance.get("n") else "warehouse_empty",
            "sample_count": int(finance.get("n") or 0),
            "transactions_with_items": int(finance.get("with_items") or 0),
            "item_count": int(finance.get("items") or 0),
            "field_paths": field_paths(finance_payload),
        }

        for key, sql in {
            "listings_snapshot": "SELECT count(*) AS n FROM core.seller_listing WHERE marketplace_id=%s AND is_current_listing",
            "settlement_v2": "SELECT count(*) AS n FROM core.settlement_line WHERE marketplace_id=%s",
            "data_kiosk_sales_traffic": "SELECT count(*) AS n FROM core.asin_sales_traffic_daily WHERE marketplace_id=%s",
        }.items():
            cur.execute(sql, (settings.marketplace_id,))
            count = int((cur.fetchone() or {}).get("n") or 0)
            results[key] = {
                "state": "warehouse_populated" if count else "warehouse_empty",
                "sample_count": count,
            }
    return results


def _combine(primary: dict[str, Any], secondary: dict[str, Any]) -> dict[str, Any]:
    if not primary:
        return secondary
    if not secondary:
        return primary
    state_rank = {
        "authorized_populated": 8,
        "warehouse_populated": 7,
        "authorized_empty": 6,
        "authorized_report_unavailable": 5,
        "not_sampled": 4,
        "timeout": 3,
        "unsupported": 2,
        "unauthorized": 1,
        "error": 0,
    }
    chosen = (
        primary
        if state_rank.get(str(primary.get("state")), -1)
        >= state_rank.get(str(secondary.get("state")), -1)
        else secondary
    )
    return {**chosen, "evidence": [primary, secondary]}


def probe_all() -> dict[str, Any]:
    if not settings.is_production:
        raise RuntimeError(
            f"capability probe refused in environment={settings.spapi_environment}"
        )
    today = dt.datetime.now(BUSINESS_TIMEZONE).date()
    sample = _sample_product()
    observed: dict[str, dict[str, Any]] = {}
    warehouse = _attempt(_warehouse_evidence)
    if "error" not in warehouse:
        for key, evidence in warehouse.items():
            observed[key] = _combine(observed.get(key, {}), evidence)

    if settings.spapi_credentials_present:
        client = SpApiClient()
        try:
            for key, evidence in _inline_spapi(client, sample).items():
                observed[key] = _combine(observed.get(key, {}), evidence)
            for key, evidence in _probe_spapi_reports(
                client, str(sample["asin"]), today
            ).items():
                observed[key] = _combine(observed.get(key, {}), evidence)
        finally:
            client.close()
    else:
        for cap in CAPABILITIES:
            if cap.probe in {"spapi_inline", "spapi_report"}:
                observed.setdefault(
                    cap.key, {"state": "credentials_missing", "authorized": None}
                )

    if settings.ads_credentials_present:
        ads = AmazonAdsClient()
        try:
            scope_result = _attempt(lambda: {"scope": _ads_scope(ads)})
            if scope_result.get("scope"):
                (scope, profile_count) = scope_result["scope"]
                for key, evidence in _probe_ads_management(ads, scope).items():
                    observed[key] = _combine(observed.get(key, {}), evidence)
                for key, evidence in _probe_ads_reports(ads, scope, today).items():
                    observed[key] = _combine(observed.get(key, {}), evidence)
            else:
                profile_count = 0
                for cap in CAPABILITIES:
                    if cap.probe in {"ads_management", "ads_report"}:
                        observed.setdefault(cap.key, scope_result)
        finally:
            ads.close()
    else:
        profile_count = 0
        for cap in CAPABILITIES:
            if cap.probe in {"ads_management", "ads_report"}:
                observed.setdefault(
                    cap.key, {"state": "credentials_missing", "authorized": None}
                )

    capabilities = []
    for cap in CAPABILITIES:
        evidence = observed.get(cap.key) or {
            "state": "documented_not_probed",
            "authorized": None,
            "error": "Documented candidate is not part of the bounded production probe",
        }
        capabilities.append({**asdict(cap), "production_evidence": evidence})
    return {
        "schema": PROBE_MARKER,
        "generated_at": dt.datetime.now(dt.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "git_sha": os.getenv("GITHUB_SHA") or os.getenv("DEPLOY_SHA") or "local",
        "marketplace": settings.marketplace_id,
        "ads_profile_count": profile_count,
        "identifiers_redacted": True,
        "capabilities": capabilities,
    }


def render_markdown(result: dict[str, Any]) -> str:
    lines = [
        "<!-- dpp-amazon-source-readiness -->",
        "## Advertising V2 Amazon source-readiness probe",
        "",
        f"Generated: `{result.get('generated_at')}`  ",
        f"Commit: `{result.get('git_sha')}`  ",
        f"Marketplace: `{result.get('marketplace')}`",
        "",
        "Identifiers and payload values are intentionally omitted. `authorized_empty` means the production credentials accepted the source but the bounded sample had no rows. A report accepted and then marked FATAL/CANCELLED is kept distinct from an authorization failure.",
        "",
        "| Domain | Source | Production evidence | Rows | Decision use | Initial disposition |",
        "|---|---|---:|---:|---|---|",
    ]
    for item in result.get("capabilities") or []:
        evidence = item.get("production_evidence") or {}
        rows = evidence.get("sample_count")
        if rows is None and isinstance(evidence.get("evidence"), list):
            rows = max(
                (
                    int(part.get("sample_count") or 0)
                    for part in evidence["evidence"]
                    if isinstance(part, dict)
                ),
                default=0,
            )
        source = str(item.get("source") or "").replace("|", "\\|")
        use = str(item.get("decision_use") or "").replace("|", "\\|")
        disposition = str(item.get("initial_disposition") or "").replace("|", "\\|")
        lines.append(
            f"| {item.get('domain')} | {source} | `{evidence.get('state')}` | {rows if rows is not None else 'n/a'} | {use} | {disposition} |"
        )
    lines.extend(
        [
            "",
            "### Interpretation gate",
            "",
            "- Only `authorized_populated` or reconciled warehouse evidence can support implementation commitments.",
            "- Empty, unavailable, timeout, unsupported and unauthorized states remain explicit. They must not be converted into invented metrics or recommendations.",
            "- Estimated fees, Amazon recommendations and attributed sales remain supporting evidence, not actual accounting, causal lift or forecast facts.",
            "- Final ingest/retain/unavailable dispositions will be recorded after field coverage, identity mapping and reconciliation are reviewed.",
        ]
    )
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-output")
    parser.add_argument("--markdown-output")
    args = parser.parse_args()
    result = probe_all()
    rendered = json.dumps(result, sort_keys=True, default=str, indent=2)
    if args.json_output:
        Path(args.json_output).write_text(rendered + "\n", encoding="utf-8")
    if args.markdown_output:
        Path(args.markdown_output).write_text(render_markdown(result), encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
