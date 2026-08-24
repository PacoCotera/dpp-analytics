# Reporting cache and query-performance architecture

## Problem

The operating board historically rebuilt API payloads from PostgreSQL on every page load and many page runtimes explicitly requested `cache: 'no-store'`. Because the board uses full-page navigation, moving between workspaces also discards page-local JavaScript state. The result was repeated PostgreSQL work, repeated JSON serialization and avoidable loading states even when the underlying Amazon data had not changed.

The objective is not to make stale data look live. It is to stop recomputing the same decision payload more frequently than its source can materially change.

## User-facing behavior

The board should behave like an application rather than a set of disconnected reports:

1. Revisiting a workspace within its freshness window should render from the browser session cache without waiting for the network.
2. A cold request should normally be served from the board process cache when another request recently built the same payload.
3. Expensive business calculations should increasingly be read from PostgreSQL `mart` KPI/cache relations rather than rebuilt inside page requests.
4. Optional heavy detail should load only when the user asks for it. A default page payload must not carry a large drill-down dataset solely because another tab may need it later.
5. Cache freshness must be visible and bounded. No cache may silently outlive the business cadence assigned to it.
6. Manual/diagnostic refresh must be able to bypass the board cache without changing business definitions.
7. Cache failure must degrade to the canonical uncached query path. PostgreSQL remains the system of record.

## Architecture

```text
Amazon sources
    |
    v
raw / core PostgreSQL facts
    |
    v
mart KPI + reconciliation layer
    |
    v
board payload builders
    |
    +--> process TTL response cache
    |
    v
HTTP API
    |
    +--> browser session TTL cache + in-flight request dedupe
    |
    v
page renderer
```

### Layer 1: PostgreSQL `mart` KPI/cache relations

PostgreSQL owns business truth. The long-term performance target is that page payload builders mostly read compact, already-derived `mart` relations.

Existing `mart.business_daily`, `mart.business_rolling`, inventory attention and other marts already establish the right semantic boundary, but several are ordinary views. Ordinary views still execute their underlying aggregation/window logic on every request.

The next database phase is therefore selective, not a blanket conversion of every view:

- profile endpoint builders and rank the slowest SQL;
- materialize or incrementally maintain only repeated expensive KPI shapes;
- prefer incremental/upserted KPI tables when ingestion knows which business dates changed;
- use materialized views only where full refresh cost is small and operationally predictable;
- preserve canonical metric definitions and reconciliation rules exactly;
- never put accounting, tax, attribution or inventory-action logic in a browser cache.

Candidate persisted KPI shapes include business daily/rolling summaries, SKU daily/rolling summaries, current inventory attention and compact finance/ads period summaries. The exact migration should follow production query timings rather than assumptions.

### Layer 2: board-process response cache

The board runs as a single Python service today, so Redis is not justified yet. A bounded, thread-safe in-process TTL cache is the default.

The cache stores serialized JSON response bytes keyed by endpoint plus normalized query parameters. This avoids repeated SQL, payload decoration and JSON serialization for identical requests.

Required behavior:

- bounded entry count;
- per-key single-flight build so concurrent misses do not stampede PostgreSQL;
- immutable byte payloads in cache;
- endpoint-specific TTLs;
- `refresh=1` bypass that rebuilds and replaces the cache entry;
- response headers exposing HIT/MISS/REFRESH and cache age for diagnostics;
- `/health` remains uncached because it is a liveness/dependency probe.

Initial TTLs are intentionally conservative and can be tuned from observed behavior:

| Endpoint | Initial board TTL | Reason |
| --- | ---: | --- |
| `/api/today` current day | 15 s | near-real-time operating surface |
| `/api/today?date=...` | 300 s | historical day is effectively stable |
| `/api/home` | 30 s | mixes Today with rolling business state |
| `/api/sales` | 60 s | live Today/recent-order context plus reconciled history |
| `/api/sales/geography` | 300 s | optional historical postal drill-down; loaded only when opened |
| `/api/catalog` | 300 s | catalog/commercial history changes slowly |
| `/api/inventory` | 60 s | operational, but source polling is much slower than page navigation |
| `/api/finance` | 300 s | accounting source changes on a multi-hour cadence |
| `/api/ads` | 300 s | Amazon Ads reporting is delayed/restatable |
| `/api/product` | 300 s | mostly reconciled historical/catalog data |
| `/api/trajectory` | 600 s | structural historical read |
| `/api/data-health` | 30 s | operational status, intentionally short-lived |

### Layer 3: browser session cache

The shared frontend fetch utility owns a small session-scoped TTL cache for GET JSON requests.

Use `sessionStorage` so cache entries survive full-page navigation inside the current browser tab but disappear with the tab/session. Keep a same-page memory fallback for environments where storage is unavailable or a payload exceeds storage quota.

Required behavior:

- cache by complete same-origin URL, including query parameters;
- return a fresh cached payload immediately;
- deduplicate identical in-flight requests inside the current page;
- after TTL expiry, fetch canonical data again;
- never cache failed responses;
- allow `forceRefresh` for diagnostic/manual refresh paths;
- never cache non-GET mutations if the board later adds them.

The browser cache is a transport optimization only. It does not own business truth.

### Layer 4: payload shaping and lazy detail

Caching does not excuse oversized default payloads.

Sales is the first implemented example. The default `/api/sales` snapshot contains Overview, Drivers and recent order evidence but no postal history. The Geography workspace is served separately by `/api/sales/geography`, is not requested during initial Sales navigation, and uses a five-minute board/browser cache once the Geography tab is opened.

The geography split changes neither its data source nor its privacy boundary: it still reads the reduced Orders geography facts and exposes state/country/postal dimensions plus the local SEPOMEX reference dictionary. Recipient PII is not queried or returned.

The same rule applies elsewhere: one page snapshot is preferred over many tiny requests for information needed immediately, but optional large drill-downs should not inflate the default snapshot.

## Freshness and invalidation model

Phase 1 uses bounded TTLs. This immediately removes page-click recomputation without coupling the worker and board processes.

Phase 2 adds ingestion-aware invalidation once the cache behavior is measured. The preferred model is a lightweight PostgreSQL generation/epoch written after successful source ingestion. The board can observe that generation at low frequency and invalidate affected cache namespaces. This keeps the worker and board loosely coupled and avoids Redis solely for invalidation.

Until ingestion-aware invalidation exists, TTL must never be longer than the period in which the corresponding decision surface may reasonably need to reflect a source change.

## Observability

Performance work is incomplete if cache behavior is invisible.

Board API responses expose:

- `X-DPP-Cache: HIT | MISS | REFRESH`;
- `X-DPP-Cache-Age` in seconds;
- `X-DPP-Cache-TTL` in seconds;
- standard `Content-Length`, which provides serialized response size.

Sales Geography production QA records the serialized byte size and cache status of both the core Sales payload and the lazy geography payload. This creates an executable payload-shaping check without turning Data Health into a performance UI prematurely.

A later Data Health extension should report per-endpoint request count, hit rate, build latency and last cold-build duration. PostgreSQL query profiling should then determine which `mart` views deserve persisted KPI tables.

## Acceptance targets

These are application targets, not correctness substitutes:

- browser-cache page revisit: no network dependency before first render;
- warm board API payload: under 100 ms where practical;
- cold compact KPI payload: under 300 ms where practical;
- expensive multi-table aggregation: not repeatedly executed in ordinary page navigation;
- no change to monetary basis, reconciliation, Finance close semantics, Ads attribution semantics or inventory action definitions;
- production browser QA and numeric reconciliation remain green.

## Implementation plan

### Phase 1 — stop avoidable recomputation

- [x] define architecture and cache/freshness contract;
- [x] add board-process TTL response cache with per-key single-flight;
- [x] add cache diagnostic headers and `refresh=1` bypass;
- [x] add browser session JSON cache and in-flight request dedupe to the shared fetch utility;
- [ ] move remaining classic runtimes, especially the canonical Sales overview loader, onto the shared browser cache;
- [x] add automated cache-behavior coverage;
- [ ] deploy and measure cold vs warm response behavior.

### Phase 2 — reduce cold payload cost

- [x] split Sales geography into a lazy cached endpoint;
- [ ] inspect other default payloads for optional heavy detail;
- [ ] add endpoint build-time instrumentation and Data Health visibility;
- [ ] rank slow SQL by measured cold-build contribution.

### Phase 3 — PostgreSQL KPI persistence

- [ ] persist the highest-value repeated KPI shapes in `mart`;
- [ ] refresh/upsert affected dates from ingestion rather than full-history recomputation where practical;
- [ ] add ingestion generation/epoch invalidation for affected board cache namespaces;
- [ ] validate persisted KPI outputs against the existing canonical views before switching readers.

### Phase 4 — scale only if needed

Use Redis/shared cache only if the board becomes multi-process/multi-instance or cache invalidation/coordination cannot remain simple. Do not add it pre-emptively.

## Invariants

1. PostgreSQL remains the system of record.
2. Cache layers may reuse a canonical payload; they may not redefine it.
3. Cache changes must not alter tax basis, monetary basis or reconciliation logic.
4. Health/liveness checks are never satisfied by a stale application response cache.
5. A cache miss is a normal path and must always produce the same payload semantics as an uncached request.
6. Applied SQL migrations remain immutable; persisted KPI work uses new migrations.
7. Production acceptance includes browser QA, number reconciliation and visual inspection, not cache-hit status alone.
