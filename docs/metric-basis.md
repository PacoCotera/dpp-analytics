# Monetary metric basis

This document is the canonical data dictionary for money shown in DPP Analytics.

The rule is simple: **a monetary amount is not fully defined until its basis is known.** Gross shopper spend, net seller revenue, settlement cash and Ads-attributed sales are different metrics and must never be silently substituted for one another.

## Quick UI map

- **Today and individual order evidence:** shopper spend **including IVA**.
- **Sales, Home, Catalog, Product and Trajectory:** shopper spend **including IVA**. Historical periods use reconciled Amazon Sales & Traffic; Today/order evidence uses Amazon Orders.
- **Finance:** accounting translation: **Gross customer spend - IVA withheld = Net sales ex IVA**. Closed months use immutable snapshots.
- **Amazon payout:** cash timing after IVA withholding and settlement deductions; never revenue.
- **Ads attributed sales:** Amazon attribution; never exact incremental or organic sales.

## Production proof of the Sales & Traffic tax basis

Do not infer the tax basis from field names. We measured it against production Orders.

For the latest 28-day production audit on 2026-08-21, 25 days had matching Sales & Traffic units and Orders units. Across those matched days:

- Amazon Sales & Traffic `orderedProductSales`: **MX$16,385.49**
- normalized Orders shopper spend incl. IVA: **MX$16,396.39**
- the same Orders amounts divided by 1.16: **MX$14,134.82**

Difference to gross: **MX$10.90**. Difference to ex-IVA: **MX$2,250.67**.

The observed contract for DPP Mexico is therefore `SHOPPER_SPEND_INCL_TAX`. It is stored in `core.marketplace_tax_policy.sales_traffic_amount_basis`. Finance removes IVA explicitly; operating pages do not.

## Canonical monetary concepts

| Concept | Canonical ID | Primary source | Meaning | UI shorthand | Must not be used as |
| --- | --- | --- | --- | --- | --- |
| Shopper spend | `GROSS_CUSTOMER_SPEND` | Amazon Orders or reconciled Sales & Traffic | Customer-facing product spend including IVA. Live Orders are normalized to this basis; historical `orderedProductSales` empirically matches this basis for DPP MX. | `Shopper spend incl. IVA` | Finance net sales, settlement proceeds |
| Reconciled commercial sales | `AMAZON_ORDERED_PRODUCT_SALES` | Sales & Traffic / Data Kiosk | Amazon `orderedProductSales`. For DPP MX its observed basis is shopper spend including IVA. Business totals are daily marketplace grain; product reporting is CHILD-ASIN grain and is attached once to the canonical commercial offer owner. | `Sales incl. IVA` / `Shopper spend` | Finance net revenue, settlement proceeds or Ads-attributed sales |
| Finance net sales ex IVA | `NET_SALES_EX_IVA` | Canonical Finance accounting model | Management revenue after removing IVA from gross Sales & Traffic shopper spend: `gross / (1 + VAT rate)`. | `Net sales ex IVA` | Shopper spend or payout |
| IVA withheld | `IVA_WITHHELD` | Canonical Finance accounting model | `gross customer spend - net sales ex IVA`. Amazon withholds/remits this tax; it is not DPP revenue and is not included in DPP cash payout. | `IVA withheld` | Revenue, Amazon fee or cash received |
| Finance gross customer spend | `FINANCE_GROSS_CUSTOMER_SPEND` | Sales & Traffic interpreted by marketplace tax policy | Customer-facing product spend including IVA for the accounting period. For DPP MX this is the reconciled Sales & Traffic amount before Finance removes IVA. | `Gross customer spend` | Amazon payout |
| Amazon payout | `AMAZON_PAYOUT` | RELEASED Finance transactions / settlement cash timing | Cash Amazon transfers to DPP after withheld taxes, Amazon fees and other settlement deductions/adjustments. Transfer timing can cross business-month boundaries. | `Payout` / `cash timing` | Revenue or contribution |
| Ads spend | `ADS_SPEND` | Amazon Ads unified reporting | Advertising cost by advertising date for operating analysis; Finance uses accounting-month close rules. | `Spend` | ProductAdsPayment cash timing |
| Ads-attributed sales | `ADS_ATTRIBUTED_SALES` | Amazon Ads unified reporting | Sales Amazon attributes to advertising under the report's stated attribution window/method. | `Attributed sales` | Incremental sales or exact paid-only sales |
| TACOS denominator | `INDEPENDENT_SELLER_SALES` | Canonical seller-sales mart | Seller commercial sales independently reconciled from Ads. For DPP MX this denominator follows the Sales & Traffic shopper-spend-including-IVA basis. | `TACOS` | Ads-attributed sales |

## Live Mexico order-money rule

Amazon Orders v2026 can expose the same MX item at different completeness states. In production we observed a finalized MX$279 sale as ITEM MX$240.52 + TAX MX$38.48, while another same-price live order temporarily had only the MX$240.52 tax-exclusive item amount. Summing those fields naively mixes tax bases.

DPP therefore normalizes every itemized live order before aggregation:

1. Explicit ITEM + TAX when both are available.
2. Otherwise gross up the tax-exclusive item amount using `core.marketplace_tax_policy`.
3. Order grand total is only a last fallback when item detail is absent.
4. Shipping and Amazon fees are not product sales.

For DPP Mexico, the current marketplace tax policy is 16% IVA. The policy is marketplace data, not frontend arithmetic.

## Mexico accounting and cash bridge

Accounting translation:

`Gross customer spend incl. IVA`

`- IVA withheld/remitted by Amazon`

`= Net sales ex IVA`

Cash settlement then continues separately:

`Gross customer spend incl. IVA`

`- IVA withheld/remitted by Amazon`

`- Amazon fees and other deductions`

`- advertising charged through settlement, when applicable`

`+/- refunds, reimbursements and other settlement adjustments`

`= cash payout`

Payout is a **cash reconciliation**, not the definition of revenue. Transfer dates do not necessarily match the business month in which the underlying sale occurred.

Until settlement fee classification is validated, DPP Analytics must **not** expose apparently precise selling/FBA fee subtotals in the management UI. The ledger remains technical evidence.

## Non-negotiable rules

1. **Operating commercial money is one gross basis.** Today, Sales, Home, Catalog, Product and Trajectory use shopper spend including IVA.
2. **Historical operating periods use reconciled Sales & Traffic only.** Do not mix order-derived gap rows into historical KPI windows/charts merely to fill the latest day.
3. **A live order is normalized to one tax-inclusive basis before it is summed.** Never mix tax-exclusive item amounts with tax-inclusive order/item amounts.
4. **Finance is the only management-accounting translation layer.** It derives net sales ex IVA from gross Sales & Traffic using marketplace tax policy and exposes gross, IVA and net separately.
5. **Historical Finance corrections are explicit restatements.** The discovery that Sales & Traffic is gross required new `RESTATED` versions; prior close rows were not mutated.
6. **IVA is withheld cash, not an Amazon fee.** It is included in the shopper-facing price but is neither DPP revenue nor part of the cash Amazon transfers to DPP.
7. **Payout is not period profit.** Settlement transfers can contain activity from different business periods and are shown as cash timing/evidence.
8. **Inventory velocity is a seller-SKU unit question.** Do not infer revenue from settlement proceeds.
9. **Finance advertising is a negative management expense.** Ads API analytical spend and ProductAdsPayment settlement signs are normalized before close.
10. **Ads-attributed sales are attribution, not incrementality.** Never label `seller sales - attributed sales` as exact organic sales.
11. **Do not compare or sum unlike bases without an explicit transformation and label.**
12. **Currency, timezone, VAT rate and Sales & Traffic tax basis are marketplace data.** DPP Mexico is MXN / `America/Mexico_City` / 16% IVA / `SHOPPER_SPEND_INCL_TAX`.
13. **Applied SQL migrations are immutable.** Corrections use new migrations, not edits to applied history.

## Source ownership by surface

| Surface | Primary sales basis | Notes |
| --- | --- | --- |
| Today | Shopper spend incl. IVA from normalized Orders | Provisional live operating view |
| Home | Reconciled Sales & Traffic shopper spend incl. IVA; Today KPI uses normalized Orders on the same basis | Historical series remains reconciled-only |
| Sales | Shopper spend incl. IVA throughout | Historical periods/products = Sales & Traffic; Today/orders = Orders |
| Catalog | Reconciled CHILD-ASIN shopper spend incl. IVA attached once to canonical offer | Ads context remains separate |
| Product Workspace | Reconciled CHILD-ASIN shopper spend incl. IVA | Recent orders use the same gross basis |
| Inventory | Seller-SKU Orders units for velocity/cover | Replenishment is unit/cover-led |
| Trajectory | Reconciled Sales & Traffic shopper spend incl. IVA | Structural horizons are reconciled-only |
| Finance | Net sales ex IVA + IVA withheld + gross customer spend | CLOSED/RESTATED months are immutable snapshots; payout is separate cash timing |
| Ads | Ads attributed sales + independent seller-sales denominator | Attribution basis, maturity, freshness and trust are mandatory |

## SQL contracts

- `core.marketplace_tax_policy` — marketplace VAT rate plus observed Sales & Traffic amount basis.
- `mart.order_item_customer_spend` — normalized item-level shopper spend including tax.
- `mart.order_customer_spend` — normalized order-level shopper spend including tax with source metadata.
- `mart.order_sales_daily` — near-real-time gross shopper-spend rollup.
- `mart.sku_daily` — near-real-time seller-SKU gross shopper-spend/unit history; not canonical reconciled history.
- `mart.business_daily` — historical business series. `reconciled_daily_report` rows use Sales & Traffic; for DPP MX the monetary basis is shopper spend incl. IVA.
- `mart.catalog_portfolio_product` — canonical commercial offer identity; CHILD-ASIN Sales & Traffic is attached once to one offer owner.
- `mart.catalog_movers_t28` — reconciled CHILD-ASIN product movers mapped to canonical offer owners.
- `mart.today_operating` — live Today gross shopper spend and same-time benchmark.
- `mart.ads_product_business_t28` — Ads metrics plus independent full-window seller-sales denominator.
- `mart.ads_finance_month_context` — monthly Finance Ads candidate; advertising candidate is a negative management expense.
- `mart.finance_month_state` — accounting state; Amazon order release completeness requires every non-cancelled order released and zero DEFERRED events.
- `core.finance_month_close` — immutable accounting snapshot. DPP MX closes store net sales ex IVA, IVA withheld and gross shopper spend separately; tax-basis corrections append `RESTATED` versions.

## Presentation contract

Use the shortest label that remains unambiguous:

- Sales/Home/Catalog/Product/Trajectory: `Shopper spend` or `Sales`, with visible `incl. IVA` nearby; page-level notes state Sales & Traffic as the historical source.
- Today/order evidence: `Shopper spend incl. IVA`.
- Finance: always say `Net sales ex IVA`, `IVA withheld`, `Gross customer spend`, and `Payout` explicitly.
- Ads: always say `Attributed sales`, never just `sales` when the number is Ads-derived.

**Do not use “net sales” on an operating page for DPP Mexico Sales & Traffic.** Net revenue exists only after Finance removes IVA.
