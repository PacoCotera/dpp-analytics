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
| `/today` | Live operating pulse and recent order evidence | `board/today_api.py` |
| `/` / `/home` | Business state and priority decisions | `board/server.py` (`home_payload`) |
| `/sales` | Revenue, momentum, run rate, products and orders | `board/sales_api.py` |
| `/catalog` | Portfolio, family/variation analysis and commercial health | `board/catalog_api.py` |
| `/product?sku=...` | Single-product workspace | `board/product_api.py` |
| `/inventory` | Stock, cover and production/replenishment actions | `board/inventory_api.py` |
| `/ads` | Paid demand, efficiency, campaigns, targets and search terms | `board/ads_api.py` |
| `/finance` | Current economics, immutable closes and accounting evidence | production Finance implementation described in `docs/maintenance.md` |
| `/trajectory` | Structural momentum across multiple time horizons | `board/trajectory_api.py` |
| `/data-health` | Source freshness, coverage and trust | `board/health_api.py` |

The frontend intentionally uses native HTML, CSS Grid/Flexbox and ES modules rather than a framework. See `docs/frontend-architecture.md` before introducing a new frontend dependency or ownership layer.

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
2. Intraday Today data is provisional. Reconciled historical sales and trajectory use Data Kiosk-backed daily data.
3. Cash movement and economic contribution are separate concepts.
4. Closed Finance months are immutable snapshots. Corrections require an explicit restatement, never a silent rewrite.
5. Amazon Ads attributed sales are not subtracted from total seller sales to manufacture an “organic sales” number.
6. Customer PII is not intentionally collected or exposed in the operating board.
7. Secrets and production tokens never live in Git.
8. A frontend workspace has one semantic HTML owner, one page stylesheet and one page runtime. Docker does not inject page behavior.

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

**Do not call a change production-ready merely because lint passes.** Production browser QA and a visual sanity check of the affected decision surfaces are part of acceptance.

## Documentation

Start here instead of reverse-engineering the repository:

- [`docs/README.md`](docs/README.md) — documentation index and which document answers which question.
- [`docs/maintenance.md`](docs/maintenance.md) — maintainer map, page/API ownership, change recipes, production QA and operational traps.
- [`docs/frontend-architecture.md`](docs/frontend-architecture.md) — frontend ownership, layout/chart systems and framework decision gate.
- [`docs/data-model.md`](docs/data-model.md) — source-of-truth layers, current Amazon sources and KPI/reconciliation policy.
- [`docs/control-plane.md`](docs/control-plane.md) — deployment workflow, self-hosted runner and production heartbeat.

When architecture, source ownership, a route, a data definition or deployment behavior changes, update the corresponding documentation in the same PR.