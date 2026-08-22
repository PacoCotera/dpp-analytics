# Monetary metric basis

This document is the canonical data dictionary for money shown in DPP Analytics.

The rule is simple: **a monetary amount is not fully defined until its basis is known.** Gross shopper spend, Amazon operating sales, accounting net sales and Ads-attributed sales are different metrics and must never be silently substituted for one another.

## Canonical monetary concepts

| Concept | Canonical ID | Primary source | Meaning | UI shorthand | Must not be used as |
| --- | --- | --- | --- | --- | --- |
| Shopper spend | `GROSS_CUSTOMER_SPEND` | Amazon Orders | What the shopper paid on the order. Order grand total is preferred; item price × quantity is the only item-level fallback. In Mexico this is the customer-facing tax-inclusive amount. | `Shopper spend` / `Today spend` | Finance net sales, settlement proceeds |
| Amazon ordered-product sales | `AMAZON_ORDERED_PRODUCT_SALES` | Sales & Traffic / Data Kiosk | Amazon's reconciled operating sales metric (`orderedProductSales`) at business/SKU grain. | `Sales` / `Amazon sales` | Settlement proceeds or Ads-attributed sales |
| Finance net sales ex IVA | `NET_SALES_EX_IVA` | Canonical Finance accounting model | Management sales after removing Mexico IVA according to the Finance accounting contract. | `Net sales ex IVA` | Shopper spend |
| IVA | `IVA` | Canonical Finance accounting model | Mexico IVA shown separately from management sales. | `IVA` | Revenue or Amazon fee |
| Finance gross customer spend | `FINANCE_GROSS_CUSTOMER_SPEND` | Canonical Finance accounting model | Net sales ex IVA + IVA for the accounting period. | `Gross customer spend` | Amazon payout |
| Amazon payout | `AMAZON_PAYOUT` | Finance transactions / settlement cash timing | Cash movement from Amazon. | `Payout` / `cash timing` | Revenue or contribution |
| Ads spend | `ADS_SPEND` | Amazon Ads unified reporting | Advertising cost by advertising date for operating analysis; Finance uses accounting-month close rules. | `Spend` | ProductAdsPayment cash timing |
| Ads-attributed sales | `ADS_ATTRIBUTED_SALES` | Amazon Ads unified reporting | Sales Amazon attributes to advertising under the report's stated attribution window/method. | `Attributed sales` | Incremental sales or exact paid-only sales |
| TACOS denominator | `INDEPENDENT_SELLER_SALES` | Canonical seller-sales mart | Seller sales independently reconciled from Ads. | `TACOS` | Ads-attributed sales |

## Non-negotiable rules

1. **Operating pages never use `proceeds_*` or settlement amounts as a fallback for shopper-facing sales.** In Mexico those accounting values can be net of IVA, which can make two identical MX$279 orders appear as MX$279 and MX$241 on the same screen.
2. **Today and order evidence use `GROSS_CUSTOMER_SPEND`.** Order grand total is preferred; item-level evidence uses unit price × quantity.
3. **Historical Sales, Catalog, Product and Trajectory use reconciled Sales & Traffic `orderedProductSales` where available.** Product movers and inventory sales context use the same reconciled source.
4. **Finance is the only management-accounting surface.** It explicitly separates net sales ex IVA, IVA, gross customer spend, Amazon effects, advertising, COGS, contribution and payout/cash timing.
5. **Ads-attributed sales are attribution, not incrementality.** Never label `seller sales - attributed sales` as exact organic sales.
6. **Do not compare or sum unlike bases without an explicit transformation and label.** If a page intentionally shows two bases, label both where the user can see them.
7. **Currency and timezone come from `core.marketplace`.** DPP Mexico is currently MXN / `America/Mexico_City`; new marketplaces must not inherit those values by hard code.

## Source ownership by surface

| Surface | Primary sales basis | Live/order evidence | Accounting/Ads notes |
| --- | --- | --- | --- |
| Today | `GROSS_CUSTOMER_SPEND` | Same basis across headline, product contribution, rhythm and orders | Provisional live operating view |
| Home | Reconciled `AMAZON_ORDERED_PRODUCT_SALES` | Today KPI is explicitly `GROSS_CUSTOMER_SPEND` | Do not merge the two into one unlabeled series |
| Sales | Reconciled `AMAZON_ORDERED_PRODUCT_SALES` | Recent orders + Today are `GROSS_CUSTOMER_SPEND` | Ads context retains attribution semantics |
| Catalog | Reconciled SKU `AMAZON_ORDERED_PRODUCT_SALES` | n/a | Ads attributed sales/TACOS are separate context |
| Product Workspace | Reconciled SKU `AMAZON_ORDERED_PRODUCT_SALES` | Recent orders are `GROSS_CUSTOMER_SPEND` | Standard COGS is an estimate; Ads is separate |
| Inventory | Reconciled SKU Sales & Traffic for sales/velocity context | n/a | Replenishment decisions are unit/cover-led |
| Trajectory | Reconciled `AMAZON_ORDERED_PRODUCT_SALES` | n/a | Ads is optional efficiency context only |
| Finance | `NET_SALES_EX_IVA` + explicit `IVA` + `FINANCE_GROSS_CUSTOMER_SPEND` | n/a | Closed snapshots are immutable; payout is cash timing |
| Ads | `ADS_ATTRIBUTED_SALES` plus independent seller-sales denominator | n/a | Attribution basis, maturity, freshness and trust state are mandatory |

## SQL contracts

`sql/migrations/029_operating_monetary_basis.sql` establishes the canonical order-side views:

- `mart.order_item_customer_spend` — item price × quantity; no settlement/proceeds fallback.
- `mart.order_customer_spend` — order grand total with gross item fallback.
- `mart.order_sales_daily` — near-real-time order rollup on shopper-spend basis.
- `mart.sku_daily` — near-real-time SKU shopper-spend history.
- `mart.sku_velocity_t28` — reconciled SKU Sales & Traffic velocity.
- `mart.catalog_movers_t28` — reconciled SKU Sales & Traffic movers.
- `mart.today_operating` — live Today headline and same-time benchmark on shopper-spend basis.

## Presentation contract

Use the shortest label that remains unambiguous:

- ordinary historical operating charts: `Sales`, with a nearby/footer note `Amazon Sales & Traffic`;
- live Today/order amounts: `Shopper spend` or `Today spend`, with `incl. IVA` nearby;
- Finance: always say `Net sales ex IVA`, `IVA`, `Gross customer spend`, and `Payout` explicitly;
- Ads: always say `Attributed sales`, never just `sales` when the number is Ads-derived.

Tooltips/footers may provide the longer source definition, but they are not a substitute for an accurate visible label when two bases appear on the same screen.
