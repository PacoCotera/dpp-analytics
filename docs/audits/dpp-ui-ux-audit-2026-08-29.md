# DPP Analytics UI/UX and CSS Architecture Audit

**Audit date:** 2026-08-29  
**Production target:** `http://95.217.100.5:8088/`  
**Production build:** `main 2a61a768`  
**Production asset revision:** `1b7619bca5be`  
**Repository commit reviewed:** `2a61a768c9296489743cb38bb945a277afab607f`

## Executive judgment

DPP Analytics is no longer structurally broken. The shared desktop sidebar, mobile drawer, appearance chooser, route ownership contract, presentation registry, and quality checks are substantial strengths. Every audited route loaded, page-level horizontal overflow was absent at the tested mobile widths, and the navigation mechanics were keyboard-usable.

The product still feels like a collection of separately compressed workspaces rather than one deliberately composed operating system. The largest problem is not color or decoration; it is hierarchy and density. On mobile, introductory copy, provenance, KPI blocks, and bordered summaries frequently consume the entire first viewport before the user reaches the chart, table, or action queue. Products, Sales, Inventory, and Data Health are the clearest examples.

The CSS architecture is cleaner between files than it is inside files. The canonical load order is enforced and the retired generic override stylesheets are gone, but eight route stylesheets retain an older composition and append a late “Corrected ... recipe” block. Sales adds another “Connected ... workspace” pass after that. This produces a controlled cascade, not a chaotic one, but it still relies on later, more-qualified selectors to undo earlier declarations. The visible 10–12 px labels, 24–38 px controls, and route-specific geometry drift are direct consequences.

**Recommended decision:** make the next improvement batch a foundation-and-mobile-density batch. Do not begin with more theme polish. First enforce a real rendered component contract, replace appended correction layers with one canonical rule per component/state, and move each route's dominant decision surface into the first useful mobile viewport.

## Scope and method

The audit used the standalone Playwright DPP deployment against production, plus a source-level review of the exact production commit.

### Routes

- Today: `/`
- Business: `/business`
- Sales: `/sales`
- Products: `/catalog`
- Product: `/product?sku=PNC-001`
- Inventory: `/inventory`
- Finance: `/finance`
- Ads: `/ads`
- Trajectory: `/trajectory`
- Data Health: `/data-health`
- Admin: `/admin`

### Browser and presentation coverage

- Chromium desktop: full route sweep at 1440 × 1200.
- WebKit mobile: full route sweep at 390 × 664, DPR 3.
- Chromium mobile: representative high-density routes at 393 × 727, DPR 2.75.
- WebKit desktop: representative comparison on Business and Products.
- All six presentation profiles were visually compared on Business: Warm Studio, Midnight & Saffron, Aubergine & Aqua, Midnight Dark, Aubergine Dark, and Weyland.
- Mobile drawer open/close, Escape behavior, focus return, current-route state, body scroll lock, and the Appearance chooser were exercised.
- Console and response logs were sampled across the audited sessions. No reproducible application-owned JavaScript errors or failed HTTP responses were found. Chromium did emit a password-manager warning on Admin because the password form has no username field.

This is a visual, interaction, semantic-markup, and CSS-architecture audit. It is not a complete assistive-technology certification, load/performance test, authenticated Admin workflow test, or Ads-connected-state audit.

## What is working

1. **The shell is coherent.** Desktop navigation stays in a fixed sidebar; mobile uses a real drawer. The active destination is communicated by more than color, and navigation order is consistent.
2. **The drawer interaction is strong.** It locks background scrolling, moves focus to Close, closes with Escape, restores focus to the trigger, and exposes `aria-current="page"` on the current destination.
3. **The appearance chooser is usable.** All six profiles fit on the tested mobile viewport, radio selection is visible, Escape closes it, and focus returns to the trigger.
4. **Routes load without page-level reflow failure.** No audited route widened the page beyond the mobile viewport.
5. **Time-window coverage is mostly coherent.** YTD exists where history supports it on Today, Business, Sales, Product, and Trajectory.
6. **Business and Trajectory are the strongest desktop compositions.** Their primary analytical surfaces are clear and use wide space well.
7. **Data Health preserves operational actions.** “Problems only” is optional; the full pipeline is not hidden behind a success takeover.
8. **The presentation system is genuinely tokenized.** Six generated profiles have separate interaction, semantic-status, and data-series colors. Registry checks enforce AA text/status pairs and 3:1 data colors against surfaces.
9. **The frontend quality suite passes.** Presentation, ownership, cache, JavaScript, CSS, formatting, and asset-loader contracts all passed during this audit.

## Severity scale

- **P1 — next batch blocker:** materially harms mobile task completion, accessibility semantics, or shared-system integrity.
- **P2 — high-value correction:** causes repeated inconsistency, unnecessary effort, or maintainability risk.
- **P3 — polish or regression prevention:** worthwhile after P1/P2 foundations are in place.

## Findings and recommendations

| ID | Priority | Finding | Guideline breached or missing | Recommendation |
|---|---:|---|---|---|
| DPP-UI-001 | P1 | The first mobile viewport is usually preamble, not work. Today’s first chart begins around y=847 in a 727 px viewport; Sales begins around y=893. Standard-theme Today is 2,458 px tall, Inventory 3,138 px, and Data Health 4,364 px. | DPP “first useful viewport” rule; intro copy must remain subordinate to the dominant chart/table/action surface. | Create a `mobile-page-lead` recipe: route name + one interpretation line + compact window/source row. Reduce KPI rails to a tight 2×2 or horizontally scrollable summary and place the first decision surface immediately after it. |
| DPP-UI-002 | P1 | The declared density tokens do not govern rendered controls. The profile contract requires metadata ≥14 px and controls ≥40 px, but shared `.btn` is 12 px, `.subnav__item` is 11 px/34 px, `.chip` is 10 px/28 px, and `.rule-trigger` can be 24 px high. Late route rules reduce Products and Inventory controls to 12 px/38 px. | Missing rendered component contract; DPP typography and control-size rules. WCAG 2.5.8 requires only 24×24 CSS px (with exceptions), so many of these may pass the legal minimum while still failing DPP’s stated 40–44 px usability target. | Make shared primitives consume `--dpp-metadata-size` and `--dpp-control-height` without route reductions. Add computed-style Playwright assertions for every interactive element in `main`, not just registry-token checks. |
| DPP-UI-003 | P1 | Weyland changes information density, not just character. Its all-monospace body font, wide-looking glyphs, uppercase treatment, texture, and borders create severe mobile wrapping. Audited document heights included Products 2,265 px, Inventory 3,283 px, Finance 3,916 px, and Data Health 5,132 px. | Profile principle: presentation may change character but should preserve task hierarchy and long-session readability. | Keep mono for chrome, headings, labels, and numbers; use the shared UI sans for long body copy. Clamp Weyland mobile letter-spacing and heading scale. Remove the scanline texture from prose-heavy mobile containers. Preserve the blocky green identity without changing layout density. |
| DPP-UI-004 | P1 | Products presents a seven-column table-like header and repeated grid rows using unannotated `div` and `a` structures. Row/column relationships are visual but not programmatic. | [WCAG 2.2 SC 1.3.1 Info and Relationships](https://www.w3.org/WAI/WCAG22/Understanding/info-and-relationships); DPP operational-table rule. | Use one native `<table>` with real column headers, or provide a fully correct ARIA grid/table pattern if interaction truly requires it. Prefer native table markup and transform its visual presentation at narrow breakpoints. |
| DPP-UI-005 | P1 | Contained horizontal clipping exists even when the page reports no overflow. At 1440 px, Inventory’s table scroller measured 1,125 px client width versus 1,168 px content width, clipping the Status edge. Today’s day picker measured 434 px versus 504 px despite unused desktop width. | DPP wide-workspace rule: do not introduce internal horizontal scroll while unused width is available. | Recalculate grid/column minimums at desktop breakpoints, allow the control/header region to use the full content width, and test every scroll container—not only `documentElement.scrollWidth`. |
| DPP-UI-006 | P2 | Data Health is operationally honest but inefficient on mobile. Every pipeline row expands freshness, cadence, row counts, and attempt details into a tall card. Standard theme reaches 4,364 px; Weyland reaches 5,132 px. | DPP hierarchy rule: decisions first, investigation detail subordinate; cards only for bounded objects. | Keep Job, Status, Freshness, and Sync/action visible in a compact row. Put cadence, rows read/stored, and last-attempt detail in per-row disclosure. Preserve the full list and optional “Problems only” filter. |
| DPP-UI-007 | P2 | Route CSS uses correction-by-append. “Corrected ... recipe” blocks begin late in Today, Sales, Products, Product, Inventory, Finance, Ads, and Data Health; Sales then adds a second connected-workspace layer. Exact selector strings recur 401 times across individual stylesheets, including legitimate breakpoint variants. | One style owner per component/state; avoid override/enhancer passes. | Rewrite each affected route sheet around the final DOM recipe, delete superseded declarations, and keep responsive variants next to the base component. Treat “same selector later in the same cascade” as a lint warning unless it is in an explicit media query. |
| DPP-UI-008 | P2 | Similar controls have separate implementations: `.btn`, `.subnav__item`, `.segmented-control__item`, `.mode`, `.filter`, `.how-btn`, and `.rule-trigger`. They vary in font, height, border, active state, and hover behavior. Sales’ Definition trigger visibly stretches into a 207–247 px empty pill while remaining only 24 px high. | DPP shared component grammar; [WCAG 3.2.4 Consistent Identification](https://www.w3.org/WAI/WCAG22/Understanding/consistent-identification.html) risk where identical functions are presented differently. | Define four primitives only: action button/link, segmented choice, route/view tab, and definition disclosure. Set `inline-size: max-content; align-self: start` on definition triggers and prohibit page-level stretching. |
| DPP-UI-009 | P2 | Route naming and page orientation vary. Navigation says “Ads” while the page says “Advertising” and “Advertising Manager.” Business and Trajectory use the current interpretation as the only visible h1 while most routes use the destination name. Mobile header identity also alternates between the business clock and “Admin.” | Consistent destination naming and heading-label clarity; [WCAG 2.4.6 Headings and Labels](https://www.w3.org/WAI/WCAG22/Understanding/headings-and-labels.html). | Adopt one destination dictionary. Use one semantic h1 that includes route identity, with the current interpretation as a display line beneath or inside the same heading structure. Decide whether the mobile shell center is route identity or clock and use that rule consistently. |
| DPP-UI-010 | P2 | The disconnected Ads state repeats the same instruction above and inside a large empty panel. Desktop leaves a disproportionately large blank region; the page feels unfinished rather than intentionally unavailable. | One canonical state per condition; avoid duplicate explanatory copy. | Use one compact disconnected-state component. Keep Overview available, hide/disable unavailable tabs with one explanation, and remove the duplicate preface. Do not fill space merely to imitate a connected dashboard. |
| DPP-UI-011 | P2 | Bordered surfaces are overused on mobile. Page headers, KPI rails, status blocks, sections, and nested panels become a stack of boxes; Weyland intensifies every boundary. | DPP card rule: cards only for bounded objects; structure before color/borders. | Flatten page lead, KPI summaries, and ordinary sections into one sheet with alignment and dividers. Reserve bordered cards for exceptions, actions, and independently actionable objects. |
| DPP-UI-012 | P2 | Inventory renders a native table on desktop and separate card markup on mobile. Finance keeps one native table; Data Health uses an ARIA table made from divs. The same class of operational data therefore has three responsive strategies. | DPP semantic-table and shared-component rules; maintenance risk from duplicate render paths. | Establish one semantic data-surface strategy. Prefer one data model and one DOM structure with responsive CSS. If a true card view is necessary, expose it as an intentional view mode rather than an implicit duplicate renderer. |
| DPP-UI-013 | P3 | Theme token contrast is checked, but rendered chart QA is incomplete. Cross-theme Business charts were broadly palette-aware; Weyland becomes nearly monochrome and outline-heavy, and dark-theme axes/lines need rendered-state verification. | Missing rendered non-text contrast and chart-differentiation tests; [WCAG 1.4.11 Non-text Contrast](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html). | Add a six-profile chart gallery and pixel/DOM assertions for axes, grid, series, focus, hover, incomplete data, and selected series. Keep chart colors independent from navigation and status colors. |
| DPP-UI-014 | P3 | Admin’s password-only form triggers Chromium’s “password form should have a username field” warning. The workflow is otherwise visually clean. | Password-manager interoperability; authentication form semantics. | If the credential is a shared `admin` identity, add an autofill-compatible username field (visually hidden only if appropriate) or document and test the intentional password-only pattern. Keep `autocomplete="current-password"`. |
| DPP-UI-015 | P3 | Frontend checks are reproducible only at the direct-dependency level. There is no lockfile; CI intentionally runs `npm install --no-package-lock`, so transitive versions can drift between identical commits. | Missing deterministic toolchain contract. | Commit a lockfile and use `npm ci` in CI. Continue pinning direct dependency versions. |

## Route scorecard

| Route | Desktop | Mobile | Main criticism | Strongest aspect |
|---|---|---|---|---|
| Today | B | D | Day picker scrolls internally on desktop; mobile chart is below the first viewport. | Clear daily framing and coherent time windows. |
| Business | A− | C | Mobile headline, basis copy, and KPI stack delay the chart. | Best overall desktop hierarchy and executive read. |
| Sales | B− | D+ | 11 px/34 px tabs, stretched Definition trigger, and chart begins below mobile viewport. | Useful range choices and strong main chart once reached. |
| Products | B− | D | Tiny filters, dense preamble, and table-like div grid without table semantics. | Useful portfolio exceptions and analysis modes. |
| Product | B | C | Identity/KPI lead is too tall on mobile; route typography differs from peers. | Decision rail and product-level analysis are well connected. |
| Inventory | C+ | D | Desktop nested table scroll; mobile has a long lead and a second card renderer. | Action queue is operationally useful. |
| Finance | B | C− | Long mobile accounting stack and mixed responsive table strategy. | Native history table and clear accounting separation. |
| Ads | C | B− | Duplicated disconnected copy and oversized empty desktop state. | Honest handling of unavailable integrations. |
| Trajectory | A− | C | Mobile interpretation/KPI lead still precedes the dominant chart. | Strong desktop story and coherent horizons. |
| Data Health | B | D | Full pipeline is too verbose per row on mobile. | Does not hide pipeline actions behind a “healthy” takeover. |
| Admin | A− | B | Password-manager warning and mobile shell identity differs. | Clean, focused protected-workspace state. |

Grades express relative UI quality, not compliance certification.

## Guideline assessment

### Internal DPP product rules

| Rule | Status | Assessment |
|---|---|---|
| Fixed desktop sidebar and accessible mobile drawer | Pass | Verified across representative routes, including Escape and focus return. |
| Dominant decision surface in first useful viewport | Fail | Repeatedly missed on mobile; most severe on Today, Sales, Inventory, and Data Health. |
| Intro copy limited and subordinate | Fail | Provenance and KPI stacks frequently dominate mobile entry. |
| Shared component grammar | Partial | Shell and segmented controls are shared; route tabs, filters, buttons, links, and definition triggers still diverge. |
| Consistent time-window controls | Mostly pass | Window labels are coherent; the visual component and placement still vary. |
| Wide workspace uses available width | Fail in contained regions | Inventory table and Today day picker scroll internally at desktop width. |
| Operational tables are semantic and responsive | Partial/fail | Inventory, Finance, and Sales use native tables; Products does not; Data Health uses ARIA table roles. |
| Body 15–16 px, metadata ≥14 px, controls 40–44 px | Fail in rendered CSS | Registry tokens pass; shared and route selectors override them with smaller values. |
| Cards reserved for bounded objects | Partial/fail | Mobile page structure is often expressed as nested bordered containers. |
| One style owner; no correction/enhancer layer | Partial | File ownership is enforced; internal late override passes remain. |
| Presentation profiles preserve hierarchy | Partial | Standard profiles generally do; Weyland materially increases mobile wrapping and height. |

### WCAG 2.2 mapping

- **SC 1.3.1 Info and Relationships:** Products is the clearest likely failure because its column header/row relationships exist only visually. Data Health’s ARIA roles are better, though native markup would be simpler and more robust.
- **SC 1.4.10 Reflow:** the audited pages fit the 390–393 px viewport without page-level horizontal scrolling. The contained desktop scroll problems are primarily DPP layout failures, not automatically WCAG reflow failures. Data tables may also qualify for the two-dimensional layout exception.
- **SC 2.5.8 Target Size (Minimum):** W3C’s AA minimum is 24×24 CSS px, with spacing and other exceptions. The 24–38 px controls require target-by-target spacing review; many are not automatic WCAG failures. They do fail DPP’s stronger 40–44 px usability standard and are unnecessarily hard to scan/tap.
- **SC 3.2.3 Consistent Navigation:** the shell passed the audited ordering and behavior checks. See [W3C’s consistent navigation guidance](https://www.w3.org/WAI/WCAG22/Understanding/consistent-navigation.html).
- **SC 3.2.4 Consistent Identification:** Ads/Advertising naming and the many visual forms of equivalent choice/disclosure controls create a predictability risk.
- **SC 1.4.3/1.4.11 Contrast:** registry token pairs pass automated thresholds. This does not prove rendered charts, disabled controls, focus rings over every background, or textured Weyland surfaces pass; a rendered-state suite is still missing.

## CSS and frontend cleanliness review

### Confirmed strengths

- All 11 pages load `theme.css`, `nav-shell.css`, and `layout-system.css` once and in canonical order.
- Pages load one declared route stylesheet; chart routes load `chart-system.css` in its owned position. Sales is the only declared extra geography stylesheet.
- `presentation-profiles.css` is generated, token-only, and loaded last.
- Deprecated `mobile-ux.css` and `design-refine.css` are absent.
- HTML contains no inline `<style>`, `style=`, or inline script blocks. Shared shell and footer ownership are contract-tested.
- JavaScript/CSS linting, formatting, presentation generation, catalog cache ownership, UI formatting, and Ads asset-loader checks pass.
- The six profiles explicitly separate data colors from interaction, brand, and status colors.

### Remaining cascade debt

- Total authored CSS is approximately **14,910 lines**. The largest route files are Sales (1,764), Today (1,401), Finance (1,220), Product (1,185), Products (1,148), Inventory (997), Data Health (915), and Trajectory (888).
- Eight route files append a “Corrected ... recipe” after the previous rules instead of replacing them. Sales appends an additional connected-workspace pass.
- A selector scan found **401 exact selector strings repeated within the same stylesheet**. Many are legitimate base/breakpoint pairs, so this is not 401 defects; it is a strong signal that responsive and correction ownership is difficult to reason about.
- There are **31 `!important` declarations**: 18 in the base theme (mostly semantic utilities and reduced-motion safeguards) and 13 outside it. This is not catastrophic, but page-level layout `!important` rules should be removed during consolidation.
- The strongest counterexample to the token system is component CSS that hard-codes smaller values after tokens have promised a minimum. Registry validation cannot detect this because it checks declarations in `profiles.json`, not computed styles in a page.
- A few runtime `element.style` mutations position chart tooltips or set SVG minimum width. These are narrow, stateful uses rather than a general styling layer, but they should remain limited to coordinates that cannot be expressed declaratively.
- The frontend toolchain has pinned direct versions but no dependency lockfile. CI therefore cannot guarantee identical transitive tooling for the same commit.

### Required cleanup rule

For every shared or route component, the final code should have:

1. one base selector;
2. adjacent state selectors;
3. adjacent responsive variants;
4. no later correction block;
5. no route-qualified reduction below shared type/control tokens;
6. a computed-style regression assertion where the contract matters.

## Proposed improvement batches

### Batch 1 — Component contract and cascade consolidation

1. Replace hard-coded 10–12 px interactive labels with the metadata token.
2. Enforce 40–44 px primary/choice controls; keep 24 px only for truly inline disclosures with adequate spacing.
3. Consolidate `.btn`, tabs, segmented choices, filters, and definition disclosures into four primitives.
4. Rewrite the appended “Corrected” blocks into canonical route rules and delete superseded declarations.
5. Add a stylelint/custom AST rule for duplicate non-media selectors and disallowed route-level control sizes.
6. Add Playwright computed-style assertions for control font size, target height, visible focus, and overflow containers.

### Batch 2 — Mobile hierarchy and Weyland density

1. Implement one compact mobile lead recipe across all routes.
2. Move the first chart/table/action queue above nonessential provenance and secondary KPIs.
3. Standardize compact KPI treatment.
4. Use sans body copy in Weyland; reserve mono for identity, headings, labels, and numbers.
5. Suppress dense texture on mobile prose surfaces and cap Weyland heading/letter-spacing growth.
6. Add first-surface position and document-height budgets to visual QA.

### Batch 3 — Semantic data surfaces and overflow

1. Rebuild Products as a native semantic table or a rigorously implemented ARIA grid.
2. Choose one shared responsive strategy for Products, Inventory, Finance, Sales, and Data Health.
3. Remove Inventory’s desktop nested clipping and Today’s unnecessary day-picker scroll.
4. Compact Data Health pipeline rows with technical disclosure.
5. Verify sticky headers and column labels at desktop, tablet, 390 px, 360 px, and 320 px.

### Batch 4 — Route-specific IA cleanup

1. Fix Sales’ stretched Definition trigger and compact its lead.
2. Remove duplicate Ads disconnected copy and reduce the empty-state footprint.
3. Standardize Ads/Advertising and semantic h1 route identity.
4. Standardize the mobile shell center identity.
5. Resolve the Admin password-manager warning if compatible with the authentication model.

### Batch 5 — Cross-profile regression system

1. Capture every route in all six profiles at one desktop and one mobile viewport.
2. Add rendered chart/non-text contrast checks, including hover/focus/disabled/incomplete states.
3. Add a lockfile and switch CI to `npm ci`.
4. Treat cross-profile document-height deltas above an agreed threshold as a review failure.

## Acceptance criteria for the next batch

- On 390 × 664 and 393 × 727, each connected analytics route exposes its first chart, table header, or first actionable item within the first viewport or no more than 120 px below it.
- No main-workspace interactive label computes below 14 px unless it is an inline disclosure with an explicit exception.
- Standard controls compute to at least 40 px high; primary touch controls target 44 px.
- No unintended horizontal scroll container exists at 1440 px. Intended data-table scroll must be documented and have no clipped final column.
- Products exposes programmatic row/column relationships.
- Data Health keeps all jobs available while default rows remain compact.
- Weyland mobile document height is no more than 20% above Warm Studio for the same route and state.
- The same control function has the same primitive, active state, focus treatment, and minimum size on every route.
- Route sheets contain no late “corrected” or “enhancer” section; superseded CSS is removed.
- The existing `npm run quality` suite passes, plus new computed-style and visual-route tests.
- Chromium and WebKit show no reproducible application-owned console errors or failed asset/API responses across the route matrix.

## Final criticism

The current UI is competent but over-composed. It frequently explains itself before it lets the operator work, and it uses bordered surfaces to manufacture hierarchy that should come from order, spacing, and type. The theme system is more mature than the component system beneath it: the profiles promise consistent density, but page CSS quietly opts out. The source has also reached the point where passing lint is not enough; the cascade can be valid and still be difficult to reason about.

The next batch should therefore be judged by subtraction: fewer control variants, fewer repeated selectors, fewer mobile preamble pixels, fewer alternate renderers, and fewer borders. Once that is complete, the visual profiles will have a much stronger and more stable product to express.
