# Issue #418 final production verification

Verified: 2026-09-03
Production: http://95.217.100.5:8088/
Final merged and deployed SHA: `7bd20ee6af7e0e543503737032f4d83e2034049f`
Rendered build marker: `main 7bd20ee6`
Asset revision: `eab2405b2583`

## Delivery

- Implementation PR: #419 (`ebc7959dfb12d9c32f9210ef18681f778a66d214`)
- QA completion/runtime fix: #420 (`867e9e559696de9d5710d45bd1ba0773f89c1b04`)
- Visual-contract alignment: #421 (`7bd20ee6af7e0e543503737032f4d83e2034049f`)
- Final deployment workflow: run 33717065474
- Production QA artifact: `dpp-production-visual-qa-33717065474` (artifact ID 9879385420)

## Official production gate

- workflow status: success
- suite exit code: 0
- 220/220 visual captures
- 0 browser errors
- 0 failed local HTTP responses
- 0 overflow captures
- Ads cross-route QA: 26 checks passed
- accessibility: 11/11
- analysis state: 31 checks
- Ads surface: 21 checks
- percentage formatting: 4 engine/viewport scenarios
- navigation: 3/3
- footer/build semantics: 24/24
- short-state footer: 108 checks
- all reported browser, data, responsive, interpretation, inventory and admin summaries passed

## Standalone DPP Playwright

Five independent persistent sessions were refreshed against the final production SHA:

| Engine/device | Route | Evidence |
| --- | --- | --- |
| Chromium desktop 1440×1000 | `/sales?view=products` | seller sales $16,603; spend $8,918; TACOS 53.7%; attributed sales $11,486; one H1; no overflow |
| WebKit desktop 1440×1000 | `/business` | decision-grade Ads context; exact PNC-001 action destination; one H1; no overflow |
| Firefox desktop 1440×1000 | `/inventory` | two bounded fulfillment-readiness reviews; eight current paid-support rows; neutral non-prescriptive note; one H1; no overflow |
| Chromium mobile 393×727 | `/today` | latest-completed paid-support watch; explicit “not today’s advertising” and non-incrementality language; one H1; no overflow |
| WebKit mobile 390×664 | `/product?sku=PNC-001` | full SKU funnel and business context; economics suppression; exact Product and Demand links; one H1; no overflow |

Every session rendered build `7bd20ee6`, asset revision `eab2405b2583`, and produced no console or page errors.

## Interaction and state evidence

Business → Advertising:
- destination: `/ads?view=products&sku=PNC-001&action=ads-action-5e1dafb289164b&filter=opportunity_test`
- restored Products & actions
- highlighted PNC-001 and action `ads-action-5e1dafb289164b`
- browser Back restored `/business?verify=7bd20ee6`

Product → Demand:
- destination: `/ads?view=demand&sku=PNC-001`
- restored Demand discovery and SKU
- demand-signal table bounded to 20 rows on mobile
- browser Back restored `/product?sku=PNC-001&verify=7bd20ee6`

## Interpretation safety

Rendered and API evidence preserve:
- Amazon-attributed sales are attribution, not incrementality.
- Seller sales minus attributed sales is not labeled organic sales.
- Product economics are explicitly unavailable until reconciled in Finance.
- No pause, bid, budget, scale, winner, profitability, or spend-reduction directive is issued.
- Inventory combines paid-support context with an API-owned fulfillment-readiness review and remains non-prescriptive.
