# DPP Analytics

Self-hosted operating analytics application for Dirty Pawz Press, currently centered on the Amazon Mexico business.

The repository contains the production data ingestion worker, PostgreSQL model, operating board, Grafana support dashboards, deployment automation and browser QA. **PostgreSQL is the system of record.** The operating board is the primary decision interface.

## Production stack

| Service | Purpose | Runtime |
| --- | --- | --- |
| `postgres` | Canonical raw/core/mart/ops data store | PostgreSQL 18 |
| `worker` | Amazon ingestion, reconciliation and finance-close jobs | Python package in `app/dpp_analytics/` |
| `board` | Operating board HTML/API application | Python server + source-controlled HTML/CSS/JS, port `8088` |
| `grafana` | Supporting/legacy dashboards and operational inspection | Grafana, port `3000` |

The stack is defined in `compose.yml`. Production configuration and secrets live on the host, not in Git.

## Operating board

| Route | Decision surface | Backend owner |
| --- | --- | --- |
| `/` (`/today` alias) | Live operating pulse and recent orders | canonical Today adapter over `board/today_api.py` |
| `/business` (`/home` alias) | Business state and priority decisions | `board/server.py` (`home_payload`) |
| `/sales` | Revenue, momentum, run rate, products and orders | canonical Sales adapter over `board/sales_api.py` |
| `/catalog` | Portfolio, family/variation analysis and commercial health | `board/catalog_api.py` |
| `/product?sku=...` | Single-product workspace | canonical Product adapter over `board/product_api.py` |
| `/inventory` | Stock, cover and production/replenishment actions | `board/inventory_api.py` |
| `/ads` | Paid demand, efficiency, campaigns, targets and search terms | `board/ads_api.py` |
| `/finance` | Current economics, immutable closes and accounting detail | production Finance implementation described in `docs/maintenance.md` |
| `/trajectory` | Structural momentum across multiple time horizons | `board/trajectory_api.py` |
| `/data-health` | Source freshness, coverage and trust | `board/health_api.py` |

The frontend intentionally uses native HTML, CSS Grid/Flexbox and ES modules rather than a framework. See `docs/frontend-architecture.md` before introducing a new frontend dependency or ownership layer.

## Monetary basis

**A money value is not fully defined until its basis is known.** DPP Analytics deliberately separates shopper spend, net seller revenue, Finance accounting values, settlement cash and Ads attribution.

- **Today and individual order evidence:** `GROSS_CUSTOMER_SPEND`, the shopper-facing product amount **including IVA**. Live Amazon order rows are normalized to one tax-inclusive basis before aggregation.
- **Historical Sales / Home / Catalog / Product / Trajectory:** reconciled Amazon Sales & Traffic `orderedProductSales`. Production reconciliation proves that, for DPP Mexico, this is also **shopper spend including IVA**. On 25 matched production days the report totaled MX$16,385.49 versus MX$16,396.39 normalized Orders gross and MX$14,134.82 Orders ex IVA. Operating pages therefore stay on one gross commercial basis.
- **Finance:** derives **Net sales ex IVA** from the gross Sales & Traffic amount, then shows **IVA withheld** and **Gross customer spend** side by side. Historical CLOSED/RESTATED months come from immutable close snapshots.
- **Amazon payout:** a separate settlement-grain cash identity. The Finance bridge starts with signed customer activity inside one settlement, subtracts IVA withheld and all other signed deductions (including settlement-charged advertising where present), adds reimbursements/other additions, and must reconcile to Amazon's settlement report total within MX$0.02. It is cash timing, never revenue or contribution.
- **Ads:** attributed sales are Amazon attribution, not incremental sales. TACOS uses independently reconciled seller sales.

### Where to look

| Question | Surface | Basis |
| --- | --- | --- |
| What did shoppers pay today? | Today; Sales → Orders | Shopper spend incl. IVA |
| What is the commercial sales trend? | Sales, Home, Catalog, Product, Trajectory | Shopper spend incl. IVA |
| What is accounting revenue excluding IVA? | Finance | Net sales ex IVA |
| What were gross shopper spend, IVA and ex-IVA revenue for an accounting month? | Finance | All three shown explicitly |
| What cash did Amazon actually transfer? | Finance → latest Amazon settlement | Reconciled payout cash, not revenue |

The canonical definitions, source ownership and presentation rules are in [`docs/metric-basis.md`](docs/metric-basis.md). Any code that changes a monetary source or fallback must update that document in the same change.

## Repository map

- `app/` — ingestion worker and Amazon clients/jobs.
- `board/` — operating-board server, API payload builders, local business configuration seeds and frontend.
- `board/static/` — canonical page HTML/CSS/JS plus shared shell/layout/chart utilities.
- `sql/init/` — initial database bootstrap.
- `sql/migrations/` — ordered production schema/model migrations.
- `scripts/` — migration and operational helper scripts.
- `qa/` — Playwright/browser production QA and catalog semantic checks.
- `grafana/` — provisioned Grafana dashboards/configuration.
- `ops/` — host/operational support artifacts.
- `.github/workflows/` — deployment, frontend quality and finance validation workflows.
- `docs/` — architecture, data truth and maintenance documentation.

## Non-negotiable data rules

1. PostgreSQL owns business truth; browser code should render, not redefine accounting or reconciliation rules.
2. Intraday Today data is provisional and uses gross shopper spend from Orders. Reconciled historical commercial sales and trajectory use the same gross-including-IVA basis from Sales & Traffic.
3. Finance is the accounting translation layer: gross shopper spend → IVA withheld → net sales ex IVA. Do not relabel operating gross sales as net revenue.
4. Settlement/proceeds amounts are accounting evidence and must never silently substitute for shopper-facing operating sales.
5. Cash movement and economic contribution are separate concepts. A displayed payout bridge is trusted only when its raw signed settlement lines reconcile to Amazon's settlement report total.
6. Closed Finance months are immutable snapshots. Corrections require an explicit restatement, never a silent rewrite.
7. Amazon Ads attributed sales are not subtracted from total seller sales to manufacture an “organic sales” number.
8. Customer PII is not intentionally collected or exposed in the operating board.
9. Secrets and production tokens never live in Git.
10. A frontend workspace has one semantic HTML owner, one page stylesheet and one page runtime. Docker does not inject page behavior.
11. Applied SQL migrations are immutable. Clarifications belong in documentation or a new migration/comment artifact, never by editing an already-applied migration.

## Development and quality

Frontend tooling lives under `board/`:

```bash
cd board
npm install --no-package-lock --ignore-scripts
npm run lint
npm run format:check   # audit; not yet the blocking gate
```

`npm run lint` runs ESLint across application JavaScript and Stylelint across the CSS tree. Vendor assets are excluded.

Production deployment is controlled by `.github/workflows/deploy.yml` and runs on the repository-scoped self-hosted runner. A push to `main` deploys automatically; `workflow_dispatch` is also supported. The deployment applies migrations, refreshes Finance close state, deploys the stack, probes core APIs/services, runs production browser QA and publishes a deployment heartbeat.

There are two independent browser systems. The Playwright code under `qa/` is the automated, predefined CI/deployment regression gate. The separate **DPP Playwright** ChatGPT connection is the interactive standalone service for public-production audits, with persistent handles, Chromium/Firefox/WebKit, native mobile modes and paired exact viewport parameters. Its host has public-internet egress, while its MCP ports remain private behind the OpenAI Secure MCP Tunnel. See [`docs/browser-qa.md`](docs/browser-qa.md) before browser work.

Seller-owned product short names, taxonomy and current COGS are managed through the password-protected `/admin` workspace. The latest complete Seller Listings snapshot supplies current/deleted SKU membership automatically; Amazon Catalog Items supplies identity evidence; the user supplies only the mapped values the application must not guess. Production currently exposes this route through the public direct-HTTP board as the explicit temporary exception in [#204](https://github.com/PacoCotera/dpp-analytics/issues/204); credentials and session cookies do not have transport encryption until HTTPS or the planned SSH/app-wide session replaces it.

**Data-trust acceptance is executable.** Production browser QA verifies rendered monetary values and visible basis labels, including the Finance settlement payout arithmetic. After a successful deployment, `.github/workflows/production-number-audit.yml` independently reconciles production APIs against warehouse/raw evidence, re-proves the Sales & Traffic tax basis, audits immutable Finance closes, and recalculates the latest settlement payout bridge directly from `core.settlement_line`. A monetary-basis or payout-reconciliation failure is a production failure, not a documentation warning.

**Do not call a change production-ready merely because lint passes.** Production browser QA, numeric reconciliation and a visual sanity check of the affected decision surfaces are part of acceptance.

## Documentation

Start here instead of reverse-engineering the repository:

- [`docs/README.md`](docs/README.md) — documentation index and which document answers which question.
- [`docs/maintenance.md`](docs/maintenance.md) — maintainer map, page/API ownership, change recipes, production QA and operational traps.
- [`docs/frontend-architecture.md`](docs/frontend-architecture.md) — frontend ownership, layout/chart systems and framework decision gate.
- [`docs/data-model.md`](docs/data-model.md) — source-of-truth layers, current Amazon sources and KPI/reconciliation policy.
- [`docs/metric-basis.md`](docs/metric-basis.md) — canonical shopper-spend, operating-sales, Finance and Ads monetary definitions.
- [`docs/control-plane.md`](docs/control-plane.md) — deployment workflow, self-hosted runner and production heartbeat.
- [`docs/browser-qa.md`](docs/browser-qa.md) — the two Playwright systems, selection rules, standalone capabilities and ChatGPT refresh/reconnection runbook.

When architecture, source ownership, a route, a data definition or deployment behavior changes, update the corresponding documentation in the same PR.
