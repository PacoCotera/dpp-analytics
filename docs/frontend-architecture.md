# Operating Board Frontend Architecture

This document defines frontend ownership and architectural constraints. For the route → API → HTML/CSS/JS map and operational change recipes, use [`maintenance.md`](maintenance.md). For source-of-truth and reconciliation rules, use [`data-model.md`](data-model.md). For response caching, freshness and KPI-precomputation rules, use [`reporting-cache-architecture.md`](reporting-cache-architecture.md).

## Decision

Use native HTML, CSS Grid/Flexbox and ES modules for the current application. Do not add React, Bootstrap or Tailwind merely to solve layout consistency.

The original maintainability problem was unclear ownership: inline page CSS/JS, multiple global override layers, post-render mutation scripts and Docker-time HTML rewriting. Those layers have now been removed from the served workspaces. Adding React before that cleanup would have created two frontend systems; after the cleanup, React can be judged on actual remaining application complexity instead.

## Layers

### 1. Foundation

Owns only global visual tokens and typography:

- color and semantic state tokens
- type scale and reading floor
- spacing scale
- radii and borders
- responsive breakpoints
- base element behavior

### 2. Application shell

`static/ui-shell.js` and `static/nav-shell.css` own application-wide orientation and navigation behavior:

- brand and primary navigation
- active destination state
- More menu
- workspace identity
- mobile page/workspace swipes
- tab keyboard accessibility
- shared favicon declaration and brand mark

A page must not implement a second primary navigation system.

### 3. Layout system

`static/layout-system.css` owns reusable geometry:

- `.page-header`
- `.kpi-rail`
- `.page-section`
- `.section-header`
- `.dashboard-grid`
- `.panel`
- `.action-list`
- `.segmented-control`
- `.data-table-shell`
- `.status-strip`

These primitives are intentionally data-agnostic. Variable-length content such as action queues must not share geometry with fixed KPI rails. KPI rails remain stable while action lists grow or disappear vertically.

### 4. Visualization system

`static/chart-system.css` and `static/chart-system.js` own reusable chart behavior:

- axes and tick typography
- semantic colors
- tooltips
- legends
- current/partial period treatment
- month/year boundaries
- empty/loading states
- all-zero selected-metric states without synthetic positive domains
- supported chart forms
- responsive behavior for charts that need more horizontal reading width than a phone viewport can provide

Pages choose the correct analytical chart but should not independently recreate generic chart primitives. Product
demand pages pass canonical series to the shared owner; `chart-system.js` renders an explicit range-empty state
when the selected metric is all zero.

Pages with a canonical non-chart state may defer the shared chart runtime. Ads owns this boundary in
`ads-chart-loader.js`: the page loads chart CSS, D3 and `chart-system.js` only after its API reports both a
`READY` connection and `ready` reporting data, while retaining the release revision on every dynamic URL.

Shared mechanical formatting lives in `static/format-core.js` and is re-exported by `ui-utils.js`. Page modules use
its count, currency, and month-year formatters instead of assembling plurals, currency signs, or abbreviated years.

Dense multi-period charts may opt into `.dpp-chart-scroll` on the containing chart region and `.dpp-chart--wide` on the chart itself. At phone widths the shared chart system preserves a readable minimum chart width and contains horizontal scrolling inside that chart region. Do not shrink a dense analytical chart into an unreadable thumbnail merely to avoid scrolling, and do not allow the chart to create horizontal overflow on the page itself.

### 5. Page composition

Each workspace owns a small explicit trio where appropriate:

- HTML: semantic composition
- CSS: page-specific presentation
- JavaScript: API request, view-model transformation, rendering and interaction

Page modules do not own global typography, primary navigation, generic KPI/panel/table geometry or duplicated formatting utilities. Shared formatting, escaping and the `fetchJson()` interface live in `static/ui-utils.js`. `static/data-cache.js` owns only transport reuse: session-scoped JSON TTL caching and same-page in-flight request deduplication. Neither shared frontend utility may redefine accounting, reconciliation, attribution, catalog or inventory semantics.

The Sales workspace retains the existing `sales-canonical.js` filename because it is already the single live renderer; the historical filename does not imply another Sales runtime.

### 6. Data/API

Python endpoints own business definitions, reconciliation state and reusable server-side joins. Browser code must not independently redefine accounting, catalog hierarchy, attribution or inventory action semantics.

Repeated canonical payloads may be reused through the board response cache and browser session cache. Cache lifetime and invalidation policy are transport concerns; PostgreSQL remains authoritative. See [`reporting-cache-architecture.md`](reporting-cache-architecture.md).

## Accessibility contract

Every workspace has exactly one logical, non-empty `h1`. A heading may be visually hidden when the visual
composition already supplies equivalent orientation, but the semantic outline must remain complete. Visible
links require descriptive accessible names.

Use native buttons for independent choices. A visually active button in a named group must expose the same state
with `aria-pressed`; reserve `role="tablist"`, `role="tab"`, and `aria-selected` for controls that actually switch
tab panels and use the shared tab keyboard behavior. Financial row/column reports use native `table`, `caption`,
`th`, and `td` elements even when responsive CSS presents each row as a mobile card.

`qa/accessibility_qa.mjs` checks every primary workspace for heading and link-name invariants, a visible named
keyboard target, the named toggle-button groups, and Finance monthly-report table relationships. New primary
routes and new persistent interactive view controls must be added to that gate in the same change.

## Shareable analysis state

Persistent analytical choices are URL state, not session-only UI state. Sales owns `view` and `range`; its lazy
Geography renderer owns `geo_range`, `metric`, `sku`, and canonical two-digit `state`. Catalog owns `mode` and
`filter`. Default values are omitted, invalid values normalize to documented defaults, and unrelated parameters
are preserved. Changing a choice pushes browser history; direct load, refresh, Back, and Forward must render the
same state.

Session scroll/tab restoration is subordinate to the URL. `ui-shell.js` may restore saved context only when the
saved query string exactly matches the current query string. New stable tabs, filters, windows, or drill-down keys
must define their URL key and join `qa/analysis_state_qa.mjs` in the same change.

## Grid system

Use CSS Grid directly rather than a third-party grid framework. The product needs a small number of explicit responsive analytical compositions, not a generic 12-column marketing-site abstraction. Native Grid provides fewer dependencies, predictable min/max behavior and better control over tables, charts and variable-height decision panels.

## React decision gate

React/Vite is no longer blocked by cleanup debt, but it is also not currently justified by layout needs alone. Adopt it only if at least two of these become materially true:

1. multiple pages duplicate complex stateful component logic;
2. DOM/event lifecycle remains a recurring source of bugs;
3. shared components require substantial imperative synchronization;
4. route-level code splitting or richer client navigation becomes useful;
5. TypeScript component contracts materially improve data/view reliability.

If adopted, React should replace the existing page runtime coherently rather than appear as isolated islands inside otherwise imperative pages.

### UI revamp decision · 2026-08-28

The UI revamp retains native HTML, CSS Grid/Flexbox and ES modules. Visual templating, tokenized appearances, page recipes and shell composition do not materially meet the gate above. React/Vite/TypeScript would require a coherent replacement of all 11 served workspace runtimes plus their build, asset-release and QA contracts; isolated islands remain prohibited. That migration adds substantial scope and production risk without solving a presentation requirement the native architecture cannot meet. Reassess React only through a separate, evidence-backed application-complexity decision.

## Source ownership pattern

A workspace should be boring to inspect:

- one HTML file owns semantic composition;
- one page stylesheet owns page-specific presentation;
- one page runtime module owns data loading, view-model transformation and interaction;
- shared shell, layout, chart and formatting modules are imported explicitly;
- Docker does not inject CSS, JavaScript or page behavior;
- a second override stylesheet or post-render enhancer is a code smell, not an extension point.

The served workspaces now follow this model: Home, Today, Sales, Catalog, Product Workspace, Inventory, Finance, Trajectory, Ads, Data Health and Admin. Admin has one composition (`admin.html`), one page stylesheet (`admin.css`) and one runtime (`admin.js`); authentication, lifecycle membership, validation and persistence remain server-owned.

## Build boundary

Frontend dependencies are source-controlled. The Docker build no longer rewrites pages to inject stylesheets, scripts, tabs or enhancement layers. Its only HTML mutation is the visible deployment SHA in the footer.

At server startup, the complete static tree is hashed into one release manifest. The server attaches that revision to every page dependency and to transitive local CSS/JavaScript references, and injects the same revision into the HTML metadata and response headers. This transport transformation does not inject behavior or alter business logic. Fingerprinted responses are immutable; intentionally stable routes use validators.

This makes local/source behavior and deployed behavior materially easier to compare: what is reviewed in Git is what the browser loads in production, and one page cannot silently combine assets from different releases.

## Stylesheet ownership

The legacy `mobile-ux.css` and `design-refine.css` layers have been removed. Shared presentation behavior belongs only to `theme.css`, `nav-shell.css`, `layout-system.css`, `chart-system.css`, and the generated `presentation-profiles.css`. Each workspace then owns one page stylesheet; Sales additionally owns `sales-geography.css` for its lazy analytical view.

`scripts/frontend-contract.mjs` rejects undeclared stylesheet files as well as missing or misordered layers. Do not create another global “refine”, “override”, “v2”, “enhance”, or route-fragment stylesheet. Move a genuinely shared primitive to its existing shared owner; keep route-specific behavior in the owning page stylesheet.

## Lint and formatting policy

Lint and formatting serve different purposes and run separately.

`npm run lint` is the blocking code-quality gate. ESLint scans the complete application JavaScript tree and Stylelint scans the complete CSS tree. Stylelint intentionally does not enforce cosmetic conventions that conflict with the existing DOM/CSS vocabulary, such as camelCase legacy IDs, one-line declaration formatting, color-function spelling or media-range spelling. Those are formatting/migration concerns, not runtime defects.

`npm run format:check` is the blocking mechanical formatting audit for the consolidated frontend source tree.

New and migrated files should be readable and formatted when touched even before the repository-wide formatting gate becomes mandatory.

## Consolidation status

1. Lint/format tooling and shared utilities: **done**.
2. Source-controlled frontend dependencies; no Docker frontend injection: **done**.
3. Home, Sales and Inventory shared ownership model: **done**.
4. Catalog and Product Workspace: **done**.
5. Finance structural migration while preserving accounting semantics: **done**.
6. Trajectory structural migration: **done**.
7. Data Health control-tower composition: **done**.
8. Today extraction, responsive runtime and wall mode: **done**.
9. Ads consolidation, including Targets/Search Terms and elimination of duplicate `/api/ads` fetch/injected DOM: **done**.
10. Shared shell owns navigation, tab accessibility and mobile swipe behavior: **done**.
11. Superseded Finance frontend layers, Sales overrides, Home, Today, Ads and generic refinement layers: **removed**.
12. Legacy unused `index.html`: **removed**; `/`, `/home` and `/index.html` are served by canonical `home.html`.
13. Orphan Today layout/operations styles and the separate Data Health catalog-onboarding stylesheet: **removed/consolidated**.
14. Full frontend lint on the consolidated source tree: **required and green before review/deploy**.
15. Production visual regression review at desktop/mobile widths: **required before accepting the refactor**.
16. Optional analytical/product redesigns such as chart-form changes: **separate from this structural refactor**.

## Documentation boundary

Frontend architecture changes are incomplete unless documentation remains navigable without reverse-engineering the source tree.

In the same PR:

- update this file when shared ownership/framework rules change;
- update `maintenance.md` when a route or owning file changes;
- update `data-model.md` when the authoritative data definition changes;
- update `reporting-cache-architecture.md` when cache ownership, freshness or KPI-precomputation policy changes;
- update the root README if the product surface or repository map changes.

## Quality gate

A page is accepted only when:

- its source has one renderer/style owner;
- it composes shared primitives rather than recreating them;
- desktop and mobile production renders match the page brief;
- no horizontal page overflow occurs at supported widths; intentionally scrollable chart/table regions must contain their own overflow;
- empty/short/long content states are intentionally handled;
- technical QA is green;
- the route-wide accessibility and keyboard smoke is green;
- visual QA is manually compared against the business question, not merely checked for rendering success.
