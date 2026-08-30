# DPP Analytics production UI/UX interaction audit

**Date:** 2026-08-29  
**Status:** Replacement for the earlier shallow route-only audit  
**Production URL:** `http://95.217.100.5:8088/`  
**Production source:** `22dc9c44e76a698e9f446d2ca3335d92e8b36fbe`  
**Footer build shown in production:** `main 22dc9c44`  
**Observed static asset revision:** `a95447870706`

## Executive verdict

The current production UI is not ready to be considered visually or interactively corrected.

The earlier audit inspected routes but did not sufficiently inspect control states. That was a material testing failure. The production interaction pass found:

1. A **false YTD control** on Today. The selected state and subtitle change, but the chart remains the trailing 30-day dataset.
2. A **catastrophically broken mobile Sales Geography view** caused by a CSS specificity conflict and an incompatible table minimum width hidden inside an overflow-clipped workspace.
3. Multiple **time-window-induced layout jumps**, including 34 px in Sales Overview and 67 px in Finance at a 360 CSS-pixel viewport.
4. **Inconsistent time vocabulary and semantics** within the same Sales workflow: `FULL`, `12M`, `YTD`, `90D`, `28D`, fixed `28D`, then `30D`, `90D`, `YTD`, `ALL`.
5. A confirmed **zero-gutter panel regression** in Business Health, caused by a page rule overriding the shared surface padding later in the cascade.
6. Mobile charts that render data but are not legible, especially Finance and Trajectory.
7. Information loss and excessive vertical expansion on several mobile routes.
8. A CSS architecture that permits page styles to redefine shared primitives and silently override themselves.

No browser console exception or failed production request explained these problems. They are rendered-state, data-contract, component, and CSS-cascade defects.

## Finding provenance

The audit must not present confirmation of a reported problem as original discovery. The distinction is:

### Problems reported by the user and confirmed by this audit

| Reported concern | Production confirmation | Added diagnostic value |
|---|---|---|
| Business Health has almost no inset | Confirmed in the supplied Android capture and affected production breakpoints | Traced to `.home-health` overriding `.home-surface` from 18 px to 2 px through equal specificity and later source order |
| Time selectors resize their containers | Confirmed across Business, Sales, Finance, Geography, and Trajectory | Measured every state and isolated changes from 18.89 px to 67 px |
| Window labels and behavior are inconsistent | Confirmed across Today, Sales, Geography, Product, Finance, and Trajectory | Produced the complete vocabulary/semantics matrix and separated duration, calendar period, metric, and chart mode |
| Some selectors do not update their chart | Confirmed specifically on Today YTD | Proved selected state and subtitle changed while first date, last date, mark count, and `$18,938` total remained identical to 30D; traced the API/renderer fall-through |

### Independently discovered production findings

| Priority | Independent finding | Why it matters | Recommendation |
|---|---|---|---|
| P0 | Sales Geography collapses into clipped single-character columns on mobile | The complete analytical surface is unusable, not merely unattractive | Remove the ID-specific grid rule, stack panels, and provide one explicit keyboard-accessible table scroller or mobile list |
| P0 | Finance YTD/12M chart labels overlap until months, values, OPEN/PROVISIONAL, and totals cannot be associated | A rendered chart that cannot be read is false usability | Budget annotations from actual plot width; move detail to focus/tap and separate single-month mode from duration |
| P1 | Finance shows negative contribution `-$17,935` in a positive green surface | Color communicates the opposite business meaning | Use neutral accounting surfaces and reserve positive/negative color for the actual signed result |
| P1 | Product mobile removes the “Accelerating” Product Health explanation that desktop provides | Responsive behavior deletes decision context | Preserve the explanation in compact form or a disclosure; do not use viewport width as an information-permission boundary |
| P1 | Catalog mobile compresses three metrics until labels clip and values wrap over four or five lines | Product comparison becomes slower than opening individual records | Recompose metrics into one or two columns with stable label/value association |
| P1 | Inventory turns eight records into a multi-thousand-pixel mobile stack | Operational triage and comparison become inefficient | Use scan-first rows with progressive detail and keep action/status visible in the collapsed state |
| P1 | Data Health expands every healthy job into a multi-thousand-pixel page while `Problems only` does not clearly describe current filter state | Healthy state becomes harder to operate than an incident state | Keep all jobs reachable but collapse healthy detail; make filter state explicit and preserve row actions |
| P1 | Ads disconnected state repeats the same explanation, provides no recovery action, and leaves most of the page empty | The user reaches a dead end with no next valid action | Provide one API-owned status explanation and the valid connect/retry/admin action when available |
| P1 | Today merges `$279` and `100% of shopper spend` into `$279100% of shopper spend` | Two measures become one misleading string | Use separate value/share elements with spacing and programmatic labels |
| P2 | Catalog desktop truncates the selected sort to `Attention firs` | The active ordering is ambiguous | Allow the control to size to its selected option or use a compact unambiguous label |
| P2 | Inventory renders `PLAN` as a large round badge in one place and a narrow pill beside `OK`/`HOLD` elsewhere | Same state appears to have different severity and interaction meaning | Define one status component with size variants that preserve shape and semantics |
| P2 | Trajectory mobile displays `+8.3%` without its complete contextual label and clips the portfolio label | The user must infer what the percentage compares | Keep label/value together and move secondary explanation below, not out of the layout |
| P2 | Build, accounting, and source metadata dominate the mobile footer | Operational metadata competes with decisions and dramatically extends pages | Collapse build diagnostics behind a low-prominence disclosure outside the primary reading flow |
| P2 | Admin lacks password visibility and its footer floats above a large empty region | Sign-in is less usable and the short-page composition looks unfinished | Add an accessible show/hide control and anchor short-page footer behavior |
| Architecture | Page CSS redefines `.chip`, `.subnav`, and `.btn`; route CSS loads after shared layers; an ID selector defeated its own media query | Fixes can silently undo shared components and responsive behavior | Establish component ownership and cascade layers; ban ID-qualified layout rules and primitive redefinition |

These findings came from route and state screenshots, direct interaction, computed layout measurements, and source tracing. They were not supplied as examples by the user.

## Method and evidence standard

This audit used the production application directly through the DPP Playwright browser. It did not use a local render, screenshot proxy, or source-only inference.

For each route and interactive state, the audit checked:

- the live rendered screen;
- the selected control state;
- the visible title/subtitle and KPI changes;
- chart mark count and/or displayed values;
- container and SVG dimensions;
- text clipping, overlap, wrapping, and overflow;
- console and network results;
- the exact production source only after the rendered defect was reproduced.

Desktop routes were captured directly. Responsive captures used the live production document at a 360 CSS-pixel layout viewport in the DPP Chromium browser. The application DOM and CSS inside that viewport were not rewritten. The supplied Android screenshot independently confirms the Business Health spacing failure on a real handset. The currently exposed DPP integration is Chromium-only, so WebKit/iPhone remains a required final acceptance run, not a completed claim in this report.

## Production coverage

### Routes inspected visually

| Route/view | Desktop | 360 px | Interactive states exercised |
|---|---:|---:|---|
| Today `/` | Yes | Yes | `7D`, `MTD`, `30D`, `YTD` |
| Business `/business` | Yes | Yes | `28D`, `90D`, `YTD`; all six visual profiles on desktop |
| Sales Overview `/sales` | Yes | Yes | `FULL`, `12M`, `YTD`, `90D`, `28D` |
| Sales Drivers `/sales?view=products` | Yes | Yes | Fixed 28-day view |
| Sales Geography `/sales?view=geography` | Yes | Yes | `30D`, `90D`, `YTD`, `ALL`; metric changed to Orders |
| Catalog `/catalog` | Yes | Yes | Default portfolio state |
| Product `/product?sku=PNC-001` | Yes | Yes | Money/Units; `28D`, `90D`, `YTD` |
| Inventory `/inventory` | Yes | Yes | Queue and record-list states |
| Finance `/finance` | Yes | Yes | Month, `3M`, `YTD`, `12M`, Last year, All; COGS toggle |
| Ads `/ads` | Yes | Yes | Disconnected state |
| Trajectory `/trajectory` | Yes | Yes | `90D`, `180D`, `YTD` |
| Data Health `/data-health` | Yes | Yes | Default healthy state |
| Admin `/admin` | Yes | Not completed | Desktop form; route refused embedded responsive framing |

## Time-window interaction matrix

These measurements are from the live production UI after clicking each selector.

| Surface | Selector | Render result | Responsive container | Finding |
|---|---|---|---:|---|
| Today | `7D` | 7 bars | 330 × 612.33 | Correct |
| Today | `MTD` | 29 bars | 330 × 612.33 | Correct for Aug 29 |
| Today | `30D` | 30 bars | 330 × 612.33 | Correct |
| Today | `YTD` | **30 bars, same August data and $18,938 total as 30D** | 330 × 612.33 | **False control state** |
| Business | `28D` | 28 bars | 330 × 496.97 | Data updates |
| Business | `90D` | 91 bars | 330 × 515.86 | **18.89 px height jump** |
| Business | `YTD` | 240 bars | 330 × 496.97 | Data updates |
| Sales Overview | `FULL` | 12 monthly bars | 330 × 676.03 | Currently identical data to 12M |
| Sales Overview | `12M` | 12 monthly bars | 330 × 676.03 | Currently identical data to FULL |
| Sales Overview | `YTD` | 10 monthly bars | 330 × 642.44 | **33.59 px height jump** |
| Sales Overview | `90D` | 15 weekly bars | 330 × 676.03 | Data updates |
| Sales Overview | `28D` | 28 daily bars | 330 × 676.03 | Data updates |
| Sales Drivers | fixed `28D` | No window control | N/A | Inconsistent with adjacent Sales views |
| Sales Geography | `30D` | $18,320, 62 orders, 65 units, 17 rows | Desktop height 1104.8 | Data updates |
| Sales Geography | `90D` | $44,961, 173 orders, 197 units, 20 rows | Desktop height 1132.8 | **28 px height jump** |
| Sales Geography | `YTD` | $83,996, 339 orders, 381 units, 20 rows | Desktop height 1132.8 | Data updates |
| Sales Geography | `ALL` | $91,408, 368 orders, 421 units, 20 rows | Desktop height 1132.8 | Data updates |
| Product | `28D` | 28 bars | Stable, 330 px wide | Correct |
| Product | `90D` | 90 bars | Stable, 330 px wide | Correct |
| Product | `YTD` | 240 bars | Stable, 330 px wide | Correct |
| Finance | Month | 5 chart rectangles; month picker added | 330 × 644.63 | **Mode change inside window control** |
| Finance | `3M` | 7 rectangles | 330 × 619.94 | Labels dense |
| Finance | `YTD` | 17 rectangles | 330 × 619.94 | **Labels overlap** |
| Finance | `12M` | 21 rectangles | 330 × 640.94 | **Labels overlap; same available data as All** |
| Finance | Last year | 5 rectangles | 330 × 577.63 | Largest shrink |
| Finance | All | 21 rectangles | 330 × 619.94 | Same available data as 12M |
| Trajectory | `90D` | 90 daily bars | 330 × 432.58 | Correct |
| Trajectory | `180D` | 27 weekly bars | 330 × 451.47 | **18.89 px jump and x-label collision** |
| Trajectory | `YTD` | 35 weekly bars | 330 × 451.47 | **x-label collision** |

### Conclusions from the selector pass

- The user's observation is correct: clicking selectors resizes several containers.
- Some changes are data-driven wrapping, but the resulting page movement is still a component defect. The header, summary, and plot regions lack a stable layout contract.
- `Month` is a chart mode, not simply a duration. Adding a second picker only in that state guarantees movement.
- `FULL` versus `ALL`, `28D` versus `30D`, and `Last year` versus compact codes are inconsistent vocabulary.
- `FULL` and `12M` in Sales, and `12M` and `All` in Finance, are currently visually redundant because the available history does not exceed 12 months.
- A selected pill is not proof that the associated data changed. Today demonstrates why QA must assert the rendered data signature after every click.

## Critical defect register

### P0-1: Sales Geography is unusable on mobile

**Observed rendering**

- KPI labels and values truncate.
- The metric selector truncates to `Shopper spe`.
- The map/table workspace collapses into narrow vertical fragments.
- Table content becomes single-character columns along the left edge.
- `Show All` is clipped.
- Geography metrics are not usable.

**Root cause**

`board/static/sales-geography.css` defines the production grid with a high-specificity selector:

```css
#geography .geo-grid {
  grid-template-columns: minmax(0, 1.35fr) minmax(390px, 0.65fr);
}
```

The responsive rule later uses only `.geo-grid`, so it cannot override the ID-qualified declaration. The same page also applies `min-width: 640px` to the table while `.geography-workspace` hides overflow. These rules combine to make the content both too wide and inaccessible.

**Guidelines breached**

- WCAG 1.4.10 Reflow
- WCAG 1.3.1 Info and Relationships
- Nielsen: visibility of system status and minimalist design
- Internal responsive contract: no unintended horizontal clipping at supported widths

**Required correction**

- Remove the ID-qualified layout selector.
- Give the responsive rule equal ownership and specificity.
- Remove the fixed 640 px table assumption on mobile.
- Present geography rows as a compact mobile list or provide an explicit, visible horizontal-scroll region.
- Add `scrollWidth <= clientWidth` and screenshot assertions for the full Geography workspace.

### P0-2: Today YTD is a false interactive state

**Observed rendering**

Selecting `YTD` changes the active pill and subtitle to “2026 year to date,” but the chart remains the same 30 August bars and `$18,938` total as `30D`.

**Root cause**

`board/static/today.js:344-350` requests `data.daily_history` for YTD, falls back to `recent_daily`, then falls through to `rows.slice(-30)`. The Today API does not supply the expected `daily_history` field.

**Guidelines breached**

- Nielsen: match between the system and the real world
- Nielsen: visibility of system status
- Nielsen: error prevention
- WCAG 3.2.4 Consistent Identification, applied to control behavior

**Required correction**

- Define one API contract for all Today periods.
- Return the true YTD series or remove/disable YTD until it exists.
- Test selected state, subtitle, range endpoints, mark count, and aggregate together.

### P0-3: Finance mobile chart is rendered but illegible

**Observed rendering**

- Month names run together: `Jan2026Feb2026...`.
- `OPEN`, `PROVISIONAL`, and Window total collide.
- YTD and 12M values cannot be reliably associated with their bars.
- Selector changes cause a 67 px height swing.

**Root cause**

`board/static/finance.js` calculates every slot from the available inner width but still renders every month, every value, status labels, and two-line labels. At roughly 302 px of usable plot width, slots can be about 26 px while their labels require substantially more. No width-aware label budget or collision test exists.

**Guidelines breached**

- WCAG 1.4.10 Reflow
- WCAG 1.4.12 Text Spacing
- WCAG 1.3.1 Info and Relationships
- Nielsen: recognition rather than recall

**Required correction**

- Separate chart mode from time window: `Single month` versus `Trend`, then choose the duration.
- Add a width-aware tick and annotation budget.
- At narrow widths, reduce labels, provide detail on focus/tap, or use a deliberate horizontal-scroll chart with an affordance.
- Reserve stable control, summary, and plot regions.

### P1-1: Business Health loses its panel gutter

**Observed rendering**

The Business Health content and child cards sit almost against the parent boundary in the supplied Android production screenshot. The same problem is visible at production widths where the narrow-screen rescue rule is not active.

**Root cause**

The same element has `home-health home-surface`. `board/static/home.css:110` assigns shared surface padding, but `board/static/home.css:371` later assigns `.home-health { padding: 24px 2px 0; }`. Equal specificity plus later source order destroys the surface gutter. A max-480 rule happens to restore `.home-surface { padding: 14px; }` only on narrower screens.

**Guidelines breached**

- Gestalt proximity and common-region principles
- WCAG 1.4.10 Reflow, because usable spacing changes unpredictably by breakpoint
- Internal spacing contract: panels retain the standard inset at every supported width

**Required correction**

- `.home-health` must not own the outer surface padding.
- Use a dedicated inner layout wrapper for section-specific spacing.
- Create one tokenized panel inset and assert its computed value at mobile, tablet, and desktop widths.

### P1-2: Time controls lack a common vocabulary and component contract

The application uses:

- `FULL` and `ALL` for the same concept;
- `28D` and `30D` within adjacent Sales views;
- fixed 28D with no control on Drivers;
- `Last year` mixed with abbreviated codes;
- `Month`, which changes the interaction mode, inside a duration selector;
- `12M` choices that currently duplicate the complete dataset.

This raises cognitive load and makes comparisons across dashboards unreliable.

**Required language model**

| Concept | Canonical label | Rule |
|---|---|---|
| Rolling days | `7D`, `28D`, `30D`, `90D`, `180D` | Use the domain-required duration consistently; do not alternate 28D/30D without a stated reason |
| Calendar-to-date | `MTD`, `YTD` | Must use calendar boundaries and show them in subtitle/tooltip |
| Rolling months | `12M` | Use only when it differs from all available history |
| Complete history | `All history` | One label everywhere; avoid `FULL`/`ALL` variants |
| Prior calendar year | `2025` or `Previous year` | Prefer the exact year where space allows |
| Chart mode | `Single month`, `Trend` | Separate from duration controls |
| Metric | Money, Units, Orders, Spend | Separate control group and consistent visual style |

### P1-3: Layout stability is not treated as a component requirement

Confirmed changes include:

- Business: 18.89 px
- Sales Overview: 33.59 px
- Sales Geography: 28 px on desktop
- Finance: 67 px on mobile
- Trajectory: 18.89 px

These jumps move adjacent content when the user is comparing periods. The repeated cause is content-driven component height without reserved header/subtitle/legend areas.

**Required correction**

- Define fixed or minimum regions for selector, title, subtitle, KPI, legend, plot, and annotation bands.
- Do not solve this by clipping text. Use predictable wrapping, responsive copy, or explicit disclosure.
- Assert a maximum 2 px container-height delta between duration states unless the control intentionally changes mode and the change is documented.

### P1-4: CSS ownership and cascade are not controlled

The authored CSS contains approximately 14,281 lines and 31 `!important` declarations. Exact selector strings are repeatedly defined hundreds of times, including valid media-query variants, but there is no cascade-layer model to express ownership.

Concrete conflicts include:

- `.home-health` overriding `.home-surface` padding;
- the ID-qualified Geography grid defeating its responsive override;
- `product.css` redefining `.chip`;
- `sales.css` and `ads.css` redefining `.subnav`;
- `data-health.css` redefining `.btn`;
- page CSS loading after shared shell/component CSS, allowing silent primitive overrides.

**Required correction**

- Establish cascade layers such as `reset`, `tokens`, `shell`, `components`, `pages`, `profiles`, with profiles restricted to tokens.
- Shared primitives must have one owner. Route CSS may compose or modify a named variant, not redefine `.btn`, `.chip`, or `.subnav`.
- Ban ID-qualified layout selectors.
- Lint duplicate primitive definitions and breakpoint overrides with lower specificity than their base declaration.
- Replace incidental source-order fixes with explicit variants and custom properties.

## Route-level UI/UX findings

### Today

- **Critical:** YTD is false, as documented above.
- `$279100% of shopper spend` visually merges two distinct values.
- Repeated Definition pills add control noise without a clear disclosure hierarchy.
- Mobile metrics, chart, and build footer are too dense.
- Selected-state styling communicates confidence even when the underlying data did not change.

### Business

- Business Health outer inset is overridden to 2 px at affected widths.
- KPI notes truncate on desktop.
- The single inventory decision occupies a large, underused surface.
- On mobile, the decision count `1` detaches onto its own line.
- Chart cards reserve substantial dead vertical space while explanatory text wraps.
- All six themes inherit the structural spacing defect; this is not a theme-specific bug.

### Sales Overview and Drivers

- Sales Overview changes height when YTD is selected.
- `FULL` and `12M` currently show the same data.
- The selected sub-navigation treatment is not visually aligned with selector pills or global navigation.
- Mobile gives a large area to a relatively small plot while supporting summaries follow below.
- Drivers silently fixes the period at 28D, unlike its adjacent tabs.

### Sales Geography

- Mobile view is unusable due to cascade and overflow defects.
- Geography changes Sales vocabulary from 28D/FULL to 30D/ALL.
- The metric selector correctly changed the URL and map color state when changed from Shopper spend to Orders.
- The table remained ordered by Spend because sorting is a separate control; this is valid but needs clearer control grouping.

### Catalog

- Desktop sort text truncates to `Attention firs`.
- The desktop portfolio state leaves an oversized blank region.
- Mobile `CONVERSI...` metric text clips.
- Three metric columns are too narrow, causing values and labels to wrap across four or five lines.
- Filter, mode, and status pills create a control-density problem without clear hierarchy.

### Product

- Metric and window controls update correctly and remain dimensionally stable.
- Desktop Product Health and Definition areas expose raw-looking source detail with weak hierarchy.
- Mobile omits the Product Health “Accelerating” explanation shown on desktop, creating information loss rather than responsive prioritization.
- Mobile View arrows wrap away from their labels.

### Inventory

- The action queue leaves excessive empty desktop space.
- Mobile turns eight records into a multi-thousand-pixel linear stack, making comparison and scanning inefficient.
- `PLAN` appears as a large circular badge in one context but as a thin pill beside `OK` and `HOLD` elsewhere.
- The current implementation transforms one DOM table into cards; the earlier suggestion that it used separate renderers was incorrect and is withdrawn.

### Finance

- Mobile chart labels collide and period changes are unstable.
- A negative contribution value, `-$17,935`, appears in a green-background card, contradicting its semantic state.
- The accounting state loses contextual heading information on mobile.
- COGS included/excluded correctly recalculates values, but its toggle styling does not match other binary controls.

### Ads

- The disconnected state repeats its message.
- It offers no primary recovery or connection action.
- The page leaves a large empty area, so the state feels unfinished rather than deliberately empty.

### Trajectory

- Desktop hero metric subtitle clips.
- Mobile presents `+8.3%` without its full contextual label.
- The portfolio label clips and wraps poorly.
- The chart always targets up to eight weekly labels. At roughly 316 px this exceeds the available label budget, causing collision for 180D and YTD.

### Data Health

- `Problems only` is styled as an action while healthy jobs remain visible; the current state and result are unclear.
- Mobile fully expands job detail into a very long page instead of supporting scanning and drill-down.
- A green `0` appears without an immediate `exceptions` label, weakening comprehension.

### Admin

- The password field has no visibility control.
- The footer sits mid-page with a large blank region below it.
- Responsive verification is still required in the standalone parameterized device runner.

## Cross-product information architecture and component findings

### Navigation

- Global navigation, Sales sub-navigation, page tabs, selectors, disclosure links, and definition pills do not share a coherent interaction grammar.
- Active navigation and active data filters are too visually similar in some places and unrelated in others.
- Mobile page order often mirrors desktop source order rather than user task priority.

### Buttons, links, selectors, and disclosures

- `Definition`, `View`, `Hide`, and `Show` controls use inconsistent treatments and arrow placement.
- Native selects, segmented pills, text links, and button-like chips have inconsistent heights, radii, spacing, capitalization, and selected states.
- Some controls reveal content; some navigate; some filter data; visual style does not reliably distinguish those actions.
- WCAG 2.5.8 Target Size should be explicitly tested. Visual inspection shows several compact text controls that are unlikely to maintain a 24 × 24 CSS-pixel target without invisible hit-area expansion.

### Typography and density

- Uppercase eyebrow labels are overused and sometimes clip at mobile widths.
- Secondary copy frequently competes with chart labels and build metadata.
- Numeric metrics do not always preserve label/value association after wrapping.
- The production footer exposes currency/accounting/build notes with excessive prominence on narrow screens.

### Empty and operational states

- Ads disconnected state lacks a recovery path.
- Inventory and Data Health optimize for showing every detail, not for operational triage.
- Catalog and Inventory leave large desktop areas visually unused while mobile becomes excessively long.

## Missing or breached design and accessibility requirements

| Requirement | Current failure | Acceptance condition |
|---|---|---|
| WCAG 1.3.1 Info and Relationships | Wrapped or clipped metrics lose label/value association | Labels, values, legends, and states remain programmatically and visually associated |
| WCAG 1.4.10 Reflow | Geography clips; charts and tables exceed usable mobile layout | No two-dimensional scrolling or hidden content at 320 CSS px except intentional data regions with affordance |
| WCAG 1.4.11 Non-text Contrast | Control boundaries and states vary by theme | Controls and state indicators retain 3:1 contrast against adjacent colors |
| WCAG 1.4.12 Text Spacing | Finance labels collide and cannot tolerate spacing changes | No loss of content/function under required text-spacing overrides |
| WCAG 2.4.6 Headings and Labels | Abbreviations and contextless metrics weaken meaning | Controls and metrics have clear, consistent labels |
| WCAG 2.5.8 Target Size | Compact chips/links lack a documented target contract | Every interactive target is at least 24 × 24 CSS px or meets an exception |
| WCAG 3.2.4 Consistent Identification | Same concepts use FULL/ALL and different component styles | Same function has the same name and visual treatment across routes |
| Nielsen: system status | Today shows YTD selected without YTD data | Visible state, data, subtitle, and URL agree after every action |
| Nielsen: consistency and standards | Time vocabulary and controls change by page | One application-wide date/metric control grammar |
| Nielsen: error prevention | Unsupported data states are selectable | Unsupported/redundant options are disabled, hidden, or explained |
| Layout stability | Selector clicks move surrounding content | Period-state height delta is no more than 2 px unless a documented mode changes |
| Responsive chart legibility | Fixed label counts collide on narrow plots | Tick count and annotation density are computed from actual width |
| Component ownership | Page styles redefine primitives | One owner per primitive; page-specific variants are explicit |

## Improvement batches

### Batch 1: Stop false and unusable states

1. Fix Today YTD data contract and test the rendered range.
2. Repair Sales Geography specificity, table layout, and mobile composition.
3. Redesign Finance narrow-screen label strategy.
4. Fix Business Health panel inset at every breakpoint.

**Release gate:** all four defects have production screenshots and automated interaction assertions.

### Batch 2: Normalize time, metric, and mode controls

1. Adopt the canonical vocabulary in this report.
2. Separate Finance chart mode from duration.
3. Resolve 28D/30D differences within Sales or clearly explain the business reason.
4. Hide or explain redundant full-history options when they return the same range.
5. Use a shared segmented-control component with consistent target size, height, spacing, focus, selected, hover, and disabled states.

### Batch 3: Stabilize chart and card geometry

1. Introduce component regions for controls, summary, plot, legend, and annotation.
2. Add width-aware tick budgets to the shared chart system and Finance.
3. Prevent text wrapping from resizing the outer card between comparable period states.
4. Fix semantic color use for negative Finance outcomes.

### Batch 4: Correct mobile information architecture

1. Replace Geography's desktop table assumption with a mobile-native list or explicit data scroller.
2. Make Inventory and Data Health scan-first with progressive disclosure.
3. Preserve Product Health meaning instead of omitting it.
4. Recompose Catalog metrics for one- or two-column mobile reading.
5. Reduce footer/build prominence and keep decision content above operational metadata.

### Batch 5: Repair the CSS architecture

1. Add explicit cascade layers.
2. Move shared primitive definitions to one component owner.
3. Remove ID-qualified layout selectors.
4. Replace source-order overrides with explicit variants.
5. Add lint checks for primitive redefinition and lower-specificity responsive overrides.
6. Add computed-style regression tests for spacing tokens.

### Batch 6: Interaction-first visual regression coverage

The current route/profile screenshot coverage is insufficient because it can pass while hidden tabs and selected states are broken.

For every visible selector in every route and subview, automated acceptance must:

1. click the control;
2. assert its active state;
3. assert URL/state persistence where applicable;
4. assert the range endpoints and rendered data signature;
5. assert the summary/KPI aggregate;
6. assert container-height delta;
7. assert no SVG text bounding-box intersections;
8. assert no unintended overflow;
9. capture a screenshot of the resulting state.

Required viewports:

- 1440 px desktop Chromium
- 768 px tablet Chromium
- 393 px Android/Chromium
- 390 px iPhone/WebKit

Required hidden states include Sales Drivers, Sales Geography, every Finance period/mode, Product metric/range, all disclosure states, empty/disconnected states, and at least one long-content dataset.

## Definition of done for the corrective work

The batch is not complete when default routes look acceptable. It is complete only when:

- every selector changes the intended data or is unavailable with an explanation;
- date labels use the same vocabulary and semantics across comparable surfaces;
- no comparable selector state changes its container by more than 2 px;
- no chart label overlaps another label or leaves its visible plot bounds;
- no supported viewport hides non-optional content;
- shared panels keep their tokenized inset at all breakpoints;
- controls meet target-size, contrast, focus, and keyboard requirements;
- route CSS does not redefine shared primitives;
- production screenshots from the deployed SHA pass the full interaction matrix;
- Chromium Android and WebKit iPhone checks both pass.

## Correction to the earlier audit

The prior report's default-route screenshot pass was not deep enough to support its conclusions. It missed interaction states, selector-driven geometry, hidden Sales views, and the cascade failure demonstrated by Business Health and Geography. Its claim that Inventory used separate desktop/mobile renderers is also withdrawn: the current production implementation transforms a single DOM table into the responsive card presentation.

This report supersedes those conclusions and should be used as the scope and acceptance contract for the next corrective batch.
