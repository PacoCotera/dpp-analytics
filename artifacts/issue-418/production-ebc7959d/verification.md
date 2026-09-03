# Issue 418 production verification

- Deployment commit: `ebc7959dfb12d9c32f9210ef18681f778a66d214`
- Asset revision: `eab2405b2583`
- Production: `http://95.217.100.5:8088/`
- Engines: Chromium desktop/mobile, WebKit desktop/mobile, Firefox desktop.
- All inspected documents had one H1, zero document overflow, and no console/page errors.
- Today, Business, and Sales returned the identical Ads signature through 2026-09-01: spend 8917.6, attributed sales 11486.3, seller sales 16603, TACOS 0.5371077516111546, 28 observed days, 21 mature days.
- Business action restored `/ads?view=products&sku=PNC-001&action=ads-action-5e1dafb289164b&filter=opportunity_test`, highlighted PNC-001/action, and Back restored `/business`.
- Product demand restored `/ads?view=demand&sku=PNC-001`, rendered 20 bounded rows, and Back restored `/product?sku=PNC-001`.
- Inventory returned two `ADS_INVENTORY_EXPOSURE_REVIEW` v1 actions with economic claims disabled.
