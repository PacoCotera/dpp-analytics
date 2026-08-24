# DPP Analytics data model

PostgreSQL is the canonical business-data store. The worker ingests and reconciles Amazon sources into database layers; the board reads those layers and should not recreate business truth in browser JavaScript.

## Database layers

- `raw` — source payloads retained for replay/audit where practical, excluding customer PII by design.
- `core` — normalized entities and transactional facts.
- `mart` — dashboard-ready reconciled views, rolling KPIs, inventory attention, Finance state and other decision models.
- `ops` — ingestion state, cursors, schema migrations and operational health.

Schema changes belong in `sql/migrations/`. Treat applied migrations as forward-moving production history.

## Current ingestion sources

The Python ingestion worker lives in `app/dpp_analytics/`. Source enablement and cadence are environment-controlled; a module existing in the repo does not imply every credential is currently enabled.

| Source | Primary purpose | Default cadence / behavior |
| --- | --- | --- |
| Orders API v2026-01-01 | Near-real-time orders/items and intraday operating pulse | `ORDERS_INTERVAL_SECONDS`, default 180s |
| FBA Inventory API v1 | Fulfillable/inbound/reserved/unfulfillable inventory snapshots | `INVENTORY_INTERVAL_SECONDS`, default 1800s |
| Reports API merchant listings | Full seller listing/inventory breadth and first discovery of seller SKUs | `LISTINGS_REPORT_INTERVAL_SECONDS`, default 21600s |
| Catalog Items API | Product/catalog enrichment for known ASINs | `CATALOG_INTERVAL_SECONDS`, default 86400s; unresolved onboarding with a known ASIN retries every 1800s |
| Data Kiosk | Reconciled historical sales and traffic | `DATA_KIOSK_INTERVAL_SECONDS`, default 43200s |
| Finances API | Released/deferred financial events, fees, refunds, transfers and advertising postings | `FINANCES_INTERVAL_SECONDS`, default 14400s |
| Amazon Ads reporting | Campaign/product/target/search-term attributed performance | `AMAZON_ADS_REPORTING_INTERVAL_SECONDS`, default 21600s |

Backfill start dates and polling timeouts are also environment-controlled in `compose.yml`.

### Seller catalog discovery and onboarding rule

Do not loop Catalog Items to discover the seller's complete active inventory. The seller-wide listing universe comes from the Reports API merchant-listings report. Catalog Items is for enrichment/search of known catalog entries.

Discovery and enrichment are intentionally separate because Amazon may expose a new offer incompletely while it is propagating. `core.seller_listing.first_seen_at` records when a seller SKU first entered our warehouse. Catalog request attempts are tracked in `ops.catalog_item_attempt`; `core.catalog_item` is created only when Amazon actually returns a Catalog entity. Returned entities also retain their latest attempt/enrichment timestamps for audit compatibility.

`mart.catalog_onboarding_state` is the canonical lifecycle read:

- `AWAITING_ASIN` — Seller Listings has exposed the SKU, but no ASIN is available yet. Catalog Items cannot help; wait for the next authoritative Listings snapshot.
- `AWAITING_CATALOG` — an ASIN is known but Catalog Items has not yet been attempted for it.
- `CATALOG_PROPAGATING` — Catalog Items was queried, but Amazon did not return the item yet.
- `SOURCE_READY` — Catalog Items returned the known ASIN and source enrichment is available.
- `INACTIVE` — the seller listing is inactive.

A newly discovered active SKU has a 48-hour onboarding grace. When an ASIN is known but Catalog remains unresolved, the scheduler pulls Catalog forward immediately after Listings discovery and retries every 30 minutes until source enrichment converges. After 48 hours, unresolved ASIN/Catalog evidence becomes a Data Health source-completeness exception.

Seller taxonomy is a separate responsibility layered on top of Amazon source readiness. An unmapped SKU is informational while it is onboarding. Once source data is ready and the 48-hour grace has elapsed, a missing seller taxonomy becomes a Data Health seller-action item. Neither transient source propagation nor mutable seller taxonomy completeness is a code-deployment failure; production QA validates the lifecycle classification itself.

## Decision-surface truth policy

### Today

Today is operational and provisional. It is driven by near-real-time Orders API data and may change as the day progresses. A partial current day must not be treated as a reconciled historical day.

### Home

Home is a control-center composition. It intentionally combines current operating state with reconciled rolling history and action-oriented inventory/catalog context. The individual source domains remain authoritative for their own definitions.

### Historical Sales

Historical daily sales use reconciled Data Kiosk-backed `mart.business_daily` rows. Rolling 7D/28D/56D/90D windows and monthly history should be derived from the reconciled daily fact, not from live Orders API totals.

### Trajectory

Trajectory is a view over reconciled historical sales plus portfolio breadth/concentration. Its horizon comparisons are analytical interpretations of the underlying mart data; it does not own a separate sales fact.

### Catalog / Product Workspace

Commercial product identity is assembled server-side from normalized SKU/ASIN records, seller listings, catalog enrichment, configured variation relationships and local label/image overrides.

The browser may group/sort/filter data for presentation, but canonical family/variation membership and role semantics should come from the API/data layer. During catalog onboarding, missing dimensions or seller taxonomy may be provisional; consumers must use the lifecycle/source-readiness fields instead of assuming a newly discovered SKU is fully populated.

### Inventory

FBA inventory snapshots are combined with recent reconciled selling velocity to produce coverage and action states. `STOCKOUT`, `PRODUCE`, `PLAN`, `OK` and `HOLD` are business semantics owned by the data/API layer, not CSS/JavaScript convenience labels.

### Advertising

Amazon Ads metrics are attribution data. ACOS and ROAS use Amazon-attributed sales; TACOS uses an independent total-seller-sales denominator.

**Never define “organic sales” as total seller sales minus attributed ad sales.** Attribution windows can overlap, lag and restate after the underlying seller sale.

### Finance

Finance deliberately separates:

1. reconciled seller sales;
2. Amazon financial events/postings;
3. seller-owned product COGS;
4. Amazon-side month closure;
5. immutable management close.

Current month economics are provisional. Historical management-closed months come from immutable close snapshots, including frozen SKU COGS. Later edits to standard product cost must not silently rewrite a closed month; corrections require an explicit restatement/version.

Cash transfers are a cash-timing metric, not economic contribution.

## Product-cost and local configuration policy

Production business configuration is host-owned:

- product costs: `/etc/dpp-analytics/board-config/product_costs.json` → `/config/product_costs.json` in worker/board;
- product variations: `/etc/dpp-analytics/board-config/product_variations.json` → `/config/product_variations.json` in the board;
- product labels/display overrides: `/etc/dpp-analytics/product_labels.json` → `/app/product_labels.json` in the board.

Repository JSON files are defaults/seeds unless deployment automation explicitly replaces the host-owned file. Do not move secrets or mutable production business configuration into Git for convenience.

## Customer-data policy

The platform intentionally avoids customer PII. Orders ingestion requests operational/fulfillment/proceeds information needed for business analytics and does not intentionally surface buyer/recipient information in the board.

If a future use case requires customer-identifying data, treat that as a separate privacy/security architecture decision rather than extending the current model implicitly.

## When to update this document

Update this file in the same PR when:

- a new source becomes authoritative for a metric;
- a provisional metric becomes reconciled/final by a different process;
- Finance close/restatement semantics change;
- an inventory/catalog/ads business definition moves layers;
- a production configuration path changes;
- a new ingestion source is added or an old one retired.
