# Operating Board Frontend Architecture

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
- supported chart forms

Pages choose the correct analytical chart but should not independently recreate generic chart primitives.

### 5. Page composition

Each workspace owns a small explicit trio where appropriate:

- HTML: semantic composition
- CSS: page-specific presentation
- JavaScript: API request, view-model transformation, rendering and interaction

Page modules do not own global typography, primary navigation, generic KPI/panel/table geometry or duplicated formatting utilities. Shared formatting, escaping and fetch behavior lives in `static/ui-utils.js`.

The Sales workspace retains the existing `sales-canonical.js` filename for this refactor because it is already the single live renderer; filename normalization is not worth mixing into the behavioral migration.

### 6. Data/API

Python endpoints own business definitions, reconciliation state and reusable server-side joins. Browser code must not independently redefine accounting, catalog hierarchy, attribution or inventory action semantics.

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

## Source ownership pattern

A workspace should be boring to inspect:

- one HTML file owns semantic composition;
- one page stylesheet owns page-specific presentation;
- one page runtime module owns data loading, view-model transformation and interaction;
- shared shell, layout, chart and formatting modules are imported explicitly;
- Docker does not inject CSS, JavaScript or page behavior;
- a second override stylesheet or post-render enhancer is a code smell, not an extension point.

The served workspaces now follow this model: Home, Today, Sales, Catalog, Product Workspace, Inventory, Finance, Trajectory, Ads and Data Health.

## Build boundary

Frontend dependencies are source-controlled. The Docker build no longer rewrites pages to inject stylesheets, scripts, tabs or enhancement layers. Its only HTML mutation is the visible deployment SHA in the footer.

This makes local/source behavior and deployed behavior materially easier to compare: what is reviewed in Git is what the browser loads in production.

## Lint and formatting policy

Lint and formatting serve different purposes and run separately.

`npm run lint` is the blocking code-quality gate. ESLint scans the complete application JavaScript tree and Stylelint scans the complete CSS tree. Stylelint intentionally does not enforce cosmetic conventions that conflict with the existing DOM/CSS vocabulary, such as camelCase legacy IDs, one-line declaration formatting, color-function spelling or media-range spelling. Those are formatting/migration concerns, not runtime defects.

`npm run format:check` reports Prettier drift. It remains available as the mechanical formatting audit while the shared legacy foundation sheets are progressively normalized. Once those remaining global sheets are formatted deliberately, formatting can become a required deployment gate without a large whitespace-only churn commit.

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
11. Superseded Finance, Sales, Home, Today, Ads and generic refinement layers: **removed**.
12. Legacy unused `index.html`: **removed**; `/`, `/home` and `/index.html` are served by canonical `home.html`.
13. Production visual regression review at desktop/mobile widths: **required before accepting the refactor**.
14. Optional analytical/product redesigns such as chart-form changes: **separate from this structural refactor**.

## Quality gate

A page is accepted only when:

- its source has one renderer/style owner;
- it composes shared primitives rather than recreating them;
- desktop and mobile production renders match the page brief;
- no horizontal page overflow occurs at supported widths;
- empty/short/long content states are intentionally handled;
- technical QA is green;
- visual QA is manually compared against the business question, not merely checked for rendering success.
