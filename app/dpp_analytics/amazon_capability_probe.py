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
ADS_REPORT_TIMEOUT_SECONDS = int(
    os.getenv("AMAZON_SOURCE_PROBE_ADS_REPORT_TIMEOUT_SECONDS", "1800")
)
REPORT_CREATE_BURST = int(os.getenv("AMAZON_SOURCE_PROBE_REPORT_CREATE_BURST", "15"))
REPORT_CREATE_COOLDOWN_SECONDS = int(
    os.getenv("AMAZON_SOURCE_PROBE_REPORT_CREATE_COOLDOWN_SECONDS", "65")
)
ADS_READ_MAX_ATTEMPTS = max(
    1, int(os.getenv("AMAZON_SOURCE_PROBE_ADS_READ_MAX_ATTEMPTS", "4"))
)
ADS_READ_RETRY_BASE_SECONDS = float(
    os.getenv("AMAZON_SOURCE_PROBE_ADS_READ_RETRY_BASE_SECONDS", "2")
)
ADS_READ_RETRY_MAX_SECONDS = float(
    os.getenv("AMAZON_SOURCE_PROBE_ADS_READ_RETRY_MAX_SECONDS", "30")
)
# Amazon's default createReport plan permits a burst of 15, then restores only
# 0.0167 requests/second. After the initial burst, every additional create must
# wait for one token; this is intentionally not a modulo-per-burst cooldown.


def _progress(event: str, **details: Any) -> None:
    """Emit identifier-free progress so a slow production probe is diagnosable."""
    print(
        json.dumps({"probe_progress": event, **details}, sort_keys=True, default=str),
        flush=True,
    )


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
    option_start: str | None = None
    option_end: str | None = None


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
        "inventory_summaries",
        "Inventory",
        "FBA Inventory API summaries",
        "SKU snapshot",
        "SKU, FNSKU, ASIN",
        "near real time",
        "DPP retained",
        "Fulfillable, inbound, reserved, researching and unfulfillable quantities",
        "authoritative operational safety gate",
        "already ingested",
        "warehouse_and_inline",
    ),
    Capability(
        "inbound_plans",
        "Inventory",
        "Fulfillment Inbound v2024 plans",
        "inbound plan",
        "inbound plan and marketplace",
        "point in time",
        "source API plus DPP snapshots",
        "Shipment lifecycle and supply-arrival context",
        "supporting fulfillment evidence",
        "supporting evidence; retain for later",
        "spapi_inline",
    ),
    Capability(
        "inbound_item_eligibility",
        "Inventory",
        "FBA Inbound Eligibility preview",
        "ASIN eligibility snapshot",
        "ASIN and marketplace",
        "point in time",
        "DPP snapshots",
        "Prevent spend increases when constrained stock cannot be replenished",
        "hard recommendation guard when inventory is constrained",
        "ingest now",
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
        "catalog_vendor_details",
        "Product",
        "Catalog Items vendor details",
        "ASIN vendor snapshot",
        "ASIN and vendor code",
        "point in time",
        "not available to seller account",
        "Vendor brand, manufacturer and replenishment codes",
        "documented for vendor accounts only",
        "unavailable to DPP seller; retain as account-type boundary",
        "documented_account_unavailable",
    ),
    Capability(
        "listing_items_detailed",
        "Product",
        "Listings Items v2021",
        "seller SKU snapshot",
        "seller, SKU and marketplace",
        "point in time",
        "DPP snapshots",
        "Buyability, discoverability, offer, availability and issue diagnosis",
        "hard safety and diagnostic evidence",
        "expand existing ingestion now",
        "spapi_inline",
    ),
    Capability(
        "listing_restrictions",
        "Product",
        "Listings Restrictions v2021",
        "ASIN restriction snapshot",
        "seller, ASIN and marketplace",
        "point in time",
        "DPP snapshots",
        "Explain brand, condition or category restrictions",
        "supporting listing evidence",
        "supporting evidence",
        "spapi_inline",
    ),
    Capability(
        "aplus_content_status",
        "Product",
        "A+ Content publish records",
        "ASIN publish record",
        "ASIN and content reference",
        "point in time",
        "DPP snapshots",
        "Identify missing, rejected or stale enhanced listing content",
        "supporting listing-conversion evidence",
        "retain for later",
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
        "suppressed_listings",
        "Product",
        "Suppressed Listings report",
        "suppressed seller SKU",
        "SKU and ASIN",
        "current snapshot",
        "retain in DPP",
        "Suppression reason, issue description and status-change date",
        "hard safety gate",
        "ingest now",
        "spapi_report",
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
        "fba_inbound_noncompliance",
        "Inventory",
        "FBA Inbound Performance report",
        "inbound shipment problem and product",
        "shipment, SKU, FNSKU and ASIN",
        "daily",
        "retain in DPP",
        "Explain delayed or incomplete inbound supply and associated fees",
        "supporting fulfillment evidence",
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
        "long_term_storage_charges",
        "Economics",
        "FBA Long Term Storage Fee Charges",
        "charged SKU and age tier",
        "SKU, FNSKU and ASIN",
        "monthly actual charge",
        "retain in DPP",
        "Actual aged-inventory surcharge allocation by product",
        "authoritative after Finance and settlement reconciliation",
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
        "fba_promotions",
        "Commerce",
        "FBA Promotions report",
        "order promotion and shipment item",
        "order and promotion; product identity where supplied",
        "daily",
        "retain in DPP",
        "Allocate shipment-item promotion discounts and prevent ad misdiagnosis",
        "confounder and reconciliation evidence",
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
        "ads_campaign_core",
        "Advertising",
        "SP Campaign report",
        "campaign",
        "campaign",
        "daily; attribution revises",
        "95 days at source",
        "Campaign performance, budget, bidding strategy and active rule context",
        "attributed, not incremental",
        "expand existing ingestion now",
        "ads_report",
    ),
    Capability(
        "ads_ad_group_performance",
        "Advertising",
        "SP Campaign report grouped by ad group",
        "campaign and ad group",
        "campaign and ad group",
        "daily; attribution revises",
        "95 days at source",
        "Resolve whether campaign response or leakage is concentrated in an ad group",
        "attributed, not incremental",
        "ingest now",
        "ads_report",
    ),
    Capability(
        "ads_gross_invalid_traffic",
        "Advertising",
        "SP Gross and Invalid Traffic report",
        "campaign",
        "campaign",
        "daily; may revise after invalidation",
        "365 days at source",
        "Explain gross-to-valid traffic differences and protect evidence trust",
        "data-quality evidence, not charged-spend economics",
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
        "ads_optimization_rules",
        "Advertising",
        "SP campaign optimization rules",
        "optimization rule",
        "rule and associated campaign",
        "point in time",
        "retain changes in DPP",
        "Expose automation that can change campaign bids or settings",
        "hard recommendation guard",
        "ingest now",
        "ads_management",
    ),
    Capability(
        "ads_target_promotion_groups",
        "Advertising",
        "SP target promotion groups",
        "promotion group and promoted target",
        "source/destination ad group, promotion group and target",
        "point in time",
        "retain changes in DPP",
        "Expose Amazon-managed target promotion that can overlap DPP actions",
        "hard recommendation guard when configured",
        "ingest now if populated; otherwise retain availability evidence",
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
        "ads_management",
    ),
    Capability(
        "ads_keyword_recommendations",
        "Advertising",
        "SP keyword recommendations",
        "advertised ASIN and suggested keyword",
        "ASIN and keyword",
        "current recommendation with trailing evidence",
        "retain evidence in DPP",
        "Keyword discovery, ranking, bid suggestions, and search-term impression share/rank",
        "Amazon suggestion and competitive estimate only",
        "supporting evidence; ingest snapshot after contract validation",
        "ads_management",
    ),
    Capability(
        "ads_bid_recommendations",
        "Advertising",
        "SP theme-based bid recommendations",
        "advertised ASIN and target expression",
        "ASIN and target expression",
        "current recommendation",
        "retain evidence in DPP",
        "Bid range and objective context for bounded experiments",
        "Amazon estimate, never an economic action by itself",
        "supporting evidence; retain for experiment design",
        "ads_management",
    ),
    Capability(
        "ads_category_recommendations",
        "Advertising",
        "SP category recommendations",
        "advertised ASIN and suggested category",
        "ASIN and category",
        "current recommendation",
        "retain evidence in DPP",
        "Category-target discovery and refinement context",
        "Amazon suggestion only",
        "supporting evidence; retain for later",
        "ads_management",
    ),
    Capability(
        "ads_negative_brand_recommendations",
        "Advertising",
        "SP negative-brand recommendations",
        "recommended brand",
        "brand",
        "current recommendation",
        "retain evidence in DPP",
        "Candidate brand exclusions, including own-brand warnings",
        "Amazon suggestion only; never auto-apply",
        "supporting evidence; retain for later",
        "ads_management",
    ),
    Capability(
        "ads_budget_rule_recommendations",
        "Advertising",
        "SP budget-rule event recommendations",
        "campaign and event",
        "campaign and event",
        "current event recommendation",
        "retain evidence in DPP",
        "Special-event dates and suggested budget uplift context",
        "Amazon suggestion only; never a forecast fact",
        "supporting evidence; retain for later",
        "ads_management",
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
    Capability(
        "ads_prompt_extension",
        "Advertising",
        "SP Prompt Ad Extension report",
        "prompt extension",
        "campaign, ad group, ad, ASIN and prompt",
        "daily; attribution revises",
        "95 days at source",
        "Prompt-level discovery and response evidence",
        "documented for US only",
        "unavailable in MX; retain as expansion boundary",
        "documented_unavailable",
    ),
    Capability(
        "ads_video_extension",
        "Advertising",
        "SP Video Ad Extension report",
        "video extension",
        "campaign, ad group, ad, ASIN and video extension",
        "daily; attribution revises",
        "95 days at source",
        "Video engagement and product-discovery evidence",
        "documented for US only",
        "unavailable in MX; retain as expansion boundary",
        "documented_unavailable",
    ),
    Capability(
        "customer_feedback_insights",
        "Product",
        "Customer Feedback API",
        "ASIN or browse-node review and return topic",
        "ASIN and browse node",
        "weekly",
        "source API lookback",
        "Review-topic and return-reason diagnosis",
        "documented outside MX",
        "unavailable in MX; retain as expansion boundary",
        "documented_unavailable",
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
        "fba_promotions",
        "GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_PROMOTION_DATA",
        "last_30_days_mature",
    ),
    ReportSpec(
        "inventory_ledger",
        "GET_LEDGER_DETAIL_VIEW_DATA",
        "last_30_days_mature",
    ),
    ReportSpec("reserved_inventory", "GET_RESERVED_INVENTORY_DATA"),
    ReportSpec("inventory_health", "GET_FBA_INVENTORY_PLANNING_DATA"),
    ReportSpec("stranded_inventory", "GET_STRANDED_INVENTORY_UI_DATA"),
    ReportSpec(
        "restock_recommendations", "GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT"
    ),
    ReportSpec(
        "fba_inbound_noncompliance",
        "GET_FBA_FULFILLMENT_INBOUND_NONCOMPLIANCE_DATA",
        "last_90_days",
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
        "storage_fees", "GET_FBA_STORAGE_FEE_CHARGES_DATA", prefer_recent=True
    ),
    ReportSpec(
        "long_term_storage_charges",
        "GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA",
        "last_closed_month",
    ),
    ReportSpec(
        "fba_returns",
        "GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA",
        "last_30_days_mature",
    ),
    ReportSpec(
        "fba_reimbursements", "GET_FBA_REIMBURSEMENTS_DATA", "last_closed_month"
    ),
    ReportSpec(
        "fba_replacements",
        "GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA",
    ),
    ReportSpec(
        "promotion_performance",
        "GET_PROMOTION_PERFORMANCE_REPORT",
        "last_90_days",
        option_start="promotionStartDateFrom",
        option_end="promotionStartDateTo",
    ),
    ReportSpec(
        "coupon_performance",
        "GET_COUPON_PERFORMANCE_REPORT",
        "last_90_days",
        option_start="couponStartDateFrom",
        option_end="couponStartDateTo",
    ),
    ReportSpec("suppressed_listings", "GET_MERCHANTS_LISTINGS_FYP_REPORT"),
)


ADS_REPORT_CONFIGS: dict[str, dict[str, Any]] = {
    "ads_campaign_core": {
        "reportTypeId": "spCampaigns",
        "groupBy": ["campaign"],
        "columns": [
            "campaignId",
            "campaignName",
            "campaignStatus",
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
    "ads_ad_group_performance": {
        "reportTypeId": "spCampaigns",
        "groupBy": ["campaign", "adGroup"],
        "columns": [
            "campaignId",
            "campaignName",
            "adGroupId",
            "adGroupName",
            "adStatus",
            "impressions",
            "clicks",
            "cost",
            "purchases7d",
            "purchasesSameSku7d",
            "sales7d",
            "attributedSalesSameSku7d",
        ],
    },
    "ads_gross_invalid_traffic": {
        "reportTypeId": "spGrossAndInvalids",
        "groupBy": ["campaign"],
        "columns": [
            "campaignName",
            "campaignStatus",
            "impressions",
            "clicks",
            "grossImpressions",
            "invalidImpressions",
            "invalidImpressionRate",
            "grossClickThroughs",
            "invalidClickThroughs",
            "invalidClickThroughRate",
            "startDate",
            "endDate",
        ],
    },
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


def finance_identity_coverage(transactions: list[Any]) -> dict[str, int]:
    rows = [row for row in transactions if isinstance(row, dict)]
    items = [
        item
        for row in rows
        for item in row.get("items") or []
        if isinstance(item, dict)
    ]

    def item_contexts(item: dict[str, Any]) -> list[dict[str, Any]]:
        return [
            context
            for context in item.get("contexts") or []
            if isinstance(context, dict)
        ]

    def has_item_identity(item: dict[str, Any]) -> bool:
        return any(
            context.get("sku") or context.get("asin")
            for context in item_contexts(item)
        )

    return {
        "item_count": len(items),
        "items_with_sku": sum(
            any(context.get("sku") for context in item_contexts(item))
            for item in items
        ),
        "items_with_asin": sum(
            any(context.get("asin") for context in item_contexts(item))
            for item in items
        ),
        "items_with_product_identity": sum(has_item_identity(item) for item in items),
        "transactions_with_item_identity": sum(
            any(
                has_item_identity(item)
                for item in row.get("items") or []
                if isinstance(item, dict)
            )
            for row in rows
        ),
        "transactions_with_related_identifiers": sum(
            bool(row.get("relatedIdentifiers"))
            or any(
                bool(item.get("relatedIdentifiers"))
                for item in row.get("items") or []
                if isinstance(item, dict)
            )
            for row in rows
        ),
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
    if spec.window == "last_30_days_mature":
        end = today - dt.timedelta(days=3)
        return end - dt.timedelta(days=29), end
    days = int(spec.window.removeprefix("last_").removesuffix("_days"))
    end = today - dt.timedelta(days=1)
    return end - dt.timedelta(days=days - 1), end


def report_request_body(spec: ReportSpec, asin: str, today: dt.date) -> dict[str, Any]:
    body: dict[str, Any] = {
        "reportType": spec.report_type,
        "marketplaceIds": [settings.marketplace_id],
    }
    period = _window(spec, today)
    if period and not (spec.option_start and spec.option_end):
        body["dataStartTime"] = f"{period[0].isoformat()}T00:00:00Z"
        body["dataEndTime"] = f"{period[1].isoformat()}T23:59:59Z"
    options = dict(spec.extra_options)
    if period and spec.option_start and spec.option_end:
        options[spec.option_start] = f"{period[0].isoformat()}T00:00:00Z"
        options[spec.option_end] = f"{period[1].isoformat()}T23:59:59Z"
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
        cur.execute(
            """
            SELECT payload#>>'{sellingPartnerMetadata,sellingPartnerId}' AS seller_id
            FROM raw.api_payload
            WHERE source='amazon_spapi'
              AND resource_type='financial_transaction'
              AND NULLIF(payload#>>'{sellingPartnerMetadata,sellingPartnerId}','') IS NOT NULL
            ORDER BY fetched_at DESC
            LIMIT 1
            """
        )
        row["seller_id"] = (cur.fetchone() or {}).get("seller_id")
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
            **finance_identity_coverage(transactions),
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

    def inventory() -> dict[str, Any]:
        payload = client.get(
            "/fba/inventory/v1/summaries",
            params={
                "details": "true",
                "granularityType": "Marketplace",
                "granularityId": settings.marketplace_id,
                "marketplaceIds": settings.marketplace_id,
            },
        )
        body = (
            payload.get("payload")
            if isinstance(payload.get("payload"), dict)
            else payload
        )
        summaries = body.get("inventorySummaries") or []
        summary = summarize_payload(summaries)
        return {
            "state": "authorized_populated"
            if summary["sample_count"]
            else "authorized_empty",
            "authorized": True,
            **summary,
        }

    results["inventory_summaries"] = _attempt(inventory)

    def inbound_plans() -> dict[str, Any]:
        payload = client.get(
            "/inbound/fba/2024-03-20/inboundPlans",
            params={
                "pageSize": 30,
                "sortBy": "LAST_UPDATED_TIME",
                "sortOrder": "DESC",
            },
        )
        plans = _payload(payload).get("inboundPlans") or []
        summary = summarize_payload(plans)
        return {
            "state": "authorized_populated" if plans else "authorized_empty",
            "authorized": True,
            **summary,
        }

    results["inbound_plans"] = _attempt(inbound_plans)

    def inbound_eligibility() -> dict[str, Any]:
        payload = client.get(
            "/fba/inbound/v1/eligibility/itemPreview",
            params={
                "asin": sample["asin"],
                "program": "INBOUND",
                "marketplaceIds": settings.marketplace_id,
            },
        )
        summary = summarize_payload(payload)
        return {
            "state": "authorized_populated" if payload else "authorized_empty",
            "authorized": True,
            **summary,
        }

    results["inbound_item_eligibility"] = _attempt(inbound_eligibility)

    def catalog() -> dict[str, Any]:
        included_data = (
            "attributes",
            "classifications",
            "dimensions",
            "identifiers",
            "images",
            "productTypes",
            "relationships",
            "salesRanks",
            "summaries",
        )
        components: dict[str, dict[str, Any]] = {}
        paths: set[str] = set()
        for field in included_data:
            result = _attempt(
                lambda field=field: client.get(
                    f"/catalog/2022-04-01/items/{sample['asin']}",
                    params={
                        "marketplaceIds": settings.marketplace_id,
                        "includedData": field,
                    },
                )
            )
            if "error" in result:
                components[field] = result
            else:
                component_paths = field_paths(result)
                paths.update(component_paths)
                components[field] = {
                    "state": "authorized_populated"
                    if result
                    else "authorized_empty",
                    "authorized": True,
                    "field_paths": component_paths,
                }
        successful = [
            component
            for component in components.values()
            if component.get("authorized") is True
        ]
        return {
            "state": "authorized_populated"
            if len(successful) == len(components)
            else "partial",
            "authorized": bool(successful),
            "sample_count": 1 if successful else 0,
            "components": components,
            "field_paths": sorted(paths),
            "populated": bool(successful),
        }

    results["catalog_full"] = _attempt(catalog)

    seller_id = sample.get("seller_id")
    if seller_id:
        def listing_items() -> dict[str, Any]:
            payload = client.get(
                f"/listings/2021-08-01/items/{seller_id}",
                params={
                    "marketplaceIds": settings.marketplace_id,
                    "includedData": (
                        "summaries,attributes,issues,offers,"
                        "fulfillmentAvailability,relationships,productTypes"
                    ),
                    "pageSize": 20,
                },
            )
            items = _payload(payload).get("items") or []
            summary = summarize_payload(items)
            return {
                "state": "authorized_populated" if items else "authorized_empty",
                "authorized": True,
                **summary,
            }

        results["listing_items_detailed"] = _attempt(listing_items)

        def listing_restrictions() -> dict[str, Any]:
            payload = client.get(
                "/listings/2021-08-01/restrictions",
                params={
                    "asin": sample["asin"],
                    "sellerId": seller_id,
                    "marketplaceIds": settings.marketplace_id,
                },
            )
            restrictions = _payload(payload).get("restrictions") or []
            summary = summarize_payload(restrictions)
            return {
                "state": (
                    "authorized_populated" if restrictions else "authorized_empty"
                ),
                "authorized": True,
                **summary,
            }

        results["listing_restrictions"] = _attempt(listing_restrictions)
    else:
        for key in ("listing_items_detailed", "listing_restrictions"):
            results[key] = {
                "state": "not_sampled",
                "authorized": None,
                "error": (
                    "No production selling-partner identifier was available "
                    "for a bounded probe"
                ),
            }

    def aplus_status() -> dict[str, Any]:
        payload = client.get(
            "/aplus/2020-11-01/contentPublishRecords",
            params={
                "marketplaceId": settings.marketplace_id,
                "asin": sample["asin"],
            },
        )
        records = _payload(payload).get("publishRecordList") or []
        summary = summarize_payload(records)
        return {
            "state": "authorized_populated" if records else "authorized_empty",
            "authorized": True,
            **summary,
        }

    results["aplus_content_status"] = _attempt(aplus_status)

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
    for index, spec in enumerate(REPORT_SPECS):
        requested = _attempt(
            lambda spec=spec: _request_report(client, spec, asin, today)
        )
        report_id = requested.get("reportId")
        if report_id:
            pending[spec.key] = (spec, str(report_id))
            _progress("spapi_report_requested", source=spec.key)
        else:
            results[spec.key] = requested
            _progress(
                "spapi_report_finished",
                source=spec.key,
                state=requested.get("state"),
            )
        if index + 1 >= REPORT_CREATE_BURST and index + 1 < len(REPORT_SPECS):
            _progress("spapi_report_rate_limit_wait", after_source=spec.key)
            time.sleep(REPORT_CREATE_COOLDOWN_SECONDS)
        else:
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
            result = results[key]
            _progress(
                "spapi_report_finished",
                source=key,
                state=result.get("state"),
                sample_count=result.get("sample_count"),
            )
        if pending:
            time.sleep(REPORT_POLL_SECONDS)

    for key in pending:
        results[key] = {
            "state": "timeout",
            "authorized": True,
            "error": f"Report remained pending after {REPORT_TIMEOUT_SECONDS}s",
        }
        _progress("spapi_report_finished", source=key, state="timeout")
    return results


def _ads_json_call(
    client: AmazonAdsClient,
    scope: str,
    method: str,
    path: str,
    *,
    media_type: str = "application/json",
    accept_media_type: str | None = None,
    body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], Any]:
    kwargs: dict[str, Any] = {}
    if body is not None:
        kwargs["json"] = body
    if params is not None:
        kwargs["params"] = params
    response = None
    for attempt in range(ADS_READ_MAX_ATTEMPTS):
        response = client.authenticated_request(
            method,
            f"{client.base}{path}",
            scope,
            # Bodyless Ads requests define only a response representation.
            # Sending an unrelated Content-Type causes some endpoints to return 415.
            content_type=media_type if body is not None else None,
            accept=accept_media_type or media_type,
            **kwargs,
        )
        if response.status_code not in {429, 500, 502, 503, 504}:
            break
        if attempt + 1 >= ADS_READ_MAX_ATTEMPTS:
            break
        retry_after = response.headers.get("Retry-After")
        try:
            delay = float(retry_after) if retry_after is not None else 0.0
        except ValueError:
            delay = 0.0
        if delay > 0:
            delay = min(ADS_READ_RETRY_MAX_SECONDS, delay)
        else:
            delay = min(
                ADS_READ_RETRY_MAX_SECONDS,
                ADS_READ_RETRY_BASE_SECONDS * (2**attempt),
            )
        time.sleep(delay)
    assert response is not None
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

    product_ads = _first_list(entity_payloads.get("product_ads") or {})
    advertised_asin = next(
        (
            str(row.get("asin"))
            for row in product_ads
            if isinstance(row, dict) and row.get("asin")
        ),
        None,
    )
    if advertised_asin:
        results["ads_product_recommendations"] = _attempt(
            lambda: (
                {
                    "state": "authorized_populated"
                    if (
                        summary := _ads_json_call(
                            client,
                            scope,
                            "post",
                            "/sp/targets/products/recommendations",
                            media_type="application/vnd.spproductrecommendation.v3+json",
                            accept_media_type="application/vnd.spproductrecommendationresponse.asins.v3+json",
                            body={"adAsins": [advertised_asin], "count": 20},
                        )[0]
                    )["sample_count"]
                    else "authorized_empty",
                    "authorized": True,
                    **summary,
                }
            )
        )
    else:
        results["ads_product_recommendations"] = {
            "state": "not_sampled",
            "authorized": None,
            "error": "No advertised ASIN was returned for a bounded probe",
        }

    asin_recommendation_calls = (
        (
            "ads_keyword_recommendations",
            "/sp/targets/keywords/recommendations",
            "application/vnd.spkeywordsrecommendation.v4+json",
            "application/vnd.spkeywordsrecommendation.v4+json",
            {
                "asins": [advertised_asin] if advertised_asin else [],
                "recommendationType": "KEYWORDS_FOR_ASINS",
                "locale": "es_MX",
                "maxRecommendations": 20,
                "sortDimension": "DEFAULT",
            },
        ),
        (
            "ads_bid_recommendations",
            "/sp/targets/bid/recommendations",
            "application/vnd.spthemebasedbidrecommendation.v4+json",
            "application/vnd.spthemebasedbidrecommendation.v4+json",
            {
                "asins": [advertised_asin] if advertised_asin else [],
                "bidding": {"strategy": "AUTO_FOR_SALES"},
                "recommendationType": "BIDS_FOR_NEW_AD_GROUP",
                "targetingExpressions": [
                    {"type": "CLOSE_MATCH"},
                    {"type": "LOOSE_MATCH"},
                    {"type": "SUBSTITUTES"},
                    {"type": "COMPLEMENTS"},
                ],
            },
        ),
        (
            "ads_category_recommendations",
            "/sp/targets/categories/recommendations",
            "application/vnd.spproducttargeting.v3+json",
            "application/vnd.spproducttargetingresponse.v3+json",
            {
                "asins": [advertised_asin] if advertised_asin else [],
                "includeAncestor": False,
            },
        ),
    )
    if advertised_asin:
        for key, path, media, accept_media, body in asin_recommendation_calls:
            results[key] = _attempt(
                lambda path=path, media=media, accept_media=accept_media, body=body: (
                    {
                        "state": "authorized_populated"
                        if (
                            summary := _ads_json_call(
                                client,
                                scope,
                                "post",
                                path,
                                media_type=media,
                                accept_media_type=accept_media,
                                body=body,
                            )[0]
                        )["sample_count"]
                        else "authorized_empty",
                        "authorized": True,
                        **summary,
                    }
                )
            )
    else:
        for key, _path, _media, _accept_media, _body in asin_recommendation_calls:
            results[key] = {
                "state": "not_sampled",
                "authorized": None,
                "error": "No advertised ASIN was returned for a bounded probe",
            }

    results["ads_negative_brand_recommendations"] = _attempt(
        lambda: (
            {
                "state": "authorized_populated"
                if (
                    summary := _ads_json_call(
                        client,
                        scope,
                        "get",
                        "/sp/negativeTargets/brands/recommendations",
                        accept_media_type="application/vnd.spproducttargetingresponse.v3+json",
                    )[0]
                )["sample_count"]
                else "authorized_empty",
                "authorized": True,
                **summary,
            }
        )
    )

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
        results["ads_budget_rule_recommendations"] = _attempt(
            lambda: (
                {
                    "state": "authorized_populated"
                    if (
                        summary := _ads_json_call(
                            client,
                            scope,
                            "post",
                            "/sp/campaigns/budgetRules/recommendations",
                            media_type="application/vnd.spbudgetrulesrecommendation.v3+json",
                            body={"campaignId": campaign_id},
                        )[0]
                    )["sample_count"]
                    else "authorized_empty",
                    "authorized": True,
                    **summary,
                }
            )
        )
    else:
        for key in (
            "ads_budget_usage",
            "ads_budget_recommendations",
            "ads_budget_rule_recommendations",
        ):
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
    results["ads_optimization_rules"] = _attempt(
        lambda: (
            {
                "state": "authorized_populated"
                if (
                    summary := _ads_json_call(
                        client,
                        scope,
                        "post",
                        "/sp/rules/optimization/search",
                        media_type="application/vnd.spoptimizationrules.v2+json",
                        body={"maxResults": 100},
                    )[0]
                )["sample_count"]
                else "authorized_empty",
                "authorized": True,
                **summary,
            }
        )
    )

    target_promotion_parts: dict[str, Any] = {}
    for name, path, media in (
        (
            "groups",
            "/sp/targetPromotionGroups/list",
            "application/vnd.sptargetpromotiongroup.v2+json",
        ),
        (
            "targets",
            "/sp/targetPromotionGroups/targets/list",
            "application/vnd.sptargetpromotiongrouptarget.v2+json",
        ),
    ):
        target_promotion_parts[name] = _attempt(
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
                            body={"maxResults": 100},
                        )[0]
                    )["sample_count"]
                    else "authorized_empty",
                    "authorized": True,
                    **summary,
                }
            )
        )
    results["ads_target_promotion_groups"] = {
        "state": "authorized_populated"
        if any(part.get("sample_count") for part in target_promotion_parts.values())
        else "authorized_empty",
        "authorized": all(
            part.get("authorized") is True
            for part in target_promotion_parts.values()
        ),
        "components": target_promotion_parts,
        "sample_count": sum(
            int(part.get("sample_count") or 0)
            for part in target_promotion_parts.values()
        ),
        "field_paths": sorted(
            {
                path
                for part in target_promotion_parts.values()
                for path in part.get("field_paths") or []
            }
        ),
    }
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
    pending: dict[str, str] = {}
    results: dict[str, dict[str, Any]] = {}
    for key, configuration in ADS_REPORT_CONFIGS.items():

        def request(key=key, configuration=configuration) -> dict[str, Any]:
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
            return {"report_id": str(report_id)}

        requested = _attempt(request)
        report_id = requested.get("report_id")
        if report_id:
            pending[key] = str(report_id)
            _progress("ads_report_requested", source=key)
        else:
            results[key] = requested
            _progress(
                "ads_report_finished", source=key, state=requested.get("state")
            )

    deadline = time.monotonic() + ADS_REPORT_TIMEOUT_SECONDS
    while pending and time.monotonic() < deadline:
        completed: list[str] = []
        for key, report_id in list(pending.items()):

            def status(report_id=report_id) -> dict[str, Any]:
                response = client.authenticated_request(
                    "get",
                    f"{client.base}/reporting/reports/{report_id}",
                    scope,
                    accept="application/vnd.getasyncreportresponse.v3+json",
                )
                response.raise_for_status()
                return response.json() if response.content else {}

            status_result = _attempt(status)
            if "error" in status_result:
                results[key] = status_result
                completed.append(key)
                continue
            vendor_status = str(status_result.get("status") or "").upper()
            if vendor_status in {"COMPLETED", "SUCCESS"}:
                location = status_result.get("url") or status_result.get("location")
                if not location:
                    results[key] = {
                        "state": "error",
                        "authorized": True,
                        "error": "Completed Ads report had no download location",
                    }
                else:
                    downloaded = _attempt(
                        lambda location=str(location): client.download_report(location)
                    )
                    if "error" in downloaded:
                        results[key] = {**downloaded, "authorized": True}
                    else:
                        rows = downloaded
                        results[key] = {
                            "state": "authorized_populated"
                            if rows
                            else "authorized_empty",
                            "authorized": True,
                            "sample_count": len(rows),
                            "field_paths": field_paths(rows),
                            "populated": bool(rows),
                        }
                completed.append(key)
            elif vendor_status in {"FAILURE", "FAILED", "CANCELLED"}:
                results[key] = {
                    "state": "authorized_report_unavailable",
                    "authorized": True,
                    "vendor_status": vendor_status,
                    "error": "Amazon accepted the report request but did not produce a data document for this sample window",
                }
                completed.append(key)

        for key in completed:
            pending.pop(key, None)
            result = results[key]
            _progress(
                "ads_report_finished",
                source=key,
                state=result.get("state"),
                sample_count=result.get("sample_count"),
            )
        if pending:
            time.sleep(REPORT_POLL_SECONDS)

    for key in pending:
        results[key] = {
            "state": "timeout",
            "authorized": True,
            "error": f"Ads report remained pending after {ADS_REPORT_TIMEOUT_SECONDS}s",
        }
        _progress("ads_report_finished", source=key, state="timeout")
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
            "inventory_summaries": "SELECT count(*) AS n FROM core.inventory_snapshot WHERE marketplace_id=%s",
            "ads_campaign_core": "SELECT count(*) AS n FROM ads.daily_campaign d JOIN ads.account a USING(account_id) WHERE a.marketplace_id=%s",
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
    _progress("family_started", family="warehouse")
    warehouse = _attempt(_warehouse_evidence)
    if "error" not in warehouse:
        for key, evidence in warehouse.items():
            observed[key] = _combine(observed.get(key, {}), evidence)
    _progress(
        "family_finished",
        family="warehouse",
        state="error" if "error" in warehouse else "completed",
    )

    if settings.spapi_credentials_present:
        client = SpApiClient()
        try:
            _progress("family_started", family="spapi_inline")
            for key, evidence in _inline_spapi(client, sample).items():
                observed[key] = _combine(observed.get(key, {}), evidence)
            _progress("family_finished", family="spapi_inline", state="completed")
            _progress("family_started", family="spapi_reports")
            for key, evidence in _probe_spapi_reports(
                client, str(sample["asin"]), today
            ).items():
                observed[key] = _combine(observed.get(key, {}), evidence)
            _progress("family_finished", family="spapi_reports", state="completed")
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
            _progress("family_started", family="ads_scope")
            scope_result = _attempt(lambda: {"scope": _ads_scope(ads)})
            if scope_result.get("scope"):
                (scope, profile_count) = scope_result["scope"]
                _progress("family_finished", family="ads_scope", state="completed")
                _progress("family_started", family="ads_management")
                for key, evidence in _probe_ads_management(ads, scope).items():
                    observed[key] = _combine(observed.get(key, {}), evidence)
                _progress("family_finished", family="ads_management", state="completed")
                _progress("family_started", family="ads_reports")
                for key, evidence in _probe_ads_reports(ads, scope, today).items():
                    observed[key] = _combine(observed.get(key, {}), evidence)
                _progress("family_finished", family="ads_reports", state="completed")
            else:
                profile_count = 0
                _progress("family_finished", family="ads_scope", state="error")
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
        if cap.probe == "documented_unavailable":
            fallback = {
                "state": "documented_marketplace_unavailable",
                "authorized": None,
                "error": f"Official Amazon availability boundary: {cap.authority}",
            }
        elif cap.probe == "documented_account_unavailable":
            fallback = {
                "state": "documented_account_unavailable",
                "authorized": None,
                "error": f"Official Amazon availability boundary: {cap.authority}",
            }
        else:
            fallback = {
                "state": "documented_not_probed",
                "authorized": None,
                "error": "Documented candidate is not part of the bounded production probe",
            }
        evidence = observed.get(cap.key) or fallback
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
