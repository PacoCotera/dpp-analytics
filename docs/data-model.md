# DPP Analytics data model

## Layers

- `raw`: source payloads retained for replay/audit, excluding customer PII.
- `core`: normalized business entities and facts.
- `mart`: dashboard-ready views and rolling KPIs.
- `ops`: ingestion state, cursors, migrations, and health.

## Current sources

### Orders API v2026-01-01
Near-real-time order and item synchronization. The collector intentionally requests operational, fulfillment, promotion, and proceeds datasets and does not request buyer or recipient data.

### FBA Inventory API v1
Hourly inventory snapshots including fulfillable, inbound, reserved, unfulfillable, researching, and total quantities.

## Planned sources

- Data Kiosk sales and traffic
- Finances API v2024-06-19
- Settlement reconciliation reports
- Amazon Ads reporting

## KPI policy

Intraday dashboards use Orders API data. Reconciled historical daily sales will prefer Data Kiosk once available. Cash movement and economic contribution are modeled separately.
