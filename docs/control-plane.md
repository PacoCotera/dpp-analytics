# DPP Analytics control plane

The repository is both the source of truth for application code/schema and the deployment control plane for the self-hosted production host.

## Production branch and runner

- `main` is the production branch.
- `.github/workflows/deploy.yml` runs automatically on pushes to `main`.
- The same workflow supports `workflow_dispatch` for an explicit manual run.
- Deployment runs on the repository-scoped self-hosted Linux/x64 runner labeled `dpp-analytics`.
- Deployments use concurrency group `dpp-analytics-production`; releases queue so an in-progress run can complete cleanup and heartbeat publication.

Prefer the GitHub workflow over manual changes to running containers. The workflow result plus production browser QA is the authoritative deployment outcome.

## What a deployment does

The deploy workflow performs these stages in order:

1. initialize run-local deployment diagnostic scratch state;
2. bootstrap/validate the host and Docker tooling;
3. ensure `/etc/dpp-analytics/env` exists and retain production secrets on-host;
4. initialize persistent local product configuration and a host-owned Admin password if they do not already exist;
5. validate `compose.yml`;
6. pull PostgreSQL/Grafana base images and build worker/board images;
7. start/health-check PostgreSQL;
8. apply repository SQL migrations through `scripts/migrate.sh`;
9. backfill historical product-cost state needed by Finance;
10. refresh Finance month-close state;
11. deploy the complete Compose stack;
12. verify the worker and the configured SP-API authorization mode;
13. verify Grafana;
14. verify board health plus representative Home/Sales/Inventory APIs/pages;
15. build and run the production browser-QA image against the deployed board;
16. upload browser-QA artifacts;
17. publish a machine-readable deployment heartbeat to GitHub.

The board image itself does not inject CSS, JavaScript or page behavior. Its HTML build mutation is limited to stamping the deployed SHA into the footer.

## Production browser QA

`qa/visual_qa.mjs` is run inside the QA image after deployment while sharing the board container's network namespace, against its loopback-only `http://127.0.0.1:8080` listener. This keeps protected Admin QA on the same operator-only path enforced by the application; it does not weaken public Admin denial.

The QA output includes browser captures and a structured summary covering, among other checks:

- successful/failed scenario captures;
- browser console errors;
- failed HTTP responses;
- horizontal overflow at tested viewports.

Compact successful QA output is retained for 3 days; full failure diagnostics are retained for 14 days. A technically green API health check is not enough if browser QA fails.

Navigation-specific QA also lives under `qa/nav_qa.mjs`; catalog semantic checks are documented in `qa/README-catalog-semantics.md`.

`qa/admin_qa.mjs` receives only `DPP_ADMIN_PASSWORD` through a temporary root-readable env file. It checks public denial, authenticated catalog loading, a no-op save/reload, downstream Catalog consumption and logout. It never emits the password or seller configuration values. Failure cleanup removes both the QA container and temporary env file.

Browser-QA selectors are part of the application contract. They should target canonical page ownership and stable semantic DOM markers, not deleted enhancement layers or incidental legacy class names. When a frontend refactor intentionally changes the canonical DOM, update the corresponding QA selector in the same PR. When deleting a frontend runtime/style file, remove every source dependency on it before deleting the file; production 404s for removed assets are deployment failures.

## Deployment heartbeat

GitHub issue **#1** is the production deployment heartbeat. The workflow updates the same issue after every attempt so it can be inspected without SSH access. Each run clears its deployment diagnostic scratch files before host bootstrap, so a failed or skipped probe cannot leak evidence from a previous run into the current heartbeat.

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

The workflow file remains `.github/workflows/frontend-quality.yml` for continuity, but the workflow is named **Application quality** because it validates frontend source, board Python, the production board image, browser-QA syntax, Compose configuration and the database migration chain.

It runs for changes affecting frontend source, board Python, the QA harness, the board image, Compose/environment configuration, SQL init/migrations, migration scripts or the workflow itself and has six independent jobs:

- `frontend-lint` — installs the board's Node tooling and runs `npm run quality` (frontend ownership contract, ESLint, Stylelint and Prettier check);
- `board-python` — compiles board Python and runs the response-cache behavior tests;
- `board-image` — builds the actual production `board/Dockerfile`, including its import smoke test, so missing `COPY` dependencies or image-only import failures are caught before merge;
- `qa-syntax` — runs `node --check` over the production browser/navigation QA scripts so QA harness edits cannot ship with JavaScript syntax errors;
- `compose-config` — runs `docker compose --env-file .env.example config --quiet` so the committed environment template and service definition cannot silently drift into an invalid configuration;
- `migration-chain` — starts a clean PostgreSQL 18 instance and applies the complete repository migration chain through `scripts/migrate.sh`.

The board-image job exists specifically because source-level Python compilation cannot prove that every runtime dependency is packaged into the production Docker image. Any board module imported at runtime must be present in the image and survive the Dockerfile import smoke test.

The clean migration-chain job is specifically intended to catch migration ordering, dependency and `CREATE OR REPLACE VIEW` compatibility problems before the self-hosted production runner sees them. When replacing an existing PostgreSQL view that has dependents, preserve the existing column names/order/types and append genuinely new columns at the end unless the migration deliberately rebuilds the dependency graph.

Formatting is part of `npm run quality`; it remains a mechanical source gate and is not a substitute for browser QA.

## Production-owned state

The repository deploys code, schema and seed/default configuration, but production also has persistent host-owned state:

- `/etc/dpp-analytics/env` — secrets, credentials, feature toggles, cadences;
- `/etc/dpp-analytics/board-config/` — persistent product labels, taxonomy, costs, bounded Admin backups and non-secret Admin audit metadata;
- Docker named volumes — PostgreSQL and Grafana state.

The worker's `/config` mount remains read-only. The board's `/config` mount is read-write solely for authenticated Admin updates. `DPP_ADMIN_PASSWORD` remains in `/etc/dpp-analytics/env`; deployment creates it when missing but never publishes it to the heartbeat or artifacts. Direct-HTTP production accepts Admin only from loopback, so operators use an SSH tunnel. Non-loopback access requires both the explicit remote toggle and secure cookies behind HTTPS.

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
