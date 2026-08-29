# Commerce UI revamp QA

This block covers `/catalog`, `/product?sku=…`, and `/inventory`. It changes presentation only: route URLs,
API owners, payload meaning, metric windows, catalog identity, inventory actions, and query-state behavior remain
unchanged.

## Route hierarchy

- Products anchors portfolio KPIs, API-owned commercial decisions, analysis controls, then family/SKU evidence.
- Product Workspace anchors canonical identity, connected KPIs, demand evidence, the decision rail, order evidence,
  and variation-family context.
- Inventory anchors the API-owned action queue before the complete current/reference record evidence.
- Dense tables contain their own horizontal overflow. Phone layouts use product/inventory cards and explicit
  disclosures without hiding the canonical evidence scope.

All route color comes from the six approved presentation profiles. Route CSS contains no page palette literals,
evidence text is at least 14px, and primary controls use the shared 40–44px control height. Warm Studio, a dark
profile, and Weyland must be sampled on desktop and phone widths before deployment acceptance.

## Catalog runtime ownership

`catalog.js` is the only `/api/catalog` browser consumer and the only Catalog renderer. It renders Ads context
from the same cached payload during normal composition. The former `catalog-ads-context.js` fetch plus
`MutationObserver` enhancer is removed, and `board/scripts/catalog-cache-contract.mjs` rejects its return.

## Local gates

From the repository root:

```sh
node qa/commerce_ui_qa.mjs
node qa/commerce_ui_browser_qa.mjs
(cd board && npm run quality)
node --check qa/commerce_ui_qa.mjs
node --check qa/commerce_ui_browser_qa.mjs
```

The self-contained browser gate serves fixture-backed versions of the three routes and checks all routes at
320, 720, 721, 768, 900, 901, 1024, 1180, and 1600px. Warm Studio runs at every width; Midnight Dark and
Weyland sample phone, shell-constrained tablet, and wide desktop. Page overflow, evidence below 14px, primary
controls below 40px, any target below 24px, nested interactive controls, missing hierarchy anchors, console
errors, and profile mismatches fail the run. It also exercises Catalog URL restoration and non-family filter
visibility, Product control/tone state, and Inventory disclosure/filter/table semantics.

When a running board is available, also run the existing business-truth and browser gates:

```sh
node qa/analysis_state_qa.mjs http://127.0.0.1:8088 /out
node qa/accessibility_qa.mjs http://127.0.0.1:8088 /out
node qa/inventory_qa.mjs http://127.0.0.1:8088 /out
node qa/visual_qa.mjs http://127.0.0.1:8088 /out
```

Production acceptance records the exact deployed SHA and asset revision, checks console/response failures and
page-level overflow, and compares visible Catalog/Product/Inventory numbers and bases with their canonical APIs.
