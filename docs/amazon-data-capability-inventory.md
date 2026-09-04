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
| Advertising performance | Sponsored Products campaign, ad-group, advertised-product, targeting, search-term, placement, purchased-product, and gross/invalid-traffic reports | Spend allocation, same-SKU versus halo economics, placement decisions, query harvesting, negative candidates, and traffic-quality trust |
| Advertising state | Campaigns, ad groups, product ads, targets, keywords, negative targets/keywords, portfolios, budget rules, campaign optimization rules, target promotion groups and budget usage | Resolve raw IDs, prevent recommendations that conflict with current or Amazon-managed state, and retain change evidence |
| Advertising estimates and messages | Budget and budget-rule recommendations, product/category/keyword/negative-brand target recommendations, theme-based bid recommendations, Amazon Marketing Stream | Supporting ranges, intraday pacing, entity changes and candidate discovery; never authoritative economics |
| Retail demand | Data Kiosk Sales and Traffic, Search Query Performance, Search Catalog Performance, Amazon Search Terms, Market Basket and Repeat Purchase | Diagnose whether the problem is reach, click appeal, listing conversion, market demand, price or repeat behavior |
| Product and offer | Catalog Items, All Listings, Suppressed Listings, Product Pricing | Product identity, variation family, suppression reason/age, offer state, price and featured-offer context |
| Listing quality and eligibility | Listings Items issues/status/offers, Listings Restrictions, A+ Content publishing, FBA Inbound Eligibility | Separate listing defects, restrictions, missing enhanced content and replenishment eligibility from an advertising problem |
| Unit economics | Finances v2024, Settlement V2, Product Fees, FBA Fee Preview and Referral Fee Preview | Actual charges and refunds after reconciliation; current fee estimates only for planning and sensitivity |
| Inventory and fulfillment | Inventory Summaries, Inventory Ledger, Reserved, Stranded, Manage Inventory Health, Restock, Inbound Performance and Storage Fees | Hard safety gates for constrained or stranded products and evidence for carrying cost and fulfillment causes |
| Returns and offsets | FBA Returns, Replacements and Reimbursements | Product-quality problems, hidden replacement cost, refund effects and reimbursement offsets |
| Commercial confounders | Orders v2026 optional data, FBA shipment promotions, Promotion Performance and Coupon Performance | Prevent promotion, coupon, cancellation, tax or fulfillment changes from being misattributed to advertising |

## Important contract findings

- Sponsored Products Search Term reports only contain impressions that generated at least one click and retain data for 65 days. DPP must collect this source continuously and backfill it immediately.
- Campaign, Targeting and Advertised Product reports retain 95 days. Purchased Product retains 95 days for Sponsored Products.
- Gross and Invalid Traffic retains 365 days and exposes campaign-level gross impressions/click-throughs, invalid impressions/click-throughs, and invalid rates. It is data-quality evidence; Amazon's valid charged spend remains the economic fact.
- Sponsored Products Campaign reporting can be grouped by campaign, ad group, or campaign placement. Ad-group performance is a distinct diagnostic grain even though Sponsored Products has no separate ad-group report type.
- Current Sponsored Products report contracts expose same-SKU and other-SKU sales/purchases. These are attribution partitions, not incremental sales.
- Campaign reports can group by `campaignPlacement` and expose placement classification, bidding strategy, top-of-search impression share, budget amount/type and applied budget-rule context.
- Purchased Product reports connect advertised ASIN, purchased ASIN, campaign, ad group and keyword/target evidence. DPP does not currently ingest this report.
- The production Finance raw envelope includes transaction `items`, `contexts`, `relatedIdentifiers`, and `breakdowns`. Current normalization discards item/context structures that may supply SKU/ASIN and fulfillment-level economics.
- Orders v2026 offers optional `EXPENSE`, `TAX`, and `CANCELLATION` data in addition to the proceeds, fulfillment and promotion data DPP currently requests.
- Data Kiosk currently hosts Seller Sales and Traffic data and applies authorization per GraphQL field. Its schema is evolutionary, and reports are expected to migrate there over time.
- Brand Analytics for sellers includes Search Catalog Performance, Search Query Performance, Market Basket, Amazon Search Terms and Repeat Purchase. Monthly SQP is not the complete available demand surface.
- FBA Manage Inventory Health includes sales windows, inbound state, aged/excess units, estimated storage exposure, sell-through and days of supply. Stranded and Reserved reports provide separate safety evidence.
- The All Listings report exposes status but not the reason a listing is suppressed. The separate Suppressed Listings report exposes SKU, ASIN, reason, issue description and status-change date and is therefore a required hard-safety source.
- FBA Inbound Performance exposes product- and shipment-level inbound problems, expected versus received quantity, coaching state and fees. It can explain why nominal inbound supply is not yet safe advertising capacity.
- The FBA Promotions report supplies order-level shipment promotion discounts that can be joined to shipment facts. Promotion Performance and Coupon Performance remain separate campaign-level confounder sources.
- Estimated monthly storage cost is not the same fact as an aged-inventory surcharge already charged. FBA Long Term Storage Fee Charges supplies SKU/ASIN charge and age-tier detail and must reconcile to Finance and settlement before entering contribution.
- Product Fees, FBA Fee Preview, Referral Fee Preview, storage estimates, Ads budget recommendations and Amazon-generated target/restock recommendations are estimates or suggestions. They cannot replace reconciled actuals or DPP safety logic.
- Amazon Marketing Stream is available in Mexico through the NA endpoint and can deliver hourly target/ad/placement performance deltas plus budget and entity messages. It requires a customer-owned AWS destination and forward collection, so it is not an automatic substitute for historical reports.
- Mexico supports Sponsored Products budget recommendations, product recommendations and rule-based bidding. Consolidated campaign recommendations are currently listed as US-only.
- Keyword recommendations v4 are available across marketplaces and may expose search-term impression share and rank for keywords with advertiser impressions. They are competitive estimates attached to Amazon suggestions, not observed paid-query facts or permission to raise bids.
- Theme-based bid recommendations support keyword, automatic and product targets across Sponsored Products marketplaces. Suggested bids and impact claims remain experiment inputs, never authoritative contribution forecasts.
- Category, product-target and negative-brand recommendations can expose useful candidate space. They may include the advertiser's own brand and must pass DPP relevance, economics, inventory, listing and conflict gates before any test is proposed.
- The FBA Replacements report is request-only and updated daily; Amazon does not document a selectable report window. DPP must request the current report without date parameters and retain daily raw evidence for history.
- Catalog Items exposes nine seller-accessible component families used by DPP: attributes, classifications, dimensions, identifiers, images, product types, relationships, sales ranks and summaries. The separate `vendorDetails` component is vendor-account-only and is an explicit account-type boundary, not a partial seller-source failure.
- Campaign optimization rules and target promotion groups are separate from ordinary bids, targets and budget rules. DPP must snapshot them because Amazon-managed automation can otherwise make a recommendation stale or create an overlapping action.
- Prompt Ad Extension reporting currently filters to the US marketplace, and Video Ad Extension reporting is explicitly US-only. Both remain documented expansion boundaries rather than silent omissions from the MX plan.
- Customer Feedback review and return-topic insights are useful listing-quality evidence but Amazon currently exposes that API only in US, UK, FR, IT, DE, ES and JP, not MX. DPP must show the diagnosis as unavailable rather than infer review topics.
- Listings Items is a richer seller-offer source than the bulk All Listings report: it exposes BUYABLE/DISCOVERABLE status, issue severity and messages, current offers, fulfillment availability, relationships and product types. Suppressed Listings remains a separate bulk safety source, while Listings Restrictions describes catalog/brand/condition restrictions rather than current offer health.
- Fulfillment Inbound v2024 is available in Mexico and can list current inbound plans with lifecycle timestamps and status. Its plan, shipment and item details can later tie expected supply to SKU/ASIN and delivery-window evidence; the read-only list is probed before DPP relies on that workflow.
- FBA Inbound Eligibility exposes ASIN-level reasons that inventory cannot be replenished. For inventory-constrained products, an ineligible result is a hard block on recommendations to increase advertising support.
- A+ Content publish records expose whether enhanced detail-page content is published, rejected or stale for an ASIN. This is supporting listing-conversion evidence, never proof that advertising caused the conversion problem.

## Official SP-API surface review

The production probes are the decision-relevant subset of a full review of Amazon's current report catalog and adjacent APIs. Exclusions below are explicit so a later implementation does not mistake “not already ingested” for “not reviewed.”

| Official family | Coverage or boundary for DPP MX |
|---|---|
| Analytics | All five seller Brand Analytics reports are probed: Search Query Performance, Search Catalog Performance, Market Basket, Amazon Search Terms and Repeat Purchase. Seller Sales and Traffic is already ingested through Data Kiosk. Vendor retail analytics are vendor-only. |
| FBA sales | Customer Shipment Sales and FBA Promotions are probed. Legacy all-orders and Amazon-fulfilled-shipment variants overlap Orders v2026 and the shipment fact; tax/invoicing variants add restricted or region-specific fields rather than a new advertising decision grain. |
| FBA inventory | Inventory Summaries, Ledger, Reserved, Manage Inventory Health, Restock, Inbound Performance and Stranded are probed. AFN inventory and archived/manage-inventory variants duplicate covered snapshots. Recommended-removal and removal-order reports remain later operational sources because Inventory Health and Ledger already expose the required safety state and movements. |
| Fulfillment Inbound APIs | The Mexico-supported v2024 plan list and ASIN Inbound Eligibility preview are probed. Detailed plan shipment/item/delivery-window snapshots are a later expansion after live plan identity is confirmed; write operations remain outside Advertising V2. |
| FBA economics | Fee Preview, Storage Fees, Long Term Storage Fee Charges, Reimbursements, Returns and Replacements are probed. Storage-overage fees are account/storage-type overhead without product identity and cannot be assigned to a product recommendation as if product-attributable. |
| Listings | All Listings and Suppressed Listings are covered. Active, inactive, open, lite and cancelled variants are subsets or projections of those states. Listings Items issue-change notifications are a useful forward-only freshness enhancement after a notification destination is owned. |
| Catalog and offer | All nine seller-accessible Catalog Items components, current competitive pricing and product-fee estimates are probed. Catalog `vendorDetails` and Vendor Analytics are vendor-account-only boundaries, not seller sources left unused. |
| Listing detail and content | Listings Items status/issues/offers/availability, Listings Restrictions and A+ Content publish status are probed read-only. Product Type Definitions is schema for authoring/validating listing changes, not an observed performance fact. A+ document mutation and all listing writes remain outside V2. |
| Orders, payments and tax | Orders v2026 optional proceeds, expense, promotion, cancellation, fulfillment and tax structures are probed. Finance v2024 and Settlement V2 cover actual money. Legacy order, tax and invoice reports are not an independent business fact for current FBA advertising decisions. Financial Holds is account-level cash availability, not product contribution. |
| Promotions and performance | Promotion Performance and Coupon Performance are probed. Seller Feedback and Seller Performance are account-level health sources; they do not identify a product, campaign, query or target and cannot drive a product spend recommendation. |
| Returns | FBA Returns is probed for the current FBA model. Merchant-fulfilled return reports become required if DPP supports advertised MFN inventory; they are not interchangeable with FBA return dispositions. |
| Regional and program reports | Pan-European, EU page-view compliance, Easy Ship, India GST and vendor-only reports are unavailable or inapplicable to the current MX seller. Amazon Business and Subscribe & Save sources remain program-conditional rather than assumed available. |

Adjacent event streams were also reviewed. `DETAIL_PAGE_TRAFFIC_EVENT`, `ITEM_SALES_EVENT_CHANGE`, `ITEM_INVENTORY_EVENT_CHANGE`, `FBA_INVENTORY_AVAILABILITY_CHANGES`, `LISTINGS_ITEM_ISSUES_CHANGE`, `LISTINGS_ITEM_STATUS_CHANGE`, `ANY_OFFER_CHANGED` and `PRICING_HEALTH` can reduce latency after DPP owns a Notifications destination. They are forward-only transport alternatives, not additional historical facts, and must reconcile to the covered reports/APIs. Amazon Marketing Stream has the same destination prerequisite on the Ads side and is already represented explicitly.

Sponsored Products management APIs reviewed but not promoted to authoritative inputs include consolidated campaign recommendations and keyword groups where Amazon documents US-only availability, global recommendations outside the current single-MX scope, category taxonomy/refinements, targetable-ASIN counts and initial-budget recommendations. These may enrich later workflows but cannot override DPP economics or safety gates.

Current Ads production evidence contains only `SPONSORED_PRODUCTS`. Sponsored Brands and Sponsored Display reporting/management, Amazon Marketing Cloud, and Amazon Attribution are separate authorization and product-expansion boundaries; they are not silently mixed into the Sponsored Products decision contract or represented as current missing rows.

## Sponsored Products reporting coverage

Amazon's Reporting v3 matrix currently lists eight Sponsored Products report surfaces. Batch 0 treats each explicitly:

| Official report surface | MX disposition |
|---|---|
| Campaign, including campaign/ad-group and placement groupings | production probe; ingest or expand now |
| Advertised product | production probe; ingest now |
| Targeting | production probe; ingest now |
| Search term | production probe; ingest and backfill immediately because source retention is 65 days |
| Purchased product | production probe; ingest as halo attribution, never incrementality |
| Gross and invalid traffic | production probe; ingest as traffic-quality evidence |
| Prompt Ad Extension | documented US-only; unavailable to DPP MX |
| Video Ad Extension | documented US-only; unavailable to DPP MX |

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
- [Fulfillment Inbound API](https://developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api)
- [Listings Items API](https://developer-docs.amazon.com/sp-api/docs/listings-items-api)
- [Listings Restrictions API](https://developer-docs.amazon.com/sp-api/docs/listings-restrictions-api)
- [A+ Content publish-record operation](https://developer-docs.amazon.com/sp-api/reference/searchcontentpublishrecords)

## Gate to implementation

The production source-readiness workflow publishes the executable matrix to controller issue #449. Advertising V2 application implementation remains blocked until that evidence has been reviewed and each required source is assigned one of these dispositions:

- ingest now;
- supporting evidence only;
- retain for a later batch;
- unavailable, with the degraded product state defined.

No recommendation may be manufactured from a documented-but-unverified source.

After the complete Batch 0 production artifact is accepted, run
`.github/workflows/amazon-source-readiness.yml` manually when a source contract,
authorization, marketplace, or inventory row changes. The exhaustive probe is
not part of routine deployment: it consumes rate-limited Amazon report requests
and shares the production concurrency lock with deployments.
