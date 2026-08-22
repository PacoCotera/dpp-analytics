# Monetary metric basis

This document is the canonical data dictionary for money shown in DPP Analytics.

The rule is simple: **a monetary amount is not fully defined until its basis is known.** Gross shopper spend, Amazon operating sales, accounting net sales, settlement cash and Ads-attributed sales are different metrics and must never be silently substituted for one another.

## Canonical monetary concepts

| Concept | Canonical ID | Primary source | Meaning | UI shorthand | Must not be used as |
| --- | --- | --- | --- | --- | --- |
| Shopper spend | `GROSS_CUSTOMER_SPEND` | Amazon Orders | What the shopper paid on the order. Order grand total is preferred; item price × quantity is the only item-level fallback. In Mexico this is the customer-facing tax-inclusive amount. | `Shopper spend` / `Today spend` | Finance net sales, settlement proceeds |
| Amazon ordered-product sales | `AMAZON_ORDERED_PRODUCT_SALES` | Sales & Traffic / Data Kiosk | Amazon's reconciled operating sales metric (`orderedProductSales`). Business totals are daily marketplace grain; current product reporting is CHILD-ASIN grain and is attached once to the canonical commercial offer owner. | `Sales` / `Amazon sales` | Settlement proceeds or Ads-attributed sales |
| Finance net sales ex IVA | `NET_SALES_EX_IVA` | Canonical Finance accounting model | Management revenue after removing Mexico IVA from customer spend. This is the revenue basis for management contribution. | `Net sales ex IVA` | Shopper spend or payout |
| IVA withheld | `IVA_WITHHELD` | Canonical Finance accounting model | Mexico IVA contained in the shopper price. Amazon withholds/remits this tax; it is not DPP revenue and is not included in DPP cash payout. | `IVA withheld` | Revenue, Amazon fee or cash received |
| Finance gross customer spend | `FINANCE_GROSS_CUSTOMER_SPEND` | Canonical Finance accounting model | Net sales ex IVA + IVA withheld for the accounting period: the customer-facing product spend before Amazon withholds tax and applies settlement deductions. | `Gross customer spend` | Amazon payout |
| Amazon payout | `AMAZON_PAYOUT` | RELEASED Finance transactions / settlement cash timing | Cash Amazon transfers to DPP after withheld taxes, Amazon fees and other settlement deductions/adjustments. Transfer timing can cross business-month boundaries, so payout is cash timing rather than period revenue. | `Payout` / `cash timing` | Revenue or contribution |
| Ads spend | `ADS_SPEND` | Amazon Ads unified reporting | Advertising cost by advertising date for operating analysis; Finance uses accounting-month close rules. | `Spend` | ProductAdsPayment cash timing |
| Ads-attributed sales | `ADS_ATTRIBUTED_SALES` | Amazon Ads unified reporting | Sales Amazon attributes to advertising under the report's stated attribution window/method. | `Attributed sales` | Incremental sales or exact paid-only sales |
| TACOS denominator | `INDEPENDENT_SELLER_SALES` | Canonical seller-sales mart | Seller sales independently reconciled from Ads. | `TACOS` | Ads-attributed sales |

## Mexico cash bridge

For DPP Mexico, the conceptual settlement bridge is:

`Gross customer spend incl. IVA`

`- IVA withheld/remitted by Amazon`

`- Amazon fees and other deductions`

`- advertising charged through settlement, when applicable`

`+/- refunds, reimbursements and other settlement adjustments`

`= cash payout`

This is a **cash reconciliation**, not the definition of revenue. Management revenue starts from `NET_SALES_EX_IVA`. Cash payout is deliberately kept separate because Amazon transfer dates do not necessarily match the business month in which the underlying sale occurred.

Until settlement fee classification is validated, DPP Analytics must **not** expose apparently precise selling/FBA fee subtotals in the management UI. The ledger remains technical evidence. A residual Amazon effect may be used in contribution analysis only when its basis is explicit; it must not be relabeled as a validated fee total.

## Non-negotiable rules

1. **Operating pages never use `proceeds_*` or settlement amounts as a fallback for shopper-facing sales.** In Mexico those accounting values can be net of IVA, which can make two identical MX$279 orders appear as MX$279 and MX$241 on the same screen.
2. **Today and order evidence use `GROSS_CUSTOMER_SPEND`.** Order grand total is preferred; item-level evidence uses unit price × quantity.
3. **Historical business and commercial-product sales use reconciled Sales & Traffic `orderedProductSales`.** Product demand is currently CHILD-ASIN grain; it is attached exactly once to the canonical sellable offer so aliases and structural parents cannot duplicate revenue.
4. **Inventory velocity is a seller-SKU unit question.** Until seller-SKU Sales & Traffic is actually populated, replenishment velocity may use Orders units; do not mislabel that operational unit source as reconciled SKU revenue.
5. **Finance is the only management-accounting surface.** It explicitly separates net sales ex IVA, IVA withheld, gross customer spend, Amazon effects, advertising, COGS, contribution and payout/cash timing.
6. **IVA is withheld cash, not an Amazon fee.** It is included in the shopper-facing price but is neither DPP revenue nor part of the cash Amazon transfers to DPP.
7. **Payout is not period profit.** Settlement transfers can contain activity from different business periods and are shown as cash timing/evidence, not as a substitute for contribution.
8. **Ads-attributed sales are attribution, not incrementality.** Never label `seller sales - attributed sales` as exact organic sales.
9. **Do not compare or sum unlike bases without an explicit transformation and label.** If a page intentionally shows two bases, label both where the user can see them.
10. **Currency and timezone come from `core.marketplace`.** DPP Mexico is currently MXN / `America/Mexico_City`; new marketplaces must not inherit those values by hard code.

## Source ownership by surface

| Surface | Primary sales basis | Live/order evidence | Accounting/Ads notes |
| --- | --- | --- | --- |
| Today | `GROSS_CUSTOMER_SPEND` | Same basis across headline, product contribution, rhythm and orders | Provisional live operating view |
| Home | Reconciled `AMAZON_ORDERED_PRODUCT_SALES` | Today KPI is explicitly `GROSS_CUSTOMER_SPEND` | Do not merge the two into one unlabeled series |
| Sales | Reconciled `AMAZON_ORDERED_PRODUCT_SALES`; products use canonical CHILD-ASIN offer mapping | Recent orders + Today are `GROSS_CUSTOMER_SPEND` | Ads context retains attribution semantics |
| Catalog | Reconciled CHILD-ASIN `AMAZON_ORDERED_PRODUCT_SALES`, attached once to canonical offer | n/a | Ads attributed sales/TACOS are separate context |
| Product Workspace | Reconciled CHILD-ASIN `AMAZON_ORDERED_PRODUCT_SALES` for the commercial offer | Recent seller-SKU orders are `GROSS_CUSTOMER_SPEND` | Standard COGS is an estimate; Ads is separate |
| Inventory | Seller-SKU Orders units for velocity/cover | n/a | Replenishment is unit/cover-led; revenue is not inferred from proceeds |
| Trajectory | Reconciled `AMAZON_ORDERED_PRODUCT_SALES` | n/a | Ads is optional efficiency context only |
| Finance | `NET_SALES_EX_IVA` + explicit `IVA_WITHHELD` + `FINANCE_GROSS_CUSTOMER_SPEND` | n/a | Closed snapshots are immutable; payout is cash timing after tax/settlement deductions |
| Ads | `ADS_ATTRIBUTED_SALES` plus independent seller-sales denominator | n/a | Attribution basis, maturity, freshness and trust state are mandatory |

## SQL contracts

The operating monetary migrations establish these contracts:

- `mart.order_item_customer_spend` — item price × quantity; no settlement/proceeds fallback.
- `mart.order_customer_spend` — order grand total with gross item fallback, including orders whose item detail has not arrived yet.
- `mart.order_sales_daily` — near-real-time order rollup on shopper-spend basis.
- `mart.sku_daily` — near-real-time seller-SKU shopper-spend/unit history; not canonical reconciled commercial revenue.
- `mart.sku_velocity_t28` — seller-SKU Orders units for inventory velocity/cover.
- `mart.catalog_portfolio_product` — canonical commercial offer identity; CHILD-ASIN Data Kiosk demand is attached once to one offer owner.
- `mart.catalog_movers_t28` — reconciled CHILD-ASIN product movers mapped to canonical offer owners.
- `mart.today_operating` — live Today headline and same-time benchmark on shopper-spend basis.

## Presentation contract

Use the shortest label that remains unambiguous:

- ordinary historical operating charts: `Sales`, with a nearby/footer note `Amazon Sales & Traffic`;
- product performance: `Amazon sales` when nearby context must distinguish it from order evidence;
- live Today/order amounts: `Shopper spend` or `Today spend`, with `incl. IVA` nearby;
- Finance: always say `Net sales ex IVA`, `IVA withheld`, `Gross customer spend`, and `Payout` explicitly. Explain that payout is after withheld tax and Amazon settlement deductions and is cash timing, not revenue;
- Ads: always say `Attributed sales`, never just `sales` when the number is Ads-derived.

Tooltips/footers may provide the longer source definition, but they are not a substitute for an accurate visible label when two bases appear on the same screen.
