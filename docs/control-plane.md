# DPP Analytics control plane

The repository is both the source of truth for application code/schema and the deployment control plane for the self-hosted production host.

## Production branch and runner

- `main` is the production branch.
- `.github/workflows/deploy.yml` runs automatically on pushes to `main`.
- The same workflow supports `workflow_dispatch` for an explicit manual run.
- Deployment runs on the repository-scoped self-hosted Linux/x64 runner labeled `dpp-analytics`.
- Deployments use concurrency group `dpp-analytics-production`; a newer run cancels an in-progress older run.

Prefer the GitHub workflow over manual changes to running containers. The workflow result plus production browser QA is the authoritative deployment outcome.

## What a deployment does

The deploy workflow performs these stages in order:

1. bootstrap/validate the host and Docker tooling;
2. ensure `/etc/dpp-analytics/env` exists and retain production secrets on-host;
3. initialize persistent local product-label configuration if it does not already exist;
4. validate `compose.yml`;
5. pull PostgreSQL/Grafana base images and build worker/board images;
6. start/health-check PostgreSQL;
7. apply repository SQL migrations through `scripts/migrate.sh`;
8. backfill historical product-cost state needed by Finance;
9. refresh Finance month-close state;
10. deploy the complete Compose stack;
11. verify the worker and the configured SP-API authorization mode;
12. verify Grafana;
13. verify board health plus representative Home/Sales/Inventory APIs/pages;
14. build and run the production browser-QA image against the deployed board;
15. upload browser-QA artifacts;
16. publish a machine-readable deployment heartbeat to GitHub.

The board image itself does not inject CSS, JavaScript or page behavior. Its HTML build mutation is limited to stamping the deployed SHA into the footer.

## Production browser QA

`qa/visual_qa.mjs` is run inside the QA image after deployment against `http://127.0.0.1:8088`.

The QA output includes browser captures and a structured summary covering, among other checks:

- successful/failed scenario captures;
- browser console errors;
- failed HTTP responses;
- horizontal overflow at tested viewports.

The full QA output is uploaded as a workflow artifact with 30-day retention. A technically green API health check is not enough if browser QA fails.

Navigation-specific QA also lives under `qa/nav_qa.mjs`; catalog semantic checks are documented in `qa/README-catalog-semantics.md`.

Browser-QA selectors are part of the application contract. They should target canonical page ownership and stable semantic DOM markers, not deleted enhancement layers or incidental legacy class names. When a frontend refactor intentionally changes the canonical DOM, update the corresponding QA selector in the same PR. When deleting a frontend runtime/style file, remove every source dependency on it before deleting the file; production 404s for removed assets are deployment failures.

## Deployment heartbeat

GitHub issue **#1** is the production deployment heartbeat. The workflow updates the same issue after every attempt so it can be inspected without SSH access.

It records:

- workflow outcome;
- deployed commit and run ID;
- hostname/timestamp;
- Docker/Compose versions;
- container state;
- applied database migrations;
- worker health/log tail;
- PostgreSQL health;
- Grafana health;
- operating-board health/KPI probes;
- SP-API enablement/environment/probe result;
- disk and memory summary;
- production browser-QA summary.

No credentials, tokens, environment-file contents or other secrets belong in the heartbeat.

## Finance operational validation

Both Finance validations run only after a successful `Deploy DPP Analytics` workflow, or when explicitly dispatched manually. This keeps deployment on the critical path and validates the Finance API that is actually live.

`.github/workflows/finance-smoke.yml` probes the deployed `/api/finance` payload, current/closed period state, product-cost coverage and frozen historical COGS snapshots. Its diagnostic is published to GitHub issue **#10**.

`.github/workflows/finance-cost-audit.yml` provides the complementary historical product-cost audit and publishes to GitHub issue **#44**. The two workflows deliberately use separate persistent issues so one diagnostic can never overwrite the other.

## Application PR quality gate

The workflow file remains `.github/workflows/frontend-quality.yml` for continuity, but the workflow is named **Application quality** because it validates frontend source, browser-QA syntax, Compose configuration and the database migration chain.

It runs for changes affecting frontend source, the QA harness, the board image, Compose/environment configuration, SQL init/migrations, migration scripts or the workflow itself and has four independent jobs:

- `frontend-lint` — installs the board's Node tooling and runs `npm run lint` (ESLint + Stylelint);
- `qa-syntax` — runs `node --check` over the production browser/navigation QA scripts so QA harness edits cannot ship with JavaScript syntax errors;
- `compose-config` — runs `docker compose --env-file .env.example config --quiet` so the committed environment template and service definition cannot silently drift into an invalid configuration;
- `migration-chain` — starts a clean PostgreSQL 18 instance and applies the complete repository migration chain through `scripts/migrate.sh`.

The clean migration-chain job is specifically intended to catch migration ordering, dependency and `CREATE OR REPLACE VIEW` compatibility problems before the self-hosted production runner sees them. When replacing an existing PostgreSQL view that has dependents, preserve the existing column names/order/types and append genuinely new columns at the end unless the migration deliberately rebuilds the dependency graph.

Prettier remains a separate audit (`npm run format:check`) until retained global legacy styles are normalized deliberately; it is not a substitute for browser QA.

## Production-owned state

The repository deploys code, schema and seed/default configuration, but production also has persistent host-owned state:

- `/etc/dpp-analytics/env` — secrets, credentials, feature toggles, cadences;
- `/etc/dpp-analytics/product_labels.json` — persistent local product display overrides;
- `/etc/dpp-analytics/board-config/` — persistent board/worker business configuration such as product costs and variations;
- Docker named volumes — PostgreSQL and Grafana state.

Do not “fix” a production issue by overwriting these from Git unless the deployment design explicitly calls for it.

## Failure and rollback procedure

For an application regression without a database-model change:

1. identify the bad production SHA from issue #1 / the workflow run;
2. revert/fix the code on `main`;
3. let the normal deploy workflow rebuild and redeploy;
4. require production browser QA to pass again.

For a schema/data-model regression, a Git revert alone may not reverse already-applied migrations. Add an explicit corrective migration instead of manually editing the production schema.

For host-owned JSON/config changes, preserve the previous file before editing, validate its syntax, and then use the normal deployment/restart path needed by the affected service.

## Maintenance rule

If the deployment sequence, heartbeat issue, runner labels, production ports, QA procedure, persistent config paths or post-deploy validation changes, update this document in the same PR.
