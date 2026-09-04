# Amazon data capability inventory for Advertising V2

Status: Batch 0 evidence gate, 2026-09-04

Advertising V2 cannot choose its data sources from the reports DPP already happens to collect. This inventory works in the opposite direction: start from the decisions and safety gates in the Advertising V2 specification, enumerate the current Amazon seller and advertising surfaces that can inform them, and then prove each source against DPP production.

The executable manifest is in `app/dpp_analytics/amazon_capability_probe.py`. It is intentionally separate from application ingestion. The probe does not modify campaigns, persist downloaded samples, or print customer identifiers and payload values.

## Evidence standard

A source is not considered available merely because Amazon documents it. The production readiness record must distinguish:

1. Amazon documents the operation or report for sellers and the MX/NA region.
2. DPP's current production credentials are authorized for it.
3. A bounded production request is accepted.
4. The request returns populated data, or an honest empty/unavailable state.
5. The returned identity can map to canonical order, SKU, ASIN, campaign, ad group, target, keyword, query, placement, portfolio, or rule entities.
6. Its freshness, revision behavior, retention, and backfill limit fit the decision.
7. Its totals or movements can be reconciled to an authoritative source.
8. It is classified as authoritative, supporting evidence, an estimate, or unavailable.

`authorized_empty` is not equivalent to populated. A FATAL or CANCELLED report sample is not equivalent to an authorization rejection. Both distinctions are preserved.

## Capability families

| Family | Current Amazon surfaces considered | Why it matters to Advertising V2 |
|---|---|---|
| Advertising performance | Sponsored Products campaign, advertised-product, targeting, search-term, placement, and purchased-product reports | Spend allocation, same-SKU versus halo economics, placement decisions, query harvesting and negative candidates |
| Advertising state | Campaigns, ad groups, product ads, targets, keywords, negative targets/keywords, portfolios, budget rules and budget usage | Resolve raw IDs, prevent recommendations that conflict with current state, and retain change evidence |
| Advertising estimates and messages | Budget recommendations, product-target recommendations, Amazon Marketing Stream | Supporting ranges, intraday pacing, entity changes and candidate discovery; never authoritative economics |
| Retail demand | Data Kiosk Sales and Traffic, Search Query Performance, Search Catalog Performance, Amazon Search Terms, Market Basket and Repeat Purchase | Diagnose whether the problem is reach, click appeal, listing conversion, market demand, price or repeat behavior |
| Product and offer | Catalog Items, Listings, Product Pricing | Product identity, variation family, suppression/offer state, price and featured-offer context |
| Unit economics | Finances v2024, Settlement V2, Product Fees, FBA Fee Preview and Referral Fee Preview | Actual charges and refunds after reconciliation; current fee estimates only for planning and sensitivity |
| Inventory and fulfillment | Inventory Summaries, Inventory Ledger, Reserved, Stranded, Manage Inventory Health, Restock, Storage Fees | Hard safety gates for constrained or stranded products and evidence for carrying cost and fulfillment causes |
| Returns and offsets | FBA Returns, Replacements and Reimbursements | Product-quality problems, hidden replacement cost, refund effects and reimbursement offsets |
| Commercial confounders | Orders v2026 optional data, Promotion Performance and Coupon Performance | Prevent promotion, coupon, cancellation, tax or fulfillment changes from being misattributed to advertising |

## Important contract findings

- Sponsored Products Search Term reports only contain impressions that generated at least one click and retain data for 65 days. DPP must collect this source continuously and backfill it immediately.
- Campaign, Targeting and Advertised Product reports retain 95 days. Purchased Product retains 95 days for Sponsored Products.
- Current Sponsored Products report contracts expose same-SKU and other-SKU sales/purchases. These are attribution partitions, not incremental sales.
- Campaign reports can group by `campaignPlacement` and expose placement classification, bidding strategy, top-of-search impression share, budget amount/type and applied budget-rule context.
- Purchased Product reports connect advertised ASIN, purchased ASIN, campaign, ad group and keyword/target evidence. DPP does not currently ingest this report.
- The production Finance raw envelope includes transaction `items`, `contexts`, `relatedIdentifiers`, and `breakdowns`. Current normalization discards item/context structures that may supply SKU/ASIN and fulfillment-level economics.
- Orders v2026 offers optional `EXPENSE`, `TAX`, and `CANCELLATION` data in addition to the proceeds, fulfillment and promotion data DPP currently requests.
- Data Kiosk currently hosts Seller Sales and Traffic data and applies authorization per GraphQL field. Its schema is evolutionary, and reports are expected to migrate there over time.
- Brand Analytics for sellers includes Search Catalog Performance, Search Query Performance, Market Basket, Amazon Search Terms and Repeat Purchase. Monthly SQP is not the complete available demand surface.
- FBA Manage Inventory Health includes sales windows, inbound state, aged/excess units, estimated storage exposure, sell-through and days of supply. Stranded and Reserved reports provide separate safety evidence.
- Product Fees, FBA Fee Preview, Referral Fee Preview, storage estimates, Ads budget recommendations and Amazon-generated target/restock recommendations are estimates or suggestions. They cannot replace reconciled actuals or DPP safety logic.
- Amazon Marketing Stream is available in Mexico through the NA endpoint and can deliver hourly target/ad/placement performance deltas plus budget and entity messages. It requires a customer-owned AWS destination and forward collection, so it is not an automatic substitute for historical reports.
- Mexico supports Sponsored Products budget recommendations, product recommendations and rule-based bidding. Consolidated campaign recommendations are currently listed as US-only.

## Primary documentation

- [Advertising V2 decision-system specification](ads-v2-decision-system-spec.md)
- [Amazon Ads Reporting v3 report types](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/report-types/overview)
- [Amazon Ads Reporting v3 columns](https://advertising.amazon.com/API/docs/en-us/guides/reporting/v3/columns)
- [Sponsored Products marketplace feature availability](https://advertising.amazon.com/API/docs/en-us/guides/sponsored-products/features)
- [Sponsored Products campaign-management API](https://advertising.amazon.com/API/docs/en-us/sponsored-products/3-0/openapi/prod)
- [Amazon Marketing Stream data guide](https://advertising.amazon.com/API/docs/en-us/guides/amazon-marketing-stream/data-guide)
- [SP-API report type values](https://developer-docs.amazon.com/sp-api/docs/report-type-values)
- [SP-API Analytics reports](https://developer-docs.amazon.com/sp-api/docs/report-type-values-analytics)
- [SP-API FBA reports](https://developer-docs.amazon.com/sp-api/docs/report-type-values-fba)
- [SP-API Returns reports](https://developer-docs.amazon.com/sp-api/docs/report-type-values-returns)
- [Data Kiosk API](https://developer-docs.amazon.com/sp-api/docs/data-kiosk-api)
- [Finances API v2024-06-19](https://developer-docs.amazon.com/sp-api/docs/finances-api-v2024-06-19-reference)
- [Orders API migration guide](https://developer-docs.amazon.com/sp-api/docs/orders-api-migration-guide)
- [Product Fees API](https://developer-docs.amazon.com/sp-api/docs/product-fees-api)

## Gate to implementation

The production source-readiness workflow publishes the executable matrix to controller issue #449. Advertising V2 application implementation remains blocked until that evidence has been reviewed and each required source is assigned one of these dispositions:

- ingest now;
- supporting evidence only;
- retain for a later batch;
- unavailable, with the degraded product state defined.

No recommendation may be manufactured from a documented-but-unverified source.
