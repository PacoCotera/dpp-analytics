# DPP Analytics UI architecture correction · 2026-08-29

**Status:** In delivery  
**Tracker:** [#231](https://github.com/PacoCotera/dpp-analytics/issues/231)  
**Reference:** Approved Business mockup  
**Scope:** Presentation architecture, canonical workspace routes and the history required by shared chart windows; business definitions remain unchanged

## Why this correction exists

The 2026-08-28 revamp established shared tokens and a persistent shell, but several later composition changes retained too much legacy structure and incorrectly replaced the approved desktop sidebar with horizontal navigation. The result was visually themed legacy pages rather than one coherent application: explanations displaced working surfaces, and tables, filters, decisions and status surfaces followed different grammars by route.

This correction treats information architecture as a first-class contract. Every page has a distinct business question and therefore a deliberate recipe, while all pages share one compact visual language.

## Shared application frame

- Desktop uses a fixed, full-height left sidebar with all ten destinations visible.
- Today is first, is served at `/`, and is the default destination. Business is served at `/business`; `/today`, `/home` and `/index.html` remain compatible aliases.
- Mobile collapses the same ordered destinations into an accessible hamburger drawer.
- Page content and the global header occupy the workspace to the right of the sidebar.
- The global header provides compact workspace context without replacing the page's single logical `h1`.
- Global time, freshness and Appearance controls remain compact and secondary to the working surface.

## Visual grammar

### Density

- The primary chart, table or decision surface should occupy the majority of the first useful viewport.
- Introductory prose is limited to a title, one concise interpretation and one compact source/window line.
- Legends are embedded in a chart header or a single compact row. They must not become a separate explanatory panel.
- Repeated source, basis and cutoff details use a consistent metadata line or disclosure rather than full paragraphs.
- Empty states explain what is unavailable and the next valid action without simulating a full dashboard.

### Hierarchy

Every page uses this order when the elements exist:

1. page lead: business question, current interpretation and local controls;
2. compact KPI strip: three to five comparable measures;
3. dominant working surface: chart, table, queue, report or form;
4. supporting detail: no more than three parallel modules before a second major section;
5. provenance and definition detail: adjacent to the value it qualifies.

Cards represent bounded objects such as a decision, product, incident or health domain. Ordinary sections use alignment, dividers and shared surfaces instead of card grids.

### Tables

All operational tables share one contract:

- a compact toolbar containing search, filters and count;
- sticky column headers inside the table scroll region;
- left-aligned identity columns and right-aligned numeric columns;
- tabular numerals for quantities, money, rates and dates;
- one status treatment vocabulary across routes;
- row-level action or drill-down at the right edge;
- source/cutoff detail outside the row body;
- contained horizontal overflow at narrow widths, or a semantic mobile-card presentation that preserves the native table relationships.

### Charts

- The plot receives more space than its title, legend and interpretation combined.
- Axes, comparison periods, partial periods and tooltips come from the shared chart system.
- A chart uses the data palette; navigation, brand and severity colors do not become series colors.
- Demand bars and their comparison line use the same shared renderer on Business and Today.
- Every chart time-window selector uses the shared control treatment and offers YTD when date history exists.
- Long daily series aggregate into meaningful weekly marks before bars become too narrow to compare.
- Range and metric choices are compact controls and persist in URL state when they change the analysis.

### Ergonomics

- Wide workspaces use available inline space for the dominant chart and its decision support; they do not preserve a narrow desktop composition in the center of a large viewport.
- Analytical charts size to their container. They do not create internal horizontal scrolling while unused viewport width is available.
- Secondary cards may sit beside a dominant chart on wide screens, but collapse in reading order before either becomes cramped.
- A healthy-state summary never replaces operational controls. Data Health always exposes every pipeline row and its row-level action by default; “Problems only” is an optional filter.
- Compact horizon summaries use comparable numbers and labels. Decorative progress bars do not substitute for the main trajectory chart.

### Presentation profiles

- A presentation profile may change color, display typography and decorative character, but it must not change task order or materially increase page length.
- Weyland uses monospace for headings, labels and numeric display while long-form body copy retains the shared UI sans stack.
- Decorative panel texture is suppressed at phone widths so it does not compete with dense operating content.

## Page recipes

| Route | Business question | Lead and summary | Dominant surface | Supporting detail |
| --- | --- | --- | --- | --- |
| Today `/` | What is happening today and what should I watch next? | live operating state plus three rhythm KPIs | intraday/order rhythm | priority queue and concise reference disclosure |
| Business `/business` | What changed and what needs a decision? | API-owned business pulse plus four KPIs | 13-week demand pulse | inventory decisions; Finance, Inventory and Data confidence health cards |
| Sales `/sales` | How is demand performing and what explains it? | selected view/range plus comparable KPIs | sales trend or ranked driver view | product and geography detail appropriate to the selected view |
| Products `/catalog` | Which products need attention or investigation? | portfolio count, window and compact filters | sortable product table | family or status summaries only when they change prioritization |
| Product `/product` | What is happening for this product? | product identity, current state and key measures | demand/availability trajectory | inventory, contribution and Ads context; one decision rail |
| Inventory `/inventory` | What should be produced, planned or monitored? | explicit API-owned thresholds and action counts | action-first inventory table | portfolio coverage summary and source/cutoff disclosure |
| Finance `/finance` | What did the business earn and what is closed? | close state, period and contribution KPIs | management P&L table | IVA bridge, settlement timing and COGS readiness |
| Ads `/ads` | Is Ads connected, decision-grade and effective? | API-owned connection/reporting state | canonical connection state or performance view | actions and drill-down tables only when reporting is ready |
| Trajectory `/trajectory` | Is performance structurally improving? | signal, eligibility and selected window | trajectory chart | compact history table and definition disclosure |
| Data Health `/data-health` | Can current decisions trust their inputs? | overall contract state and affected domains | job/stream health table | incidents and onboarding tasks |
| Admin `/admin` | What seller-owned configuration needs maintenance? | authentication or configuration scope | focused sign-in form or editable product table | validation, conflict and audit state adjacent to the edited object |

## Responsive contract

- The information order stays the same across widths.
- KPI strips wrap without turning into tall narrative cards.
- Dense tables contain their own horizontal scroll when compression would destroy readability. Charts reflow or aggregate their marks instead of forcing a fixed plot width.
- Toolbars wrap before labels truncate; primary actions remain reachable without horizontal page overflow.
- Mobile drawers, menus, tabs and disclosures preserve keyboard and screen-reader state.
- At phone widths, the first dominant chart, table or action queue begins within the first useful 760 CSS pixels of document content on covered routes.

## Delivery blocks

1. Shared frame, grammar and Business reference implementation.
2. Today, Sales and Trajectory analytical pages.
3. Products, Product and Inventory operational pages.
4. Finance, Ads, Data Health and Admin specialist pages.
5. Cross-route density, accessibility, URL-state and production visual audit.

Each block is accepted only after standalone Playwright review in Chromium and WebKit at desktop and mobile widths. A route rendering successfully is not sufficient; its first viewport must visibly express the page recipe above.
