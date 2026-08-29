# DPP Analytics UI architecture correction · 2026-08-29

**Status:** In delivery  
**Tracker:** [#231](https://github.com/PacoCotera/dpp-analytics/issues/231)  
**Reference:** Approved Business mockup  
**Scope:** Presentation architecture only; routes, APIs and business definitions remain unchanged

## Why this correction exists

The 2026-08-28 revamp established shared tokens and a shared shell, but it retained the previous page compositions. The result was visually themed legacy pages rather than one coherent application: a permanent desktop sidebar diverged from the approved mockup, page identity was duplicated, explanations displaced evidence, and tables, filters, decisions and status surfaces followed different grammars by route.

This correction treats information architecture as a first-class contract. Every page has a distinct business question and therefore a deliberate recipe, while all pages share one compact visual language.

## Shared application frame

- Desktop uses a compact brand row followed by horizontal domain navigation.
- Business, Today, Sales, Products, Inventory and Finance are direct destinations. Ads, Trajectory, Data Health and Admin live in a native More menu.
- Mobile uses the same ordered destinations in an accessible drawer.
- Page content aligns to the same centered frame as the header and navigation.
- The global header does not repeat the current page title. Each page has exactly one logical `h1` inside its content.
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
4. supporting evidence: no more than three parallel modules before a second major section;
5. provenance and rule detail: adjacent to the evidence it qualifies.

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
- Range and metric choices are compact controls and persist in URL state when they change the analysis.

## Page recipes

| Route | Business question | Lead and summary | Dominant surface | Supporting evidence |
| --- | --- | --- | --- | --- |
| Business `/` | What changed and what needs a decision? | API-owned business pulse plus four KPIs | 13-week demand pulse | inventory decisions; Finance, Inventory and Data confidence health cards |
| Today `/today` | What is happening today and what should I watch next? | live operating state plus three rhythm KPIs | intraday/order rhythm | priority queue and concise evidence disclosure |
| Sales `/sales` | How is demand performing and what explains it? | selected view/range plus comparable KPIs | sales trend or ranked driver view | product and geography evidence appropriate to the selected view |
| Products `/catalog` | Which products need attention or investigation? | portfolio count, window and compact filters | sortable product table | family or status summaries only when they change prioritization |
| Product `/product` | What is happening for this product? | product identity, current state and key measures | demand/availability trajectory | inventory, contribution and Ads context; one decision rail |
| Inventory `/inventory` | What should be produced, planned or monitored? | explicit API-owned thresholds and action counts | action-first inventory table | portfolio coverage summary and source/cutoff disclosure |
| Finance `/finance` | What did the business earn and what is closed? | close state, period and contribution KPIs | management P&L table | IVA bridge, settlement timing and COGS readiness |
| Ads `/ads` | Is Ads connected, decision-grade and effective? | API-owned connection/reporting state | canonical connection state or performance view | actions and drill-down tables only when reporting is ready |
| Trajectory `/trajectory` | Is performance structurally improving? | signal, eligibility and selected window | trajectory chart | compact evidence table and rule disclosure |
| Data Health `/data-health` | Can current decisions trust their inputs? | overall contract state and affected domains | job/stream health table | incidents and onboarding tasks |
| Admin `/admin` | What seller-owned configuration needs maintenance? | authentication or configuration scope | focused sign-in form or editable product table | validation, conflict and audit state adjacent to the edited object |

## Responsive contract

- The information order stays the same across widths.
- KPI strips wrap without turning into tall narrative cards.
- Dense charts and tables contain their own horizontal scroll when compression would destroy readability.
- Toolbars wrap before labels truncate; primary actions remain reachable without horizontal page overflow.
- Mobile drawers, menus, tabs and disclosures preserve keyboard and screen-reader state.

## Delivery blocks

1. Shared frame, grammar and Business reference implementation.
2. Today, Sales and Trajectory analytical pages.
3. Products, Product and Inventory operational pages.
4. Finance, Ads, Data Health and Admin specialist pages.
5. Cross-route density, accessibility, URL-state and production visual audit.

Each block is accepted only after standalone Playwright review in Chromium and WebKit at desktop and mobile widths. A route rendering successfully is not sufficient; its first viewport must visibly express the page recipe above.
