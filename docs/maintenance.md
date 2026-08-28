# DPP Analytics maintenance guide

Use this document as the first stop when changing or debugging the application. It maps the runtime to the files that own it and records the invariants that are easy to break if you infer behavior from filenames alone.

## Runtime at a glance

`compose.yml` defines four production services:

- `postgres` — PostgreSQL 18, canonical data store.
- `worker` — Python ingestion/reconciliation worker built from `app/`.
- `board` — Python operating-board server built from `board/`, exposed on host port `8088`.
- `grafana` — supporting dashboards, exposed on host port `3000`.

The board is server-rendered only in the sense that Python serves static HTML and JSON APIs. Page behavior runs in source-controlled browser JavaScript. Docker does **not** inject frontend behavior; it only stamps the deployed commit into page footers.

## Workspace ownership map

| Route | API / business owner | HTML | CSS | Browser runtime |
| --- | --- | --- | --- | --- |
| `/today` | `board/today_api.py` | `board/static/today.html` | `today.css` | `today.js` + tiny synchronous `today-bootstrap.js` for wall mode |
| `/`, `/home`, `/index.html` | `board/home_api.py`; shared decision health: `board/health_contract.py` | `home.html` | `home.css` | `home.js` |
| `/sales` | canonical Sales adapter over `board/sales_api.py`; lazy Geography: `board/sales_geography_api.py` | `sales.html` | `sales.css` + `sales-geography.css` | `sales-canonical.js` + lazy `sales-geography.js` / `sales-geography-v2.js` |
| `/catalog` | `board/catalog_api.py` | `catalog.html` | `catalog.css` | `catalog.js` |
| `/product?sku=...` | `board/product_api.py` | `product.html` | `product.css` | `product.js` |
| `/inventory` | `board/inventory_api.py` | `inventory.html` | `inventory.css` | `inventory.js` |
| `/ads` | `board/ads_api.py` | `ads.html` | `ads.css` | `ads.js` |
| `/finance` | runtime module imported as `finance_api` by `board/server.py` | `finance.html` | `finance.css` | `finance.js` |
| `/trajectory` | `board/trajectory_api.py` | `trajectory.html` | `trajectory.css` | `trajectory.js` |
| `/data-health` | `board/health_api.py`; shared decision health: `board/health_contract.py` | `data_health.html` | `data-health.css` | `data-health.js` |

### Two filename traps

1. **Sales:** `sales-canonical.js` is the live Sales Overview/Drivers renderer. “canonical” is historical naming, not a second implementation. Geography is intentionally a separate lazy runtime and payload because its postal history is optional heavy detail, not part of the default Sales snapshot.
2. **Finance:** the current `board/Dockerfile` copies `board/finance_emergency.py` into the image as `/app/finance_api_legacy.py`, then copies `board/finance_api_corrected.py` as `/app/finance_api.py`. The adapter is the production entry point; the legacy module still owns period state and immutable-close aggregation. `board/finance_api.py` and `board/finance_safe.py` are not the packaged runtime. Do not infer Finance ownership from repository filenames alone. Normalize this naming only as a deliberate behavior-neutral cleanup with Finance smoke validation.

## Shared frontend ownership

Before adding page-specific code, check whether the behavior belongs in one of these shared layers:

| File | Owns |
| --- | --- |
| `theme.css` | global tokens, typography and base visual language |
| `nav-shell.css` | application navigation presentation |
| `ui-shell.js` | primary navigation, active route, More menu, workspace identity, tab keyboard behavior and mobile swipe behavior |
| `layout-system.css` | reusable page headers, KPI rails, panels, grids, segmented controls, tables and status strips |
| `chart-system.css` / `chart-system.js` | reusable chart grammar, axes, tooltips, legends, period treatment and shared chart forms |
| `data-cache.js` | session-scoped GET JSON cache, browser in-flight dedupe and endpoint freshness policy |
| `ui-utils.js` | escaping, number/money formatting, DOM helpers, shared interpretation-rule disclosure and JSON-fetch facade used by ES-module pages |
| `mobile-ux.css` | shared mobile compatibility behavior retained from earlier iterations |
| `design-refine.css` | retained global design refinements; treat as legacy/shared foundation, not a place for new page-specific overrides |
| `vendor/d3.v7.min.js` | vendored D3 runtime |

A page should not add a second nav, duplicate generic panel geometry, inject CSS from JavaScript, or create a post-render “enhancer” layer.

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

The default `/api/sales` payload deliberately excludes postal geography. `/api/sales/geography` reads the existing reduced Orders geography marts only when the user opens Geography, then `sales_geography_api.py` resolves every postal row to its canonical SEPOMEX federal-entity key before aggregation. Raw destination-state labels must not be aggregated or normalized in browser JavaScript. The split is a transport/performance boundary, not a new sales fact or privacy policy.

### Catalog and Product Workspace

Catalog identity is assembled server-side from seller listings, catalog data, configured variation relationships and local display overrides. Use the Reports API merchant-listings path for seller inventory/listing breadth rather than looping Catalog Items to discover the seller's entire catalog.

Treat each completed merchant-listings report as the canonical current snapshot, not as an append-only union. `core.seller_listing.is_current_listing` separates current Amazon records from deleted historical SKUs. Catalog KPIs and families use current records only; Catalog Items owns current parent-child relationships. Deleted SKUs remain available only through explicit historical/deleted views and transaction attribution, labeled `Deleted` rather than `Inactive`.

### Inventory

Inventory combines FBA inventory state with selling velocity. Action semantics such as `STOCKOUT`, `PRODUCE`, `PLAN`, `OK` and `HOLD` belong in the data/API layer. The browser renders those actions; it should not independently invent replenishment thresholds.

### Ads

Ads reports Amazon-attributed performance plus an independent total-seller-sales denominator for TACOS. Never compute “organic sales” as total seller sales minus Amazon-attributed ad sales; attribution windows overlap and can restate.

### Finance

Finance intentionally separates three concepts:

1. Amazon-side accounting closure.
2. Seller COGS completeness/readiness.
3. Immutable management close.

The current month is OPEN and provisional. Closed management months come from immutable Finance close snapshots; later edits to standard product cost must not silently rewrite closed history. A correction to a closed period is an explicit restatement/version.

Cash transferred by Amazon is not the same as economic contribution. Keep cash timing and contribution reporting separate.

## Production-owned local configuration

Production secrets and mutable business configuration live on the host, not in Git.

- `/etc/dpp-analytics/env` — database credentials, Amazon credentials/toggles, schedules and other environment settings. Never commit it.
- `/etc/dpp-analytics/product_labels.json` — local product display-name/image overrides. The deploy workflow seeds this from `board/product_labels.json` only when the host file does not already exist, so normal Git pulls do not overwrite local mappings.
- `/etc/dpp-analytics/board-config/product_costs.json` — production product COGS configuration, mounted read-only into worker/board as `/config/product_costs.json`.
- `/etc/dpp-analytics/board-config/product_variations.json` — production variation configuration, mounted into the board through `/config`.

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

Production browser QA records page/viewport captures plus browser console errors, failed responses and horizontal-overflow checks. Treat it as a deployment requirement, not decorative screenshots.

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
- `mobile-ux.css` and `design-refine.css` remain shared global styles. Gradually move genuinely page-specific rules out when those files are touched, but do not create replacement override sheets.

When one of these debts is removed, delete its note here in the same PR.
