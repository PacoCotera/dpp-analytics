# DPP Analytics documentation

This directory is the maintainer-facing map of the application. The goal is to make architecture and ownership discoverable without reading the codebase first.

## Start with the question you are trying to answer

| Question | Document |
| --- | --- |
| What is this repo and where does each major subsystem live? | [`../README.md`](../README.md) |
| I need to change or debug a page. Where do I start? | [`maintenance.md`](maintenance.md) |
| Which frontend layer owns navigation, layout, charts or page-specific behavior? | [`frontend-architecture.md`](frontend-architecture.md) |
| What is the approved 2026 UI revamp direction and delivery plan? | [`ui-revamp-2026-08-28.md`](ui-revamp-2026-08-28.md) and [tracker #206](https://github.com/PacoCotera/dpp-analytics/issues/206) |
| How are repeated API queries cached, how fresh may a page be, and where should KPI precomputation live? | [`reporting-cache-architecture.md`](reporting-cache-architecture.md) |
| Which source is authoritative for Today, Sales, Finance, Ads, Catalog or Inventory? | [`data-model.md`](data-model.md) |
| What exactly does a money number mean: shopper spend, Amazon sales, Finance net sales, payout or Ads attribution? | [`metric-basis.md`](metric-basis.md) |
| Which confirmed production defects are queued, and how are they closed? | [`audits/dpp-analytics-2026-08-27.md`](audits/dpp-analytics-2026-08-27.md) and [tracker #161](https://github.com/PacoCotera/dpp-analytics/issues/161) |
| How are new/deleted SKUs and seller mappings/COGS managed? | [`audits/catalog-admin-2026-08-28.md`](audits/catalog-admin-2026-08-28.md) and [`maintenance.md`](maintenance.md) |
| How does production deploy and where do I inspect its health? | [`control-plane.md`](control-plane.md) |

## Documentation contract

Documentation is part of the application architecture. Update it in the same PR when any of these change:

- a served route or API endpoint;
- the owning Python, HTML, CSS or JavaScript file for a workspace;
- a source-of-truth or reconciliation rule;
- a monetary basis, tax treatment or sales fallback;
- a Finance close/accounting rule;
- an ingestion source or schedule;
- shared frontend ownership or framework choice;
- caching, freshness or KPI-precomputation behavior;
- deployment, migration, QA or production-health behavior;
- host-side configuration paths that a maintainer must know.

Do not use documentation as a second implementation. Keep it focused on boundaries, invariants, ownership and operational procedures. Detailed SQL and payload fields belong in code/migrations unless a maintainer needs them to make a correct architectural decision.

## Current architectural invariants

- PostgreSQL is the system of record.
- The worker ingests/reconciles data; the board reads and presents it.
- Today/order evidence uses gross shopper spend from Orders; settlement/proceeds values are not operating-sales fallbacks.
- Historical sales use reconciled Data Kiosk-backed Sales & Traffic data.
- Finance separates net sales ex IVA, IVA, gross customer spend, Amazon-side closure, seller COGS readiness and immutable management close.
- Ads-attributed sales are attribution, not incrementality; TACOS uses independently reconciled seller sales.
- The browser does not redefine accounting, attribution or inventory-action semantics.
- Cache layers may reuse canonical payloads but never redefine business truth.
- Each frontend workspace has one clear composition/style/runtime owner.
- Shared navigation, layout, charts and utilities are centralized.
- Docker does not inject frontend behavior.
- `main` is the production branch; deployment and production browser QA are automated through GitHub Actions.
