# Reporting performance baselines

## Purpose

Performance changes must be evaluated against production measurements, not subjective page feel or isolated local timings. This document defines the baseline contract for the Dirty Pawz Press reporting application.

The system measures two different layers because they answer different questions:

1. **API / payload cost** — how much work PostgreSQL + Python must do to build a canonical response, and how cheap that response becomes after the board-process cache is warm.
2. **Browser data-ready time** — how long a page takes before its primary business content is usable, including HTML, assets, JavaScript, API transport, rendering and browser session-cache behavior.

Neither layer replaces correctness QA. A fast wrong number is still a regression.

## Production measurements

### API layer

`qa/cache_performance_qa.mjs` measures every cached dashboard API surface with one forced rebuild followed immediately by one warm hit.

For each endpoint it records:

- `cold_build_ms` — server-side payload-builder duration from `X-DPP-Build-Ms`;
- `cold_request_ms` — end-to-end HTTP request duration for the forced rebuild;
- `warm_request_ms` — end-to-end duration for the immediate cache hit;
- `payload_bytes` — serialized response size;
- cache TTL and HIT/REFRESH contract.

The production probe currently covers Today, Business, Sales, Sales Geography, Catalog, Inventory, Finance, Ads, Product, Trajectory and Data Health.

### Browser layer

`qa/load_time_qa.mjs` measures the ten page workspaces at a fixed desktop viewport.

For each page it records:

- cold `data_ready_ms` — navigation start until the primary business surface is populated;
- revisit `data_ready_ms` — same-tab return after the first visit has populated the browser session cache;
- DOMContentLoaded and load-event timing;
- same-origin transferred bytes and resource count;
- API requests made during cold load and revisit;
- failed API responses and browser errors.

A revisit is intentionally measured in the same browser session. The requirement being tested is the user behavior that motivated the cache work: moving away from a workspace and returning should not unnecessarily depend on the network while its freshness window remains valid.

## Candidate and accepted baselines

Every production QA run writes:

- `cache-performance-summary.json`;
- `load-time-summary.json`;
- `performance-candidate-baseline.json`;
- `performance-baseline-summary.json`;
- `performance-baseline-report.md`.

`performance-candidate-baseline.json` is a normalized snapshot suitable for later promotion. It is evidence, not automatically the accepted baseline.

The accepted baseline lives in `qa/performance-baseline.json` and is version-controlled with the application.

### Promotion policy

Do not promote the first successful timing run automatically.

The initial policy is:

1. collect at least **three successful production samples** on comparable code/data shape;
2. use the **median** timing for each latency metric to suppress runner/network noise;
3. use the latest representative payload size where the payload contract is unchanged;
4. document the source commits/samples when the baseline is promoted;
5. only then enable meaningful regression comparison.

A baseline may be intentionally reset after a major payload/architecture redesign, but the previous baseline and performance-history issue remain evidence of the before state.

## Regression policy

During the initial collection period, comparisons are informational and do not block deployment.

Once an accepted baseline exists, the default comparison policy is:

- warning when a latency metric is at least **25% worse** and at least **75 ms slower**;
- hard regression at **50% worse** after the same absolute noise floor;
- payload-size noise floor of **16 KB**;
- API-request-count regressions use an absolute difference of at least one request.

These thresholds are intentionally conservative until enough production samples exist to estimate normal variance. They may be tightened later from observed distributions.

## Historical tracking

GitHub issue **#122 — DPP Analytics performance history** is the chronological production record.

A separate `Performance history` workflow consumes completed deployment QA artifacts and appends a concise sample containing:

- slowest API cold builds;
- warm API request time;
- payload sizes;
- page cold/revisit data-ready times;
- revisit API request counts;
- baseline comparison status when available.

This workflow is deliberately outside the deployment critical path. Failure to publish history must never fail or roll back production.

## First production sample

The first API-wide production sample was captured on commit `db408d58` on 2026-08-24.

It established the initial cold-build order:

| Surface | Cold build | Warm request |
| --- | ---: | ---: |
| Catalog | 6,775 ms | 36 ms |
| Product | 4,775 ms | 38 ms |
| Business | 2,752 ms | 10 ms |
| Sales | 1,933 ms | 32 ms |
| Today | 1,090 ms | 82 ms |

The result confirms that the process cache is effective after the first build, while cold PostgreSQL/payload construction is still the dominant performance problem. Catalog is therefore the first measured persistence/query-optimization target, followed by Product.

## What the baseline is for

Use the measurements to answer specific engineering questions:

- Did a browser-cache change reduce revisit data-ready time and API request count?
- Did payload shaping reduce bytes without changing semantics?
- Did a persisted KPI/materialized relation reduce cold build time?
- Did a refactor merely move time from SQL to Python/rendering?
- Did an optimization improve one page while making another consumer slower?

The goal is a sequence of measured improvements, not a single benchmark score.
