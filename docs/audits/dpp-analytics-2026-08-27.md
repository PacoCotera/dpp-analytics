# DPP Analytics audit

Audit date: 2026-08-27  
Environment: production at `http://95.217.100.5:8088/`  
Build observed: `a39d33ad`  
Browser: DPP Playwright, Chromium, 1440 × 1200 desktop viewport

## Executive verdict

DPP Analytics is already responsive and generally well structured. Normal page navigation was fast, the main navigation was consistent, and no application console errors appeared beyond a missing favicon. Inventory is the strongest example of repeatable analytics because its action rules are explicitly disclosed. Trajectory also explains much of its signal grammar.

It is not yet safe to describe every surface as decision-grade. Six high-priority defects can cause a user to see an unreconciled financial result, a wrong geography count, contradictory product identities, an implausible family cover value, inconsistent timestamps, or structural parent SKUs inside sellable-product analytics.

The highest-value work is therefore data contracts and traceability, followed by accessibility and ergonomics. Raw page speed is not the current bottleneck.

## Scope

The audit covered every page reachable from the primary navigation and representative drill-down states:

| Area | States exercised |
|---|---|
| Business | Main overview |
| Today | Live day, closed day 2026-08-26, day selector |
| Sales | Overview, Drivers, Geography, CDMX postal drill-down |
| Products | Family mode, SKU mode, selling SKU `PNC-001`, new SKU `PNC-001L` |
| Inventory | Action queue, methodology disclosure, all-inventory reference |
| Finance | Current month, immutable monthly report, latest settlement |
| Trajectory | All horizons and portfolio signals |
| Ads | Pending-authorization empty state and tabs |
| Data Health | Summary, taxonomy condition, expanded pipeline jobs |
| Navigation | More menu and all linked routes |

The unlinked legacy path `/home` returns 404. It is not treated as a product defect because the current Business route is `/` and no audited navigation points to `/home`.

## Priority definitions

- **P1:** Can materially misstate data, create contradictory business identity, or undermine time-sensitive decisions.
- **P2:** Meaningfully impairs interpretation, traceability, accessibility, reliability, or routine workflow.
- **P3:** Confirmed polish or efficiency defect with low immediate decision risk.

No P0 outage or data-loss defect was observed.

## GitHub backlog

Master tracker: [#161](https://github.com/PacoCotera/dpp-analytics/issues/161)

| Audit ID | Priority | Issue | Initial status |
|---|---:|---:|---|
| DPP-001 | P1 | [#138](https://github.com/PacoCotera/dpp-analytics/issues/138) | Ready |
| DPP-002 | P1 | [#139](https://github.com/PacoCotera/dpp-analytics/issues/139) | Ready |
| DPP-003 | P1 | [#140](https://github.com/PacoCotera/dpp-analytics/issues/140) | Ready |
| DPP-004 | P1 | [#141](https://github.com/PacoCotera/dpp-analytics/issues/141) | Ready |
| DPP-005 | P1 | [#142](https://github.com/PacoCotera/dpp-analytics/issues/142) | Ready |
| DPP-006 | P1 | [#143](https://github.com/PacoCotera/dpp-analytics/issues/143) | Ready |
| DPP-007 | P2 | [#144](https://github.com/PacoCotera/dpp-analytics/issues/144) | Ready |
| DPP-008 | P2 | [#145](https://github.com/PacoCotera/dpp-analytics/issues/145) | Ready |
| DPP-009 | P2 | [#146](https://github.com/PacoCotera/dpp-analytics/issues/146) | Ready |
| DPP-010 | P2 | [#147](https://github.com/PacoCotera/dpp-analytics/issues/147) | Ready |
| DPP-011 | P2 | [#148](https://github.com/PacoCotera/dpp-analytics/issues/148) | Ready |
| DPP-012 | P2 | [#149](https://github.com/PacoCotera/dpp-analytics/issues/149) | Ready |
| DPP-013 | P2 | [#150](https://github.com/PacoCotera/dpp-analytics/issues/150) | Ready |
| DPP-014 | P2 | [#151](https://github.com/PacoCotera/dpp-analytics/issues/151) | Ready |
| DPP-015 | P2 | [#152](https://github.com/PacoCotera/dpp-analytics/issues/152) | Ready |
| DPP-016 | P2 | [#153](https://github.com/PacoCotera/dpp-analytics/issues/153) | Ready |
| DPP-017 | P2 | [#154](https://github.com/PacoCotera/dpp-analytics/issues/154) | Ready |
| DPP-018 | P2 | [#155](https://github.com/PacoCotera/dpp-analytics/issues/155) | Ready |
| DPP-019 | P2 | [#156](https://github.com/PacoCotera/dpp-analytics/issues/156) | Ready |
| DPP-020 | P3 | [#157](https://github.com/PacoCotera/dpp-analytics/issues/157) | Ready |
| DPP-021 | P3 | [#158](https://github.com/PacoCotera/dpp-analytics/issues/158) | Ready |
| DPP-022 | P3 | [#159](https://github.com/PacoCotera/dpp-analytics/issues/159) | Ready |
| DPP-023 | P3 | [#160](https://github.com/PacoCotera/dpp-analytics/issues/160) | Ready |

Issue state and production-verification comments are authoritative for execution status. This document preserves the original audit evidence and acceptance criteria.

## Issue-ready defect register

### DPP-001 · Closed-period finance bridge omits an included component

Priority: **P1**  
Domain: Finance, data integrity

Observed:

- The closed YTD report displays Sales `$57,910`, Amazon effect `−$14,814`, Advertising `−$43,947`, COGS `−$19,125`, and Contribution `−$17,935`.
- The visible operands total `−$19,976`, leaving an unexplained `$2,041` difference.
- The Finance API contains `other_amazon_postings` totaling `$2,041.19` for the same months. That field is included in contribution but omitted from the visible report.
- Individual month rows also fail visible arithmetic when this hidden component is nonzero. July's visible components total `−$619.24`, while contribution is `−$884.39`; the API contains `−$265.15` of other postings.

Impact: A finance result cannot be independently reconciled from the values presented on screen.

Acceptance criteria:

- Display Other Amazon postings as a defined column or roll it into a clearly named visible component.
- Every month and aggregate row must reconcile exactly from displayed operands, subject only to documented rounding.
- Add an automated reconciliation assertion for each closed month and YTD.

### DPP-002 · Geography reports raw state labels as distinct states

Priority: **P1**  
Domain: Sales, geography, data quality

Observed:

- Geography displays `57 states` while its state filter contains the 32 canonical Mexican federal entities.
- The raw source values include multiple aliases for the same place, including CDMX, D.F., DISTRITO FEDERAL, Ciudad de Mexico, Mexico City, and borough names such as Tlalpan and Cuauhtémoc.
- The normalized postal reference contains demand in 30 canonical states for the audited window.

Impact: The headline coverage metric overstates geographic breadth and cannot be compared reliably over time.

Acceptance criteria:

- Normalize every order to a canonical federal-entity key before aggregation.
- Report canonical state count, unmapped order count, and alias-resolution coverage separately.
- Add fixtures covering known CDMX and Estado de México variants.

### DPP-003 · `PNC-001L` has contradictory catalog identity

Priority: **P1**  
Domain: Products, taxonomy

Observed:

- The product page labels `PNC-001L` as Family `Standalone`.
- The same page labels it `SELLABLE_VARIATION`, provides parent ASIN `B0GGQHV45F`, variation theme `COLOR_NAME/STYLE_NAME`, a catalog family, and four sibling variations.
- Data Health independently flags this SKU for seller-taxonomy review.

Impact: Family rollups, sibling comparisons, portfolio counts, and product decisions can be assigned to the wrong entity.

Acceptance criteria:

- Resolve the SKU to one canonical identity that agrees with parent, theme, sibling, and lifecycle fields.
- Prevent contradictory Standalone and child-variation labels from rendering together.
- Add a taxonomy invariant test for every sellable SKU.

### DPP-004 · Main family displays zero days of cover despite stock and velocity

Priority: **P1**  
Domain: Products, inventory aggregation

Observed:

- The main Pocket family displays `119 stock`, `53 units` over 28 days, and `0d cover`.
- Child inventory views show nonzero cover values including 26, 43, 52, 89, and 177 days.
- A pooled calculation from the displayed stock and velocity is also nonzero.

Impact: The family card can imply immediate stockout while the same family has substantial available stock.

Acceptance criteria:

- Define whether family cover is pooled, minimum child cover, weighted cover, or another rule.
- Render the defined calculation and never coerce a no-velocity or missing child value to zero family cover.
- Add tests for mixed-velocity families and missing child velocity.

### DPP-005 · Timestamps render in different timezones across pages

Priority: **P1**  
Domain: Global, temporal accuracy

Observed:

- Most page headers showed Mexico local time near `15:47`.
- Ads showed `21:47` for the same session.
- Data Health showed `Health checked Aug 27, 9:48 PM` and job timestamps near 9:50 PM while its API supplied local values near 15:50 with an explicit `−06:00` offset.
- Relative ages remained correct; the absolute browser-formatted times shifted by six hours in the UTC browser environment.

Impact: Users can misread data freshness, sync completion, and cutoff times by six hours.

Acceptance criteria:

- Render all operating times explicitly in the agreed business timezone, including a visible zone label where ambiguity matters.
- Use the same formatting utility on every page.
- Add a browser test whose host timezone is UTC and asserts Mexico-local output at DST-relevant dates.

### DPP-006 · Structural parent `PNC-CURRENT` is treated as a sellable standalone item

Priority: **P1**  
Domain: Products, portfolio metrics

Observed:

- Family mode shows `PNC-CURRENT` as `1 sellable offer · 0 active`.
- SKU mode labels it `standalone` and gives it a product row with a blank image.
- Data Health includes it in product onboarding, even though it is a variation parent rather than a sellable offer.

Impact: Sellable, active/inactive, onboarding, and portfolio counts can include a non-sellable structural entity.

Acceptance criteria:

- Introduce and enforce a structural-parent entity type.
- Exclude structural parents from sellable-product KPIs, filters, decision queues, and onboarding counts.
- Keep parents available only where they provide hierarchy or family context.

### DPP-007 · Business health summary does not explain its narrower scope

Priority: **P2**  
Domain: Business, Data Health

Observed:

- Business reports `6/6 core streams healthy` and says the operating evidence is current and decision-ready.
- At the same time, Data Health reports one data condition and marks Products degraded.
- Data Health separately reports nine healthy pipeline jobs, so `6/6` is neither the job count nor the complete visible health state.

Impact: The executive surface can imply no material data condition while another surface reports one.

Acceptance criteria:

- Define which six streams are included and which conditions are excluded.
- Surface any active domain degradation beside the healthy-stream count, or qualify the healthy statement with its scope.
- Drive both pages from the same health contract and test their state mapping.

### DPP-008 · Postal drill-down silently truncates the visible result set

Priority: **P2**  
Domain: Sales, geography, ergonomics

Observed:

- The CDMX drill-down reports `48/49 active postal polygons mapped`.
- The visible postal list contains 20 rows.
- No Top 20 label, total-row indicator, pagination, expansion control, or export affordance explains the truncation.

Impact: A user can reasonably interpret the visible table as the complete set.

Acceptance criteria:

- Label a limited table explicitly, including `20 of 49`, and define its sort order.
- Provide Show all, pagination, or export when the full set is operationally relevant.

### DPP-009 · Interpretive labels are not consistently traceable to rules

Priority: **P2**  
Domain: Global, analytical repeatability

Observed:

- Pages render labels such as `Momentum is strong`, `Balanced`, `Improving`, `Mixed movement`, `Dormant`, `Traffic not converting`, and `low-signal` without consistently exposing thresholds, eligibility rules, or rule versions at the point of use.
- Inventory does expose its action thresholds, and Trajectory exposes signal grammar, showing that the product already has a viable disclosure pattern.
- A SKU listed on Aug 24 was labeled Dormant on Aug 27 despite having only a short eligible exposure window.

Impact: Users cannot independently reproduce several interpretations or distinguish a measured state from an undocumented heuristic.

Acceptance criteria:

- Attach each interpretive label to a named, versioned rule with inputs, window, threshold, and eligibility requirements.
- Make the rule accessible from the label without leaving the workflow.
- Add boundary tests and minimum-exposure handling for new listings.

### DPP-010 · Cross-page 28-day metrics do not disclose source and cutoff

Priority: **P2**  
Domain: Sales, Inventory, metric governance

Observed:

- Inventory showed `PNC-001` at 24 units while Sales and Products showed 25 for their 28-day period.
- Inventory showed `BLC-001` at 9 units while Sales and Products showed 8.
- The differences are consistent with distinct source/cutoff behavior, but Inventory's `28D units` label does not state its source or as-of time.

Impact: Two valid measures can look like an unexplained data error when their basis is hidden.

Acceptance criteria:

- Show source, included dates, and as-of timestamp for every rolling metric whose basis differs by domain.
- Reuse one metric when semantics are intended to be identical; otherwise give the measures distinct names.
- Add cross-page contract tests for intentionally shared metrics.

### DPP-011 · Geography product filter includes legacy and irrelevant SKUs

Priority: **P2**  
Domain: Sales, relevance

Observed:

- The Geography product filter contains 14 options while only six products sold in the selected 90-day view.
- Options include the legacy duplicate `PNC-001-FBM` with an old title, plus inactive or seasonal products.

Impact: The filter adds noise and makes it easy to choose a product with no relevant geography evidence.

Acceptance criteria:

- Default to canonical products with evidence in the selected period.
- Put inactive, legacy, or zero-evidence SKUs behind an explicit secondary choice.
- Collapse aliases to their canonical SKU unless the user selects an offer-level analysis.

### DPP-012 · Inventory reference view is dominated by legacy and no-velocity rows

Priority: **P2**  
Domain: Inventory, relevance

Observed:

- The all-inventory view contains 21 rows, with 15 no-velocity rows in the audited state.
- It includes legacy aliases and old identifiers such as `PNC-001-D`, `PNC-001-L`, `PNC-004-D`, `PNC-005-B`, `PNC-005-D`, and a stickered MSKU.
- The table has no lifecycle or alias column that explains why these rows remain relevant.

Impact: Obsolete identifiers dominate a reference view intended to support current inventory decisions.

Acceptance criteria:

- Default to canonical, current, stock-bearing offers.
- Add lifecycle and canonical-SKU fields, with explicit filters for retired, alias, archived, and no-velocity records.
- Ensure aliases cannot create duplicate demand or stock rollups.

### DPP-013 · Retired family naming conflicts with active lifecycle state

Priority: **P2**  
Domain: Products, lifecycle

Observed:

- A family named `Diseños retirados` is displayed as `4 sellable variations · 4 active`.
- It receives traffic but has zero units, zero revenue, and zero stock.

Continuity note, 2026-08-28: after DPP-006 separated deleted seller records from the current Amazon catalog, production no longer contains the `Diseños retirados` family. It exposes two current families built from eight current offers, while 14 deleted records remain in the separate historical surface. The remaining DPP-013 gap is an explicit server-owned family lifecycle contract and an attention guard for unresolved membership.

Impact: The name and operational status communicate opposite lifecycle states, weakening filters and attention counts.

Acceptance criteria:

- Use a canonical lifecycle field rather than inferring lifecycle from names.
- Explain or resolve any state in which a retired group contains active sellable offers.
- Exclude retired records from current attention counts unless a documented cleanup action remains.

### DPP-014 · Geography map depends on GitHub Raw at runtime

Priority: **P2**  
Domain: Sales, reliability and performance

Observed:

- Opening Geography fetches Mexico state geometry from `raw.githubusercontent.com/strotgen/mexico-leaflet/master/states.geojson`.
- The request succeeded during the audit, but the core map depends on a third-party repository and its current content at view time.

Impact: A third-party outage, rate limit, repository change, or network policy can break a core analytics view independently of DPP.

Acceptance criteria:

- Pin, validate, and serve the geometry from DPP-controlled storage or bundle it with the release.
- Provide a visible fallback if geometry cannot load while retaining the data table.

### DPP-015 · Static asset cache and versioning strategy can produce mixed releases

Priority: **P2**  
Domain: Global, cache behavior

Observed:

- Fingerprinted `theme.css?v=…` and unversioned shared JavaScript both return `Cache-Control: public,max-age=300` with no ETag or Last-Modified validator.
- Most pages load `ui-utils.js` and `data-cache.js` without a version token; Sales used a versioned `data-cache.js` URL.
- Warm navigation did produce browser cache hits, so caching is active. No stale page was reproduced during the audit.

Impact: A deployment can temporarily combine a new page bundle with an older shared script, while fingerprinted assets still incur short-TTL network work.

Acceptance criteria:

- Fingerprint every deployment asset and reference one release manifest consistently.
- Serve immutable fingerprinted assets with a long cache lifetime.
- Use validators for any intentionally stable URL and add a deployment test that rejects mixed asset revisions.

### DPP-016 · Product page says Ads is ready while access is pending

Priority: **P2**  
Domain: Products, Ads, state communication

Observed:

- Product pages show the status `Ads access pending`.
- The adjacent decision card headline says `Ads integration ready` and explains that metrics will populate only after authorization and backfill.
- The Ads page itself correctly says it is waiting for authorization.

Impact: The headline communicates a completed capability while the detailed state says it is unavailable.

Acceptance criteria:

- Use one explicit state machine across Product and Ads: not connected, authorization pending, backfill running, ready, or failed.
- Derive both headline and detail text from that state.

### DPP-017 · Settlement card renders broken placeholders when dates are absent

Priority: **P2**  
Domain: Finance, UI resilience

Observed:

- The latest settlement reconciles, but its API has null settlement start, end, and deposit dates.
- The card renders `—–— settlement · deposit —` even though settlement ID `27148998881` and report ID `66913020679` are available.

Impact: The most recent settlement appears malformed and is difficult to identify.

Acceptance criteria:

- Suppress absent date fragments and show available stable identifiers.
- Define an explicit Unknown date state and test every null-date combination.

### DPP-018 · Key cards and controls lack complete accessibility semantics

Priority: **P2**  
Domain: Global, accessibility and ergonomics

Observed:

- Family-mode product cards use overlay links with empty accessible names.
- Catalog Family mode renders two level-one headings; product detail renders no level-one heading.
- Today range/day controls, Catalog mode/filter controls, Product range controls, and Inventory filters rely on visual classes without `aria-pressed` or `aria-selected` state.
- The Finance monthly report is visually tabular but does not expose table semantics.
- Sales tabs were correctly exposed as a tablist, demonstrating the expected pattern.

Impact: Keyboard and assistive-technology users cannot reliably identify destinations, selected states, or financial row/column relationships.

Acceptance criteria:

- Give every interactive link a descriptive accessible name.
- Use one logical H1 per page and semantic tables for tabular financial data.
- Expose selected states and keyboard behavior using the appropriate ARIA pattern.
- Add automated accessibility checks plus keyboard smoke tests for every main route.

### DPP-019 · Analysis state is not shareable on several multi-view pages

Priority: **P2**  
Domain: Sales, Products, ergonomics

Observed:

- Sales tab, Geography filter, and selected-state drill-down changes leave the URL at `/sales`.
- Catalog Family/SKU mode and filter changes leave the URL at `/catalog`.
- Today correctly encodes a selected date in `?date=…`, proving the shareable-state pattern is available.

Impact: A user cannot bookmark or send the exact analytical view used to support a decision.

Acceptance criteria:

- Encode stable tabs, filters, date windows, and drill-down keys in the URL.
- Restore the same state on direct load, refresh, and browser back/forward.

### DPP-020 · All-zero product chart renders misleading dollar ticks

Priority: **P3**  
Domain: Products, charting

Observed:

- The zero-demand chart for `PNC-001L` renders repeated rounded `$1` and `$0` y-axis labels despite the series being entirely zero.

Impact: The scale suggests nonzero demand and looks mathematically unstable.

Acceptance criteria:

- Detect all-zero series and render a zero baseline or a clear No demand in range state.
- Never fabricate a positive currency tick for an all-zero domain.

### DPP-021 · Several labels and formats are mechanically incorrect or ambiguous

Priority: **P3**  
Domain: Global, UI copy

Observed:

- Singular values render as `1 orders · 1 units` and product cards render `1 units · 1 orders`.
- Business renders a negative amount as `$-884` while Finance uses `−$884`.
- Finance month labels such as `Aug 26` can be read as August 26 rather than August 2026.
- Data Health labels a column `LAST FETCH`, but its cells contain read/stored row counts such as `14 read · 14 stored`.

Impact: Small inconsistencies reduce trust in a precision-oriented tool.

Acceptance criteria:

- Centralize pluralization, currency, and month-year formatting.
- Rename the Data Health column to match its contents, such as Last result or Rows read/stored.
- Add unit tests for 0, 1, and plural values plus positive and negative currency.

### DPP-022 · Missing favicon creates a console and network error on every cold visit

Priority: **P3**  
Domain: Global, UI polish

Observed:

- The first cold page load requests `/favicon.ico` and receives HTTP 404.
- This was the only application console/network error observed during the audit.

Acceptance criteria:

- Serve a valid favicon or declare an existing icon explicitly.
- Keep the cold-route console free of application-owned errors.

### DPP-023 · Ads empty state loads chart libraries it cannot use

Priority: **P3**  
Domain: Ads, performance

Observed:

- With authorization pending and no Ads data, the page still loads D3 and the chart system.
- The audited compressed D3 transfer was about 93 KB, with about 279 KB decoded, before any chart could be rendered.

Impact: The empty state does unnecessary parsing and transfer work, especially on a cold visit.

Acceptance criteria:

- Load chart dependencies only after data is available or a chart-bearing state is entered.
- Preserve the current fast empty-state render without unused chart code.

## Performance findings

These are single-session browser resource timings from the DPP Playwright host, not a controlled load-test benchmark. They are useful for route comparison and finding obvious regressions.

| Route | Document navigation | Primary API | Observation |
|---|---:|---:|---|
| Today | 67 ms | 55 ms | UI populated at roughly 122 ms; product image about 288 ms |
| Business | 30 ms | 71 ms | Fast |
| Sales | 34 ms | 101 ms | Fast |
| Products | 30 ms | 301 ms | Largest API payload, about 156 KB decoded and 12 KB transferred |
| Product detail | 49 ms | 278 ms | Acceptable; image and chart work follow data |
| Inventory | 20 ms | 30 ms | Fast |
| Finance | 44 ms | 37 ms | Fast despite long page |
| Trajectory | 32 ms | 52 ms | Fast |
| Ads | 25 ms | 18 ms | Fast, but includes unused chart code in empty state |
| Data Health | 16 ms | 34 ms | Fast |

External Amazon images took roughly 335 to 576 ms on the heavier catalog view, but content populated before they completed. This did not make the page feel blocked.

## Cache findings

| Resource | Observed policy | Assessment |
|---|---|---|
| HTML documents | `no-cache`, no ETag/Last-Modified | Fresh HTML, but no conditional validator observed |
| Fingerprinted theme CSS | `public,max-age=300` | Works, but short for a fingerprinted immutable asset |
| Shared JS | `public,max-age=300`, often unversioned | Browser cache works; mixed-release risk remains |
| `/api/today` | `private,max-age=15` | Compatible with observed roughly 20-second live polling |
| `/api/catalog` | `private,max-age=300` | Reduces cost, but the five-minute freshness contract should be explicit |
| `/api/data-health` | `private,max-age=30` | Compatible with the page's refresh behavior |

No stale UI was reproduced during this audit. Warm resource requests did show zero-transfer cache hits. The confirmed defect is inconsistent asset identity and validation, not a reproduced stale-data event.

## What worked well

- All current primary routes loaded successfully and normal navigation felt snappy.
- The page hierarchy and visual density are generally effective for an operational analytics tool.
- Today encodes historical-day state in the URL.
- Sales distinguishes historical coverage and geocoding coverage.
- Inventory exposes explicit action thresholds and correctly reserves HOLD for judgment.
- Finance current-month arithmetic and the latest settlement amounts reconciled.
- Trajectory provides a signal-grammar explanation rather than presenting every label as self-evident.
- Data Health exposes pipeline age, cadence, last success, and row outcomes.
- No page-level JavaScript errors were observed beyond the missing favicon request.

## Recommended delivery order

1. Fix DPP-001 through DPP-006 and add invariant tests at the API/view-model boundary.
2. Establish shared contracts for health, timezones, metric provenance, taxonomy, lifecycle, and interpretation rules.
3. Remove relevance noise from geography, inventory, and portfolio counts.
4. Make analysis states shareable and complete the accessibility pass.
5. Harden deployment caching and remove minor UI/performance defects.

## Regression gate for the next audit

A release should pass the following repeatable checks before it is called accurate and decision-ready:

- Every displayed finance bridge reconciles from visible operands.
- Geography totals use canonical entities and expose unmapped records.
- Every sellable SKU satisfies identity and lifecycle invariants.
- Family cover has a defined aggregation rule and nonzero-stock edge cases.
- All timestamps render in the business timezone under a UTC-hosted browser.
- Every interpretive label exposes a versioned rule and eligible evidence window.
- Shared metrics either match across pages or state their different source/cutoff.
- The same filtered view survives direct load, refresh, and browser navigation.
- Automated accessibility checks find no unnamed links or missing selected states.
- A cold route has no application-owned console errors.
