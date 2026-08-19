# DPP Analytics

Self-hosted analytics platform for Dirty Pawz Press.

## Architecture

- PostgreSQL: canonical data store and KPI layer
- Grafana: dashboards and wall display
- Python ingestors: Amazon SP-API, Data Kiosk, Finances, FBA Inventory, and Amazon Ads
- GitHub Actions: deployment to the private self-hosted runner

## Principles

1. PostgreSQL is the system of record; Grafana contains minimal business logic.
2. Raw source data is retained where practical, then normalized into facts/dimensions and KPI views.
3. Cash-flow reporting is kept separate from economic contribution/P&L.
4. Recent Amazon data may be provisional until financial and advertising data settle.
5. Secrets never live in Git.
6. Production SP-API access is smoke-tested read-only before historical/live ingestion is enabled.

## Planned dashboards

- Home / Control Center
- Sales
- Catalog
- Advertising
- Inventory & Production
- Finance
- Trajectory
- Data Health

## Deployment

The production host is an Ubuntu LTS VM under Proxmox. Deployment is performed by a repository-scoped GitHub self-hosted runner.

The Amazon application is `dpp-analytics-prod`; production ingestion remains behind an explicit host-side kill switch until authorization probes pass.

See `docs/bootstrap.md` after the initial repository scaffold is complete.
