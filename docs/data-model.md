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

Each merchant-listings report is a complete Amazon seller-catalog snapshot. `core.seller_listing.is_current_listing` records whether the SKU is present in the latest completed snapshot. A previously known SKU that disappears is retained with `is_current_listing=false` and `deleted_at`, so historical orders and accounting remain attributable without treating the old SKU as a current offer. This `DELETED` membership is independent from Amazon's current listing status: a SKU present in the snapshot may still be `Active`, `Inactive`, `Closed`, or another exact Amazon-reported status.

`mart.catalog_onboarding_state` is the canonical lifecycle read:

- `AWAITING_ASIN` — Seller Listings has exposed the SKU, but no ASIN is available yet. Catalog Items cannot help; wait for the next authoritative Listings snapshot.
- `AWAITING_CATALOG` — an ASIN is known but Catalog Items has not yet been attempted for it.
- `CATALOG_PROPAGATING` — Catalog Items was queried, but Amazon did not return the item yet.
- `SOURCE_READY` — Catalog Items returned the known ASIN and source enrichment is available.
- `INACTIVE` — the seller listing is inactive.
- `CLOSED`, `INCOMPLETE`, or `NOT_ACTIVE` — the current snapshot retains the SKU but Amazon reports that exact non-active listing condition; these states remain distinct from `DELETED` snapshot absence.

Deleted historical SKUs do not enter onboarding, taxonomy-action, or Data Health listing counts.

A newly discovered active SKU has a 48-hour onboarding grace. When an ASIN is known but Catalog remains unresolved, the scheduler pulls Catalog forward immediately after Listings discovery and retries every 30 minutes until source enrichment converges. After 48 hours, unresolved ASIN/Catalog evidence becomes a Data Health source-completeness exception.

Seller taxonomy is a separate responsibility layered on top of Amazon source readiness. An unmapped SKU is informational while it is onboarding. Once source data is ready and the 48-hour grace has elapsed, a missing seller taxonomy becomes a Data Health seller-action item. Neither transient source propagation nor mutable seller taxonomy completeness is a code-deployment failure; production QA validates the lifecycle classification itself.

## Decision-surface truth policy

Operating timestamps are rendered in the marketplace business timezone, `America/Mexico_City`, through the shared UI time formatter. Header clocks and absolute freshness/sync timestamps carry the visible `Mexico City` label; browser or host timezone is never used as an implicit fallback. Relative ages remain elapsed-time values.

Interpretive labels are API-owned evaluations of named, versioned rules in `board/interpretation_rules.py`. Each affected payload exposes the relevant `interpretation_rules` definitions plus the current evaluation's `rule_id`, `rule_version`, inputs, eligibility result and label. The shared in-page Rule control displays the window, eligibility, thresholds and current operands without navigating away. Browsers may format the explanation, but must not independently classify the inputs.

Catalog demand labels use a full-window eligibility rule distinct from the 48-hour source-onboarding grace. A current active offer needs 28 calendar days from Amazon `open_date` through the latest traffic cutoff before a 28-day demand judgment such as `DORMANT`, `ACCELERATING`, `DECLINING`, or a funnel comparison is eligible. Until then it is `LEARNING`, with observed and required days exposed. A factual inventory constraint can still take priority during learning because it does not depend on a complete demand window.

### Shared decision-health contract

Business and Data Health use the same server-owned `BUSINESS_DECISION_HEALTH_V1` contract from `board/health_contract.py`. The browser does not infer domain health from job names or independently combine pipeline and catalog conditions.

The Business `6/6` denominator is exactly these primary decision-input pipelines: Orders, Sales & Traffic, Seller Listings, Catalog Items enrichment, FBA Inventory, and Finance transactions. Settlement reports, Orders geography enrichment, and Finance month-close evaluation are supporting jobs. They remain visible in Data Health and can degrade their affected decision domain, but they do not change the six-stream denominator. Ads is optional while access/data is unavailable and is reported separately.

Pipeline freshness is only one part of decision health. Overdue Catalog source evidence and established seller-taxonomy gaps are active Product conditions and must appear beside the pipeline count. Normal Catalog onboarding inside its documented 48-hour propagation grace is informational, not degradation. Both `/api/home` and `/api/data-health` expose the identical contract structure, including the six-stream scope, exclusions, active conditions, affected domains, and overall state.

### Today

Today is operational and provisional. It is driven by near-real-time Orders API data and may change as the day progresses. A partial current day must not be treated as a reconciled historical day.

### Home

Home is a control-center composition. It intentionally combines current operating state with reconciled rolling history and action-oriented inventory/catalog context. The individual source domains remain authoritative for their own definitions.

### Historical Sales

Historical daily sales use reconciled Data Kiosk-backed `mart.business_daily` rows. Rolling 7D/28D/56D/90D windows and monthly history should be derived from the reconciled daily fact, not from live Orders API totals.

Sales Geography uses privacy-minimized Amazon Orders destination state and postal-code evidence. Before any state aggregation, the API resolves each postal code through the packaged SEPOMEX reference to its two-digit federal-entity key. Raw recipient state labels are evidence only: they never define a state bucket. `unmapped_orders` is total orders minus orders with a resolved federal entity. `alias_resolution_pct` is resolved entity orders divided by orders with postal evidence; `alias_resolved_orders` counts resolved orders whose normalized raw state label differs from the SEPOMEX entity name. These measures, canonical entity count and postal coverage remain separate in the API and UI.

Geography product analysis uses the latest complete Amazon seller-catalog snapshot as its current product universe. Historical order facts retain their original `source_sku`, but an old seller SKU sharing an ASIN with a current offer rolls into that offer's `analysis_sku`; it does not become another current product. The default selector contains active current offers with evidence in the selected period. Current offers without period evidence, non-active current offers and historical transaction-only products require the explicit secondary choice. All period scopes use `geography.coverage.geography_last_date`, the latest resolved SEPOMEX postal-order evidence date, as the shared cutoff. An order without usable Geography evidence does not shift this window, and a product's own older last order does not redefine it.

### Trajectory

Trajectory is a view over reconciled historical sales plus portfolio breadth/concentration. Its horizon comparisons are analytical interpretations of the underlying mart data; it does not own a separate sales fact.

### Catalog / Product Workspace

Commercial product identity is assembled server-side from normalized SKU/ASIN records, seller listings, catalog enrichment, configured variation relationships and local label/image overrides.

The current Catalog is bounded by the latest complete Seller Listings snapshot. Amazon Catalog Items parent-child relationships determine which structural parent ASIN containers remain current hierarchy context; those containers do not reuse an old seller SKU record. Historical traffic cannot revive a deleted offer or family. Deleted SKU records are exposed separately for explicit historical lookup and are excluded from current offer/family KPIs, dimensional rollups, filters and decisions.

Every sellable product exposes one canonical identity object from the Catalog API owner. A `SELLABLE_VARIATION` must have a distinct parent ASIN and use that same parent as its family ASIN. A `SELLABLE_STANDALONE` has no canonical parent and uses its own ASIN as its family ASIN; a source self-parent is retained only as audit evidence. Seller-owned family names may replace generic display labels, but their absence must not turn a child variation into “Standalone.”

A `STRUCTURAL_PARENT` is a non-sellable variation container. It is excluded from sellable/active/inactive KPIs, dimensional rollups, decision queues, SKU mode and Catalog onboarding/Data Health counts. The parent row remains in API hierarchy evidence and may be attached to a family only when that family has at least one sellable child; a parent-only container is not a commercial family.

The browser may group/sort/filter data for presentation, but canonical family/variation membership and role semantics should come from the API/data layer. During catalog onboarding, missing dimensions or seller taxonomy may be provisional; consumers must use the lifecycle/source-readiness fields instead of assuming a newly discovered SKU is fully populated.

### Inventory

FBA inventory snapshots are combined with recent reconciled selling velocity to produce coverage and action states. `STOCKOUT`, `PRODUCE`, `PLAN`, `OK` and `HOLD` are business semantics owned by the data/API layer, not CSS/JavaScript convenience labels.

Catalog family cover uses the same pooled rule as portfolio inventory cover: `(sum available + sum inbound) / (sum units sold over 28 days / 28)`, rounded to one decimal day. Children with zero recent velocity contribute stock but no velocity to the pool; if the entire family has zero or unavailable velocity, family cover is unavailable rather than zero. Child-level cover and inventory-risk states remain visible separately and are not replaced by the pooled family value.

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
