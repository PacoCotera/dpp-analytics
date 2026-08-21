# Operating Board Frontend Architecture

## Decision

Use native HTML, CSS Grid/Flexbox and ES modules for the current consolidation. Do not add React, Bootstrap or Tailwind during this refactor.

The existing failure is not lack of a component framework. It is unclear ownership: inline page CSS/JS, multiple global override layers, post-render mutation scripts and Docker-time HTML rewriting. Adding React before removing those layers would create two frontend systems and make the transition harder to reason about.

React/Vite can be reconsidered after the consolidation if the remaining stateful workspaces still show meaningful duplication that a component runtime would remove.

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

Owns only application-wide orientation:

- brand
- primary navigation
- active destination state
- More menu
- workspace identity
- freshness/snapshot context
- footer/build SHA

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

These primitives are intentionally data-agnostic.

Variable-length content such as action queues must not share geometry with fixed KPI rails. KPI rails remain stable while action lists grow or disappear vertically.

### 4. Visualization system

The chart system owns:

- axes and tick typography
- semantic colors
- tooltips
- legends
- current/partial period treatment
- month/year boundaries
- empty/loading states
- supported chart forms

Pages choose the correct analytical chart but should not restyle chart primitives independently.

### 5. Page composition

Page modules own:

- business question and information architecture
- API request
- transformation of API payload into the page view model
- page-specific rendering and interactions

Page modules do not own global typography, primary navigation, generic KPI/panel/table geometry or duplicated formatting utilities.

### 6. Data/API

Python endpoints own business definitions, reconciliation state and reusable server-side joins. Browser code should not independently redefine accounting, catalog hierarchy, attribution or inventory action semantics.

## Grid system

Use CSS Grid directly rather than a third-party grid framework. The application needs a small number of explicit responsive compositions, not a 12-column marketing-site abstraction. Native Grid gives us fewer dependencies, predictable min/max behavior and better control over analytical tables and variable-height panels.

## React decision gate

Revisit React/Vite only after the legacy ownership layers are removed. Adopt it only if at least two of these remain true:

1. multiple pages duplicate complex stateful component logic;
2. DOM mutation/event lifecycle remains a recurring source of bugs;
3. shared components require substantial imperative synchronization;
4. route-level code splitting or richer client navigation becomes useful;
5. TypeScript component contracts materially improve data/view reliability.

If adopted, React replaces the existing page runtime rather than being injected into legacy pages as isolated islands.

## Source ownership pattern

A migrated page should be boring to inspect:

- one HTML file owns semantic composition;
- one page stylesheet owns only page-specific presentation;
- one page runtime module owns data loading, view-model transformation and interaction;
- shared shell, layout, chart and formatting modules are imported explicitly;
- Docker does not inject page-specific CSS or JavaScript;
- a second override stylesheet is a migration smell, not an extension point.

Current examples are Home, Sales, Inventory and Catalog.

## Lint and formatting policy

Lint and formatting serve different purposes and run separately.

`npm run lint` is the blocking code-quality gate. ESLint scans the complete application JavaScript tree and Stylelint scans the complete CSS tree. Stylelint intentionally does not enforce cosmetic conventions that conflict with the existing DOM/CSS vocabulary, such as camelCase legacy IDs, one-line declaration formatting, color-function spelling or media-range spelling. Those are formatting/migration concerns, not runtime defects.

`npm run format:check` reports Prettier drift. It remains available as the mechanical formatting audit while old style layers are progressively removed. Once the legacy global sheets are consolidated, formatting can become a required deployment gate without creating a repository-wide churn commit whose only purpose is whitespace.

New and migrated files should be readable and formatted when touched even before the repository-wide formatting gate becomes mandatory.

## Migration sequence

1. Add lint/format tooling and shared utilities. **Done.**
2. Serve source-controlled frontend assets directly and remove Docker HTML mutation. **In progress; page-specific injection is removed for migrated pages.**
3. Migrate Home, Sales and Inventory to shared page/layout primitives. **Done.**
4. Migrate Catalog/Products and Product Workspace. **Catalog done; Product Workspace remains.**
5. Migrate Finance and replace grouped-bar pseudo-waterfall with a true waterfall.
6. Migrate Trajectory and remove editorial over-explanation.
7. Rebuild Data Health as a control-tower composition using the same shell/primitives.
8. Migrate Ads when that product workstream resumes.
9. Delete superseded CSS/JS layers.
10. Turn lint and, after legacy formatting cleanup, format checks into required deployment gates.

## Quality gate

A page is accepted only when:

- its source has one renderer/style owner;
- it composes shared primitives rather than recreating them;
- desktop and mobile production renders match the page brief;
- no horizontal page overflow occurs at supported widths;
- empty/short/long content states are intentionally handled;
- technical QA is green;
- visual QA is manually compared against the business question, not merely checked for rendering success.
