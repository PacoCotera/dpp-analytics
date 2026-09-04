# DPP Analytics maintenance guide

Use this document as the first stop when changing or debugging the application. It maps the runtime to the files that own it and records the invariants that are easy to break if you infer behavior from filenames alone.

## Runtime at a glance

`compose.yml` defines four production services:

- `postgres` — PostgreSQL 18, canonical data store.
- `worker` — Python ingestion/reconciliation worker built from `app/`.
- `board` — Python operating-board server built from `board/`, exposed on host port `8088`.
- `grafana` — supporting dashboards, exposed on host port `3000`.

The board is server-rendered only in the sense that Python serves static HTML and JSON APIs. Page behavior runs in source-controlled browser JavaScript. Docker does **not** inject frontend behavior; `board/server.py` exposes the deployed commit as page metadata and the shared application shell renders it on demand.

## Workspace ownership map

| Route                               | API / business owner                                                                              | HTML                      | CSS                                 | Browser runtime                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| `/`, `/today`                       | `board/today_api.py`                                                                              | `board/static/today.html` | `today.css`                         | `today.js` + tiny synchronous `today-bootstrap.js` for wall mode           |
| `/business`, `/home`, `/index.html` | `board/home_api.py`; shared decision health: `board/health_contract.py`                           | `home.html`               | `home.css`                          | `home.js`                                                                  |
| `/sales`                            | canonical Sales adapter over `board/sales_api.py`; lazy Geography: `board/sales_geography_api.py` | `sales.html`              | `sales.css` + `sales-geography.css` | `sales-canonical.js` + lazy `sales-geography.js` / `sales-geography-v2.js` |
| `/catalog`                          | `board/catalog_api.py`                                                                            | `catalog.html`            | `catalog.css`                       | `catalog.js`                                                               |
| `/product?sku=...`                  | `board/product_api.py`                                                                            | `product.html`            | `product.css`                       | `product.js`                                                               |
| `/inventory`                        | `board/inventory_api.py`                                                                          | `inventory.html`          | `inventory.css`                     | `inventory.js`                                                             |
| `/ads`                              | `board/ads_api.py`                                                                                | `ads.html`                | `ads.css`                           | `ads.js`                                                                   |
| `/finance`                          | runtime module imported as `finance_api` by `board/server.py`                                     | `finance.html`            | `finance.css`                       | `finance.js`                                                               |
| `/trajectory`                       | `board/trajectory_api.py`                                                                         | `trajectory.html`         | `trajectory.css`                    | `trajectory.js`                                                            |
| `/data-health`                      | `board/health_api.py`; shared decision health: `board/health_contract.py`                         | `data_health.html`        | `data-health.css`                   | `data-health.js`                                                           |

### Two filename traps

1. **Sales:** `sales-canonical.js` is the live Sales Overview/Drivers renderer. “canonical” is historical naming, not a second implementation. Geography is intentionally a separate lazy runtime and payload because its postal history is optional heavy detail, not part of the default Sales snapshot.
2. **Finance:** the current `board/Dockerfile` copies `board/finance_emergency.py` into the image as `/app/finance_api_legacy.py`, then copies `board/finance_api_corrected.py` as `/app/finance_api.py`. The adapter is the production entry point; the legacy module still owns period state and immutable-close aggregation. `board/finance_api.py` and `board/finance_safe.py` are not the packaged runtime. Do not infer Finance ownership from repository filenames alone. Normalize this naming only as a deliberate behavior-neutral cleanup with Finance smoke validation.

## Shared frontend ownership

Before adding page-specific code, check whether the behavior belongs in one of these shared layers:

| File                                                       | Owns                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `board/presentation/profiles.json` / `profile.schema.json` | authoritative, schema-validated six-profile presentation configuration                                                                           |
| `scripts/build-presentation-profiles.mjs`                  | generates the source-controlled browser registry and profile CSS; `--check` rejects drift                                                        |
| `presentation-registry.js` / `presentation-profiles.css`   | generated browser registry and semantic token scopes; do not edit directly                                                                       |
| `presentation.js`                                          | synchronous profile restoration, root attributes, browser chrome, local preference and public apply/reset API                                    |
| `theme.css`                                                | global token aliases, typography and base visual language                                                                                        |
| `nav-shell.css`                                            | fixed desktop sidebar, connected global header, accessible mobile drawer, and the shared short/long page-height contract                         |
| `ui-shell.js`                                              | ordered primary navigation, active route, global identity, tab keyboard behavior, mobile drawer behavior and the shared build-diagnostics footer |
| `layout-system.css`                                        | reusable page headers, KPI rails, panels, grids, segmented controls, tables and status strips                                                    |
| `chart-system.css` / `chart-system.js`                     | reusable chart grammar, axes, tooltips, legends, period treatment and shared chart forms                                                         |
| `data-cache.js`                                            | session-scoped GET JSON cache, browser in-flight dedupe and endpoint freshness policy                                                            |
| `ui-utils.js`                                              | escaping, number/money formatting, DOM helpers, shared interpretation-rule disclosure and JSON-fetch facade used by ES-module pages              |
| `vendor/d3.v7.min.js`                                      | vendored D3 runtime                                                                                                                              |

A page should not add a second nav, duplicate generic panel geometry, inject CSS from JavaScript, or create a post-render “enhancer” layer.

### Static asset release contract

`board/asset_release.py` owns one content-derived revision manifest for the complete `board/static/` tree. `board/server.py` applies that revision to page dependencies and to transitive local CSS/JavaScript references before serving them. Page code must not invent a second asset token or leave a dynamic asset outside this contract; dynamic loaders must propagate the query string of their versioned entrypoint.

- Versioned `/assets/...?...v=<revision>` responses use a one-year immutable cache lifetime and expose both `ETag` and `X-DPP-Asset-Revision`.
- Stable asset URLs remain available for diagnostics and compatibility, but require revalidation and bind any transitive import to the current revision.
- Stable HTML routes use `no-cache` plus ETag validation and expose the same release header and `<meta name="dpp-asset-revision">` value.
- `/assets/manifest.json?v=<revision>` lists every source asset and its exact release URL. A request for a revision other than the active manifest fails with `409` and `no-store` so a mixed release cannot be mistaken for a valid asset response.
- Every HTML workspace declares the shared `/assets/favicon.svg` icon, which receives the same release revision as other page dependencies. `/favicon.ico` remains a valid SVG compatibility route for user agents that request the implicit path.
- `qa/asset_revision_qa.mjs` is the production gate for one revision across all workspaces, complete manifest membership, immutable caching, stable validators, and revision-mismatch rejection.

When adding a local asset type or constructing a URL dynamically, extend `board/asset_release.py` and the production QA in the same change. Do not restore short-TTL caching on fingerprinted URLs.

`board/metric_windows.py` is the shared server owner for rolling 28-day source and cutoff contracts. Home, Sales and Trajectory reuse `RECONCILED_BUSINESS_T28`; Sales Drivers, Catalog and Product Workspace reuse `RECONCILED_PRODUCT_T28`; Inventory and Product Workspace reuse `INVENTORY_ORDER_VELOCITY_T28`. `ui-utils.js` formats those API contracts for display. Page runtimes must not reconstruct a cutoff or relabel order-based inventory velocity as reconciled product demand.

## Where business truth lives

### Shared interpretation rules

`board/interpretation_rules.py` owns the named and versioned decision rules used by Business, Today, Sales, Catalog and Trajectory. API evaluations expose their current inputs and eligibility beside `interpretation_rules`; `board/static/ui-utils.js` only renders the shared in-workflow Rule detail. Do not reintroduce label thresholds in a page runtime.

When changing an interpretation rule:

1. Change its evaluator and metadata together, including the input list, window, exact boundary operators and eligibility.
2. Increment the rule version when an existing label can change for the same inputs.
3. Add exact-boundary tests in `board/test_interpretation_rules.py`.
4. Keep Catalog's 28-day demand eligibility separate from its 48-hour Amazon source-propagation grace.
5. Verify `qa/interpretation_rules_qa.mjs` against production so every active surface exposes the rule and current evidence.

### Today

Today is deliberately provisional and near-real-time. Its operating pulse is driven by Orders API data. Do not compare a partial live day as though it were a reconciled closed day.

### Historical Sales and Trajectory

Reconciled historical daily sales use Data Kiosk-backed `mart.business_daily` data. This is the basis for rolling windows and structural trajectory. Browser code may choose a display window but must not redefine the reconciled sales fact.

The default `/api/sales` payload deliberately excludes postal geography. `/api/sales/geography` reads the existing reduced Orders geography marts only when the user opens Geography, then `sales_geography_api.py` resolves every postal row to its canonical SEPOMEX federal-entity key before aggregation. It also owns Geography product identity: current offers come from the latest Amazon seller-catalog snapshot, while raw historical seller SKUs remain `source_sku` transaction evidence and same-ASIN aliases roll into the current offer's `analysis_sku`. The browser may scope canonical product choices to the selected globally anchored period, but must not rebuild catalog membership or alias mappings. Raw destination-state labels must not be aggregated or normalized in browser JavaScript. The split is a transport/performance boundary, not a new sales fact or privacy policy. National state boundaries are the validated release asset `mexico-states-90a1d52.geojson`, derived from geoBoundaries `MEX-ADM1-31927357` at commit `90a1d5290ede3adc147c5a2351472fd000412e72` (INEGI source, CC BY 3.0 IGO). Postal polygons come from `open-mexico/mexico-geojson` at commit `ff9a744df9e9c1db66d5de40ae14a71920cb72e7` (MIT) and are downloaded, validated and compressed only during the board-image build. Neither national nor postal map rendering makes a third-party geometry request at view time; a geometry failure must leave the ranked table visible.

### Catalog and Product Workspace

Catalog identity is assembled server-side from seller listings, catalog data, configured variation relationships and local display overrides. Use the Reports API merchant-listings path for seller inventory/listing breadth rather than looping Catalog Items to discover the seller's entire catalog.

Treat each completed merchant-listings report as the canonical current snapshot, not as an append-only union. `core.seller_listing.is_current_listing` separates current Amazon records from deleted historical SKUs. Catalog KPIs and families use current records only; Catalog Items owns current parent-child relationships. Deleted SKUs remain available only through explicit historical/deleted views and transaction attribution, labeled `Deleted` rather than `Inactive`.

Use `/admin` for seller-owned short names, taxonomy and current unit COGS. `board/admin_config.py` owns validation, optimistic revisions, unknown-field preservation, atomic replacement, backups and audit metadata; `board/admin_auth.py` owns the host-password session and CSRF contract. `board/server_canonical.py` is the only HTTP route owner. Do not add a second browser-only write path or edit the host JSON as the normal operating workflow.

The Admin browser keeps unsaved drafts keyed by SKU when another editor advances the optimistic revision. On HTTP 409 it reloads the latest catalog once, reapplies the local draft for review, announces the conflict as an alert and never retries the write automatically. Edits made after a save request starts are also retained as a newer unsaved draft when that request completes. Sign-out intentionally discards local drafts. These are presentation safeguards around the existing authenticated, CSRF-protected `expected_revision` contract; they do not change the server write contract.

New SKUs and deletions require no code list. The latest completed Seller Listings snapshot adds every current sellable offer to Admin and moves absent records to read-only deleted history. Catalog Items supplies identity/parent-child evidence after Amazon propagation. A new SKU with blank COGS is expected seller configuration, not an ingestion/software defect. Blank seller taxonomy is likewise a mapping task when source evidence is ready; unresolved Amazon source evidence beyond the documented grace is the separate source-completeness incident.

### Inventory

Inventory combines FBA inventory state with seller-SKU velocity from Amazon Orders. `inventory_api.py` joins the current Amazon offer contract for portfolio rollups and owns reference-row lifecycle plus canonical-SKU identity. The browser defaults to current stock-bearing offers and only exposes alias, retired, archived or no-velocity rows through explicit filters. Action semantics such as `STOCKOUT`, `PRODUCE`, `PLAN`, `OK` and `HOLD` belong in the data/API layer. The browser renders those actions; it should not independently invent replenishment thresholds. This order-based velocity is intentionally distinct from reconciled CHILD-ASIN product demand on Sales, Catalog and Product Workspace.

Inventory owns one native evidence table for every viewport. On phones, that table stays inside a labeled,
horizontally scrollable evidence region so records remain compact without repeating every column heading per row.
Do not add a second mobile renderer or omit lifecycle, canonical identity, stock-state, velocity, or status fields.
`inventory.js` distinguishes only composition: zero API-owned exceptions collapse the action queue to a healthy
confirmation with a closed, reachable coverage disclosure; one or more exceptions keep action cards first and
open the same coverage disclosure. The browser does not recalculate the API-owned action state.
`inventory_api.py` may combine that completed inventory action with the canonical Ads product projection. Only
current offers with active paid support and reconciled, sufficiently mature evidence can enter the bounded
paid-support exposure list. The resulting `ADS_INVENTORY_EXPOSURE_REVIEW` asks for a fulfillment-readiness review;
it never instructs the seller to pause, reduce, bid or scale.
Catalog family mode remains a hierarchical disclosure, while its flat dimension, combination, SKU, and deleted
views expose explicit table, row-group, row-header, column-header, and cell relationships.

### Ads

Ads reports Amazon-attributed performance plus an independent total-seller-sales denominator for TACOS. Never compute “organic sales” as total seller sales minus Amazon-attributed ad sales; attribution windows overlap and can restate.

Brand Analytics Search Query Performance, Search Catalog Performance, Amazon Search Terms, Market Basket, and Repeat Purchase use the existing SP-API Reports authorization, not Amazon Ads credentials. The worker requests Search Query for canonical current sellable ASINs at two independent grains—exact completed Sunday–Saturday weeks and completed calendar months—Search Catalog at the exact ASIN/week grain, Search Terms at the exact market-query/clicked-ASIN/week grain, Market Basket at the exact seller-catalog-ASIN/co-purchased-ASIN/week grain, and Repeat Purchase at the exact seller-catalog-ASIN/week grain. Missing weekly Search Query history is collected first, followed by missing Search Catalog, Search Terms, Market Basket, and Repeat Purchase histories, then monthly Search Query history; weekly and monthly rows are never added together. One complete source-period is committed per run, newest missing period first. ASIN options are space-separated and chunked under Amazon's 200-character limit; Search Query uses Amazon's singular `asin` option, Search Catalog uses its plural `asins` option, and market-level Search Terms, Market Basket, and Repeat Purchase use no ASIN filter. A successful first run proves the application has the Brand Analytics role for that source; a 403 or fatal report remains an explicit source-specific Data Health failure rather than being translated into “no data.”

The collector backfills exact Sunday-Saturday Search Query Performance, Search Catalog Performance, market-level Amazon Search Terms, Market Basket, and Repeat Purchase weeks to their configured business-history boundaries, plus up to 17 completed Search Query Performance months. It chains successful missing periods immediately in one serialized background worker so core ingestion cadence is not blocked and Amazon report jobs do not overlap. Once all histories are complete it refreshes on the daily schedule. `BRAND_ANALYTICS_SEARCH_QUERY_WEEKLY_BACKFILL_START`, `BRAND_ANALYTICS_SEARCH_CATALOG_WEEKLY_BACKFILL_START`, `BRAND_ANALYTICS_SEARCH_TERMS_WEEKLY_BACKFILL_START`, `BRAND_ANALYTICS_MARKET_BASKET_WEEKLY_BACKFILL_START`, `BRAND_ANALYTICS_REPEAT_PURCHASE_WEEKLY_BACKFILL_START`, `BRAND_ANALYTICS_SEARCH_QUERY_BACKFILL_MONTHS` (1–17), and `BRAND_ANALYTICS_SEARCH_QUERY_INTERVAL_SECONDS` own those bounds. Brand Analytics report creation can remain queued longer than lightweight seller reports, so `BRAND_ANALYTICS_SEARCH_QUERY_POLL_TIMEOUT_SECONDS` owns a separate one-hour default instead of inheriting the generic five-minute Reports API timeout. Each successful period transactionally replaces its exact canonical slice, stores the raw report in `raw.api_payload`, and marks that exact source-period cursor only after canonical persistence succeeds. Data Health and manual sync expose independent `search_query_performance_weekly`, `search_catalog_performance_weekly`, `search_terms_weekly`, `market_basket_weekly`, `repeat_purchase_weekly`, and `search_query_performance` job names. Search Catalog `search_traffic_sales` is inclusive search-funnel evidence; it is never labeled organic sales or incremental advertising sales. Amazon Search Terms click and conversion shares are market-demand context, not advertising attribution or incrementality; clicked ASINs remain competitor context unless canonical current-offer evidence identifies them as owned. Market Basket affinity is retained for future merchandising and Advisory use; it does not enter an Advertising recommendation and its co-purchased ASIN is not presumed to be seller-owned. Repeat Purchase revenue is Amazon ordered revenue from repeat customers with returns excluded and tax basis unspecified; it is future portfolio/LTV context, not reconciled seller revenue, contribution, advertising attribution, or incrementality.

Amazon Ads connection lifecycle is separate from reporting quality. The worker publishes one non-secret state in `ops.integration_state`: `NOT_CONNECTED`, `AUTHORIZATION_PENDING`, `BACKFILL_RUNNING`, `READY`, or `FAILED`. `board/ads_state.py` owns the matching badge, headline and detail contract consumed by both Product and Ads APIs. Page runtimes render that contract and must not infer authorization or backfill state from missing report rows. Once the initial history has completed, the worker keeps the connection in `READY` while a current window is running or when its latest refresh fails; the detail code distinguishes `REPORT_REFRESH_RUNNING` and `REPORT_REFRESH_FAILED`. Data Health remains the owner of the failed-attempt diagnostic. A failed incremental refresh does not invalidate an already complete and reconciled reporting window.

The Advertising document loads only its shell, page styles and lightweight runtime before the connection payload is
known. `ads.js` calls `ads-chart-loader.js` only for the API-owned `READY` connection plus `ready` reporting
status; that loader then requests shared chart CSS, D3 and `chart-system.js` with the current asset revision.
An established `READY` connection may carry a refreshing or degraded detail code: all reporting views remain
available from the stored healthy window and the page presents the API-owned refresh notice. Disconnected,
authorization-pending, initial-backfill and no-data states render without downloading or parsing chart dependencies
they cannot use.

Only Overview remains enabled before that ready state; Products, Demand and Campaigns are disabled with an adjacent API-derived explanation. Once ready, Overview leads with ad spend per $100 of independently reconciled seller sales, ranks every comparable SKU by that cost load, and limits the default queue to server-owned product decisions. Demand counts link to the dedicated investigation view. Products keeps seven primary business/action columns and moves traffic, attributed efficiency and maturity into a row disclosure. Campaigns, targets, terms and IDs remain supporting evidence.

`board/ads_decisions.py` owns Advertising's named, versioned and maturity-aware product/demand interpretations, stable action identifiers, action-lane allocation, product associations and demand pagination. It also owns the latest-month Brand Analytics Search opportunities rules, confidence bands and 25% to 50% gap-closure scenario arithmetic. `ads_api.py` supplies the integrated seller-sales, traffic, conversion, Amazon-attributed performance and TACOS operands, plus a bounded Search opportunities queue joined only to canonical current offer owners. Same-month Ads search-term matches use the canonical normalized query key and are explicitly query-level, not ASIN attribution. The browser may filter and format the returned product set, but it must not invent thresholds, profitability, scaling or bid instructions. Demand is filtered, sorted and paged by the API at 20 rows per page. Changing an Ads or Search Query Performance rule requires exact-boundary server tests plus production browser verification of its rule key, version, eligibility, scenario qualification and destination.

`board/ads_context.py` owns the reusable cross-route projection. Today shows it only on the live operating day and
labels it as the latest completed Ads window. Business exposes the primary product review beside overall business
impact. Sales aligns seller sales, spend, attributed performance and TACOS and adds product-level paid-support
context to Drivers. Product Workspace renders the current SKU funnel and review steps. Inventory renders only the
bounded server-qualified exposure list. Finance remains the sole accounting owner of advertising expense and Data
Health remains the pipeline-quality owner; neither route imports operating recommendations.

### Finance

Finance intentionally separates three concepts:

1. Amazon-side accounting closure.
2. Seller COGS completeness/readiness.
3. Immutable management close.

The current month is OPEN and provisional. Closed management months come from immutable Finance close snapshots; later edits to standard product cost must not silently rewrite closed history. A correction to a closed period is an explicit restatement/version.

Cash transferred by Amazon is not the same as economic contribution. Keep cash timing and contribution reporting separate.

Finance presentation uses the shared semantic profile and data-palette tokens in all six appearances. Responsive month-history cards retain the native caption, column headers and row-header relationships for assistive technology; CSS may change the visual layout but not the table semantics or immutable-close evidence.

`board/finance_settlement.py` owns the latest-settlement display contract used by the canonical Finance adapter. It preserves settlement/report identifiers and exposes `KNOWN`, `PARTIAL`, or `UNKNOWN` date availability with explicit fragments for missing start, end, or deposit dates. The browser renders these API fragments and must not substitute punctuation placeholders for absent dates.

## Production-owned local configuration

Production secrets and mutable business configuration live on the host, not in Git.

- `/etc/dpp-analytics/env` — database credentials, Amazon credentials/toggles, schedules and other environment settings. Never commit it.
- `/etc/dpp-analytics/board-config/product_labels.json` — local product display-name/image overrides. The deploy workflow seeds this from `board/product_labels.json` only when the host file does not already exist, so normal Git pulls do not overwrite local mappings.
- `/etc/dpp-analytics/board-config/product_costs.json` — production product COGS configuration, mounted read-only into the worker and read-write into the board as `/config/product_costs.json`.
- `/etc/dpp-analytics/board-config/product_variations.json` — production variation configuration, mounted into the board through `/config`.
- `/etc/dpp-analytics/board-config/backups/` and `admin-audit.jsonl` — recoverable pre-save JSON versions and non-secret Admin change metadata.

`DPP_ADMIN_PASSWORD` is generated into `/etc/dpp-analytics/env` when absent and is never printed by deployment, returned by an API or embedded in an asset. Retrieve or rotate it only on the host. Production currently forces `DPP_ADMIN_ALLOW_REMOTE=true` and `DPP_ADMIN_COOKIE_SECURE=false`, exposing the password-protected Admin at `http://95.217.100.5:8088/admin` under the explicit temporary decision in [#204](https://github.com/PacoCotera/dpp-analytics/issues/204). Because this is direct HTTP, the password and session cookie have no transport encryption; rate limiting, HttpOnly/SameSite cookies, CSRF, session expiry and audit controls remain active but do not remove that network risk. Revert the remote toggle when SSH and app-wide authentication replace this temporary path. A password shorter than 16 characters or the committed placeholder disables Admin.

To retrieve the generated password as an authorized host operator:

```bash
sudo sed -n 's/^DPP_ADMIN_PASSWORD=//p' /etc/dpp-analytics/env
```

Repository JSON files are defaults/seeds unless the deployment workflow explicitly says otherwise. When changing host-owned config behavior, update this section and `compose.yml`/deployment automation together.

## Common change recipes

### Change a page layout or copy

1. Start with that page's HTML/CSS from the ownership table.
2. Use `layout-system.css` primitives before inventing new geometry.
3. Keep API/business semantics unchanged unless the request explicitly calls for a data-definition change.
4. Run frontend lint.
5. After deploy, inspect the affected desktop and mobile browser-QA captures.

### Change a KPI or business definition

1. Identify the owning API payload or `mart` view first.
2. Change the server/SQL definition once.
3. Keep the browser as a renderer of that definition.
4. Add or adjust migration/QA coverage when the stored model changes.
5. Update `docs/data-model.md` if the source of truth or reconciliation rule changes.
6. For a rolling metric, update or reuse the named `board/metric_windows.py` contract and cross-page QA; do not duplicate its source/cutoff metadata in a page API.

### Add a new board workspace

1. Add a Python payload owner under `board/`.
2. Register API and page routing in the canonical/legacy board server boundary as appropriate.
3. Add one HTML composition file, one page stylesheet and one runtime module under `board/static/`.
4. Add the route to `ui-shell.js` only if it belongs in application navigation.
5. Reuse shared layout/chart/utilities explicitly.
6. Add production browser-QA coverage in `qa/`.
7. Update the workspace table here and the root README in the same PR.

### Add or change an ingestion source

1. Start in `app/dpp_analytics/`.
2. Put durable schema changes in `sql/migrations/`; do not hand-edit production schema.
3. Make source health visible through `ops`/Data Health where appropriate.
4. Update `docs/data-model.md` with the new source's authority, cadence and provisional/final semantics.
5. Keep customer PII out unless a future product requirement explicitly changes the policy and is reviewed separately.

### Change shared navigation or mobile swipe behavior

Start in `board/static/ui-shell.js` and `nav-shell.css`. Do not patch individual pages around the shell.

### Change a reusable chart

Start in `chart-system.js`/`chart-system.css`. Page runtimes should provide data and choose the chart, not fork a generic chart implementation unless the analytical form is truly page-specific.
For Trajectory weekly-axis changes, run `npm run test:trajectory-ticks` in `board/` and the dedicated rendered-label
browser gate; both endpoint retention and collision-free labels are release requirements.

### Change shared number or date copy

Start in `static/format-core.js`; `ui-utils.js` re-exports its browser-safe helpers. Run `npm run test:formats` for
the zero/singular/plural, currency-sign, precision, and month-year contract before changing page copy.

## Quality gates

### Application PR gate

`.github/workflows/frontend-quality.yml` is intentionally broader than its historical filename. The workflow is named **Application quality** and has six independent jobs:

- `frontend-lint` — frontend ownership contract, ESLint, Stylelint and Prettier through `npm run quality` in `board/`;
- `board-python` — compiles board Python and runs response-cache unit tests;
- `board-image` — builds the actual production board Dockerfile and runs its image import smoke test, catching missing `COPY` dependencies;
- `qa-syntax` — syntax-checks the production browser QA scripts, including Sales Geography;
- `compose-config` — `docker compose --env-file .env.example config --quiet` to catch invalid Compose/interpolation changes;
- `migration-chain` — starts a clean PostgreSQL 18 database and applies the complete migration chain.

For local frontend work:

```bash
cd board
npm install --no-package-lock --ignore-scripts
npm run quality
```

When changing `compose.yml` or `.env.example`, validate them together. The template is meant to be executable input to `docker compose config`, not prose that can drift away from the service definition.

### Production deployment gate

`.github/workflows/deploy.yml` runs on pushes to `main` and via `workflow_dispatch`. It:

1. validates Compose and the host;
2. builds worker/board images;
3. ensures PostgreSQL is healthy;
4. applies SQL migrations;
5. refreshes historical product-cost/Finance close state;
6. deploys the stack;
7. probes worker, SP-API authorization, Grafana and core board endpoints;
8. builds/runs browser QA against the deployed board;
9. uploads QA artifacts;
10. updates the deployment heartbeat.

The self-hosted host has a 38 GB root filesystem. Deployment bounds unused Docker
build cache to 1 GB at startup and again after the application/QA images are complete,
before Playwright writes the 231-capture production matrix. The same bounded
build-cache cleanup runs after every deployment, including failed runs, before the
heartbeat captures host capacity. This cleanup is deliberately limited to
reproducible builder cache: it never invokes `docker system prune`, removes
application images or containers, or touches the PostgreSQL and Grafana named
volumes. Deployment startup also removes only containers carrying the dedicated
`com.dpp-analytics.role=production-browser-qa` label before deleting prior capture
files. This ordering releases files left open when a runner-level kill bypasses the
normal QA `EXIT` trap. After artifact upload and heartbeat publication, the local
capture copy is deleted; GitHub artifacts remain the evidence owner.

Production browser QA records page/viewport captures plus browser console errors, failed responses and horizontal-overflow checks. Treat it as a deployment requirement, not decorative screenshots.
`qa/admin_qa.mjs` proves the published Admin entrypoint, unauthenticated API denial, authenticated current/deleted pre-population, a non-mutating save/reload, ordinary Catalog consumption of the persisted values, and logout denial. The QA container uses the host network and published port so it exercises the same remote-access policy as the public route. Deployment passes only the Admin password through a temporary mode-0600 env file and deletes it during cleanup; the password is never written to QA output.
It also intercepts one save with an artificial revision conflict and delays one non-mutating save so the browser must preserve both conflict drafts and edits made while a request is in flight without changing production configuration.
Its Product scenarios cover both a populated demand chart and deterministic all-zero sales/units states. The
zero-demand scenario derives a fixture from a valid live Product response, then replaces only its series values;
it must not depend on a production SKU continuing to have no orders. An all-zero selected metric must render the
explicit range-empty message with no bars or numeric axis ticks.
`qa/ui_format_qa.mjs` verifies the deployed shared count/currency/month-year helpers plus the Business, Finance,
and Data Health labels that depend on them.
The same suite runs `qa/accessibility_qa.mjs` across every primary workspace. It rejects missing/duplicate level-one
headings, unnamed visible links, missing toggle-button state, broken native keyboard activation, and loss of the
Finance monthly report's table relationships.
`qa/visual_qa.mjs` additionally checks the 14px evidence floor, 40px control floor, rendered chart and non-text contrast, mobile Finance/Data Health table semantics, contained Advertising tabs and tables, mobile destination identity, and every primary route in all six presentation profiles at mobile and desktop widths. `qa/ads_surface_qa.mjs` deterministically covers ready and disconnected Advertising states, integrated product evidence, server-owned rules and action destinations, bounded demand pages, neutral campaign comparison and chart-free disconnected loading. Frontend tooling is pinned by `board/package-lock.json`; CI must use `npm ci`.

`qa/ads_cross_route_qa.mjs` compares the Today, Business and Sales Ads business signatures, verifies exact
server-owned drill-down destinations and Back restoration, checks the Product funnel/action contract and
Inventory exposure eligibility, and enforces bounded mobile lists plus document containment.
`qa/analysis_state_qa.mjs` exercises Sales and Catalog direct links, refresh, Back, and Forward. When adding a
persistent view choice, document its URL key in `frontend-architecture.md` and extend this browser gate.
`qa/presentation_profiles_qa.mjs` checks the six-profile registry and apply/persistence contract on the Business
reference workspace without multiplying every route by every appearance.

After each deployed UI-revamp block, use the standalone, parameterized DPP Playwright runner for acceptance. Do
not substitute the repository's predefined CI Playwright matrix. Run Chromium desktop, Chromium mobile, WebKit
desktop and WebKit mobile at the exact dimensions required by the change; include Firefox desktop when engine
comparison is relevant. Each run must record the exact deployed SHA and active asset revision from page metadata,
then verify the same values in the Build info disclosure before navigation and visual evidence are accepted. The repository QA/deployment suite remains an independent
regression gate. The capability table, session matrix and ChatGPT reconnection procedure are canonical in
[`browser-qa.md`](browser-qa.md).

### Finance validation

`.github/workflows/finance-smoke.yml` runs after a successful deployment (and manually) and probes the deployed Finance API, accounting state, product-cost coverage and frozen COGS snapshots. `.github/workflows/finance-cost-audit.yml` is the additional Finance cost audit workflow.

## Production control plane

The deployment heartbeat is GitHub issue **#1** and is updated automatically by the deploy workflow. It includes deployed SHA, host/container health, migrations, worker/board/Grafana state and browser-QA summary without credentials.

Finance smoke diagnostics are published to GitHub issue **#10**.

For a normal code deployment, prefer the GitHub workflow over manual production commands. A successful workflow plus successful production browser QA is the authoritative deployment result.

## Rollback mindset

- Frontend/API regression with no schema change: revert the offending commit on `main` and let the normal deployment workflow redeploy.
- Schema/data-model change: migrations are forward-moving production history. Do not assume a Git revert reverses database state; use an explicit corrective migration.
- Host-owned configuration: preserve the current host file before making a risky edit and validate JSON/config syntax before restarting services.

## Known intentional debt

These are not reasons to recreate the old layering model:

- `sales-canonical.js` retains a historical filename although it is the live Overview/Drivers renderer.
- `sales-geography.js` remains a compatibility entrypoint for the current v2/fixes map renderer; consolidate that split separately rather than layering another geography runtime.
- Finance has historical `finance_api.py` / `finance_safe.py` filenames while production currently packages `finance_emergency.py` as `finance_api.py`; normalize separately with Finance smoke coverage.

When one of these debts is removed, delete its note here in the same PR.
