import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const staticRoot = join(root, "board", "static");
const failures = [];
const results = [];

function metricWindow(id, label, source) {
  return {
    id,
    label,
    source,
    start_date: "2026-08-01",
    through_date: "2026-08-28",
    included_days: 28,
    source_as_of: "2026-08-29T00:00:00Z",
  };
}

const catalogProduct = {
  sku: "DPP-001",
  asin: "B000DPP001",
  product: "Evidence notebook",
  product_role: "SELLABLE_STANDALONE",
  catalog_membership: "CURRENT_OFFER",
  status: "Active",
  listing_sellable: true,
  commercial_state: "WATCH",
  commercial_explanation: "Demand is present; review available cover.",
  commercial_evaluation: {},
  variation_attributes: { ruling: "Dot grid" },
  sales_t28: 1640,
  units_t28: 20,
  sessions_t28: 180,
  conversion_t28_pct: 11.1,
  sales_delta28_pct: 8,
  sessions_delta28_pct: 4,
  available: 4,
  inbound: 8,
  days_cover_with_inbound: 16,
  unit_cogs: 28,
  estimated_cogs_t28: 560,
  ad_spend_t28: 120,
  ad_tacos_t28: 0.073,
  ad_roas_t28: 3.2,
  ad_attribution_state: "MATURE",
};

const catalogPayload = {
  local_time: "2026-08-28T18:00:00-06:00",
  summary: {
    families: 1,
    active_sellable: 1,
    selling_now: 1,
    sellable_offers: 1,
    sales_t28: 1640,
    units_t28: 20,
    sessions_t28: 180,
    conversion_t28_pct: 11.1,
    amazon_dimension_coverage: 1,
    traffic_through_date: "2026-08-28",
    listings_fetched_at: "2026-08-29T00:00:00Z",
    ad_spend_t28: 120,
    ad_tacos_t28: 0.073,
    ad_roas_t28: 3.2,
    ads_through_date: "2026-08-28",
  },
  metric_windows: {
    RECONCILED_PRODUCT_T28: metricWindow(
      "RECONCILED_PRODUCT_T28",
      "Reconciled product demand",
      "Amazon Sales & Traffic",
    ),
  },
  interpretation_rules: {},
  products: [catalogProduct],
  deleted_products: [
    {
      sku: "DPP-OLD",
      asin: "B000DPPOLD",
      product: "Historical notebook",
      catalog_membership: "DELETED",
      source_listing_status: "Inactive",
      last_seen_at: "2026-07-01T00:00:00Z",
    },
  ],
  families: [
    {
      family_asin: "B000DPP001",
      name: "Evidence notebook family",
      members: [catalogProduct],
      aliases: [],
      active_sellable_count: 1,
      catalog_lifecycle: "CURRENT_FAMILY",
      variation_dimensions: { ruling: ["Dot grid"] },
      primary_state: "WATCH",
      needs_attention: true,
      commercial_explanation: "Demand is present; review available cover.",
      commercial_evaluation: {},
      sales_t28: 1640,
      units_t28: 20,
      sessions_t28: 180,
      conversion_t28_pct: 11.1,
      available: 4,
      inbound: 8,
      days_cover_with_inbound: 16,
      estimated_cogs_t28: 560,
      cogs_known_units: 20,
      ad_spend_t28: 120,
      ad_tacos_t28: 0.073,
      ad_roas_t28: 3.2,
      ad_attribution_state: "MATURE",
    },
  ],
  dimensions: {
    ruling: [
      {
        dimension: "ruling",
        value: "Dot grid",
        sku_count: 1,
        active_sku_count: 1,
        family_count: 1,
        sales_t28: 1640,
        units_t28: 20,
        sessions_t28: 180,
        conversion_t28_pct: 11.1,
        available: 4,
        inbound: 8,
        estimated_cogs_t28: 560,
        conversion_evaluation: {},
      },
    ],
  },
  dimension_pairs: [],
};

const series = Array.from({ length: 28 }, (_, index) => ({
  business_date: `2026-08-${String(index + 1).padStart(2, "0")}`,
  sales: 40 + (index % 6) * 8,
  units: 1 + (index % 3),
}));

const productPayload = {
  local_time: "2026-08-28T18:00:00-06:00",
  business_date: "2026-08-28",
  profile: {
    ...catalogProduct,
    available: 0,
    listing_status: "Active",
    listing_price: 129,
    fulfillment_channel: "AMAZON",
    open_date: "2025-01-01",
    inventory_action: "STOCKOUT",
    inventory_units_t28: 20,
    units_per_day: 0.71,
    reserved: 2,
  },
  performance: { sales_t28: 1640, units_t28: 20, delta28_pct: 8 },
  traffic: { sessions_t28: 180, cvr_t28: 11.1 },
  economics: {
    unit_cogs: 28,
    estimated_cogs_t28: 560,
    cogs_pct_sales_t28: 34.1,
  },
  commercial: {
    ...catalogProduct,
    identity: {
      family_label: "Evidence notebook family",
      role: "Standalone offer",
    },
    family_name: "Evidence notebook family",
    commercial_evaluation: {},
  },
  ads: {
    connection: {
      state: "READY",
      badge: "Ads ready",
      note: "Reporting current",
      headline: "Ads reporting ready",
      detail: "Amazon Ads reporting is available.",
    },
    observed_ads_days: 28,
    mature_ads_days: 28,
    through_date: "2026-08-28",
    spend: 120,
    attributed_sales: 384,
    clicks: 36,
    ctr: 0.032,
    cpc: 3.33,
    acos: 0.3125,
    roas: 3.2,
    tacos: 0.073,
    trusted_for_operating_decisions: true,
    attribution_state: "MATURE",
  },
  metric_windows: {
    RECONCILED_PRODUCT_T28: metricWindow(
      "RECONCILED_PRODUCT_T28",
      "Reconciled product demand",
      "Amazon Sales & Traffic",
    ),
    INVENTORY_ORDER_VELOCITY_T28: metricWindow(
      "INVENTORY_ORDER_VELOCITY_T28",
      "Inventory order velocity",
      "Amazon Orders",
    ),
  },
  interpretation_rules: {},
  family_variations: [
    catalogProduct,
    { ...catalogProduct, sku: "DPP-002", product: "Plain notebook" },
  ],
  recent_orders: [
    {
      order_id: "ORDER-001",
      order_short: "ORDER-001",
      status: "Shipped",
      local_time: "2026-08-28T16:00:00-06:00",
      age_seconds: 7200,
      sales: 129,
      units: 1,
      fulfilled_by: "AMAZON",
      channel_name: "Amazon MX",
    },
  ],
  series,
};

const inventoryRows = [
  {
    ...catalogProduct,
    canonical_sku: "DPP-001",
    inventory_lifecycle: "CURRENT_OFFER",
    is_default_inventory: true,
    has_velocity: true,
    action: "STOCKOUT",
    available: 0,
    inbound: 4,
    reserved: 2,
    units_t28: 20,
    days_cover_with_inbound: 6,
  },
  {
    ...catalogProduct,
    sku: "DPP-HOLD",
    product: "Reference notebook",
    canonical_sku: "DPP-HOLD",
    inventory_lifecycle: "CURRENT_OFFER",
    is_default_inventory: true,
    has_velocity: false,
    action: "HOLD",
    available: 3,
    inbound: 0,
    reserved: 0,
    units_t28: 0,
    days_cover_with_inbound: null,
  },
];

const inventoryPayload = {
  local_time: "2026-08-28T18:00:00-06:00",
  summary: {
    latest_snapshot: "2026-08-29T00:00:00Z",
    portfolio_days_cover: 12,
    available: 3,
    inbound: 4,
    reserved: 2,
  },
  metric_windows: {
    INVENTORY_ORDER_VELOCITY_T28: metricWindow(
      "INVENTORY_ORDER_VELOCITY_T28",
      "Inventory order velocity",
      "Amazon Orders",
    ),
  },
  record_scope: { default_rows: 2 },
  rows: inventoryRows,
  bands: [
    { band: "Stockout", sku_count: 1 },
    { band: "<14 days", sku_count: 0 },
    { band: "14–27 days", sku_count: 0 },
    { band: "28+ days", sku_count: 0 },
  ],
};

const htmlRoutes = new Map([
  ["/catalog", "catalog.html"],
  ["/product", "product.html"],
  ["/inventory", "inventory.html"],
]);
const apiRoutes = new Map([
  ["/api/catalog", catalogPayload],
  ["/api/product", productPayload],
  ["/api/inventory", inventoryPayload],
]);
const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (apiRoutes.has(url.pathname)) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(apiRoutes.get(url.pathname)));
    return;
  }
  const html = htmlRoutes.get(url.pathname);
  if (html) {
    response.writeHead(200, { "content-type": mime[".html"] });
    response.end(readFileSync(join(staticRoot, html)));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    const relative = normalize(url.pathname.slice("/assets/".length));
    if (relative.startsWith("..")) {
      response.writeHead(403).end();
      return;
    }
    try {
      const path = join(staticRoot, relative);
      response.writeHead(200, {
        "content-type": mime[extname(path)] || "application/octet-stream",
      });
      response.end(readFileSync(path));
    } catch {
      response.writeHead(404).end();
    }
    return;
  }
  response.writeHead(404).end();
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });

const widthMatrix = [320, 720, 721, 768, 900, 901, 1024, 1180, 1600];
const cases = [
  ...widthMatrix.map((width) => ({ profile: "warm-studio", width })),
  ...[320, 1024, 1600].flatMap((width) => [
    { profile: "midnight-dark", width },
    { profile: "weyland", width },
  ]),
];
const routes = [
  {
    name: "catalog",
    path: "/catalog",
    ready: ".family",
    firstSurface: '[data-dpp-qa="catalog-decisions"]',
    anchors: [
      "catalog-overview",
      "catalog-decisions",
      "catalog-controls",
      "catalog-evidence",
    ],
  },
  {
    name: "product",
    path: "/product?sku=DPP-001",
    ready: "#chart .dpp-bar",
    firstSurface: '[data-dpp-qa="product-analysis"]',
    anchors: [
      "product-identity",
      "product-kpis",
      "product-analysis",
      "product-decisions",
      "product-order-evidence",
      "product-family-evidence",
    ],
  },
  {
    name: "inventory",
    path: "/inventory",
    ready: "#rows tr",
    readyState: "attached",
    firstSurface: '[data-dpp-qa="inventory-actions"]',
    anchors: [
      "inventory-overview",
      "inventory-actions",
      "inventory-controls",
      "inventory-records",
      "inventory-evidence",
    ],
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function inspectRoute(page, route, expectedProfile) {
  return page.evaluate(
    ({ routeName, profileId, anchors, firstSurface }) => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          element.getClientRects().length > 0
        );
      };
      const interactive = [
        ...document.querySelectorAll(
          "main a[href], main button, main input, main select, main summary",
        ),
      ]
        .filter(visible)
        .map((element) => ({
          tag: element.tagName,
          name: (
            element.getAttribute("aria-label") ||
            element.textContent ||
            ""
          )
            .trim()
            .slice(0, 80),
          width: element.getBoundingClientRect().width,
          height: element.getBoundingClientRect().height,
        }));
      const primarySelector =
        routeName === "catalog"
          ? ".mode, .filter, .search, .select, .rule-trigger, .analysis-open"
          : routeName === "product"
            ? "main button, main summary, .hero-price .btn"
            : ".how-btn, .filter, .search, .inventory-reference summary, .section-header__action";
      const primary = [...document.querySelectorAll(primarySelector)]
        .filter(visible)
        .map((element) => ({
          name: (
            element.getAttribute("aria-label") ||
            element.textContent ||
            ""
          )
            .trim()
            .slice(0, 80),
          height: element.getBoundingClientRect().height,
        }));
      const smallText = [...document.querySelectorAll("main *")]
        .filter(visible)
        .filter((element) =>
          [...element.childNodes].some(
            (node) =>
              node.nodeType === Node.TEXT_NODE &&
              String(node.textContent || "").trim(),
          ),
        )
        .map((element) => ({
          tag: element.tagName,
          className: element.className?.baseVal || element.className || "",
          text: element.textContent.trim().slice(0, 70),
          size: Number.parseFloat(getComputedStyle(element).fontSize),
        }))
        .filter(({ size }) => size < 14);
      const nested = document.querySelectorAll(
        "a button, a input, a select, a summary, summary button, summary input, summary select, summary a",
      ).length;
      const overflowElements = [...document.querySelectorAll("body *")]
        .filter(visible)
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.right > window.innerWidth + 1;
        })
        .map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            tag: element.tagName,
            className: element.className?.baseVal || element.className || "",
            left: Math.round(bounds.left),
            right: Math.round(bounds.right),
          };
        })
        .slice(0, 8);
      return {
        routeName,
        profileId: document.documentElement.dataset.dppTheme,
        profileKind: document.documentElement.dataset.dppProfile,
        chartStyle: document.documentElement.dataset.dppChartStyle,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        profileCount: window.dppPresentation?.listProfiles().length || 0,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        overflowElements,
        undersizedTargets: interactive.filter(
          ({ width, height }) => width < 24 || height < 24,
        ),
        undersizedPrimary: primary.filter(({ height }) => height < 40),
        smallText,
        nested,
        firstSurfaceTop:
          document.querySelector(firstSurface)?.getBoundingClientRect().top + window.scrollY,
        documentHeight: document.documentElement.scrollHeight,
        leadBounds: [...document.querySelectorAll("main > *")].slice(0, 6).map((element) => ({
          key: element.id || element.className,
          top: Math.round(element.getBoundingClientRect().top + window.scrollY),
          height: Math.round(element.getBoundingClientRect().height),
        })),
        visibleAnchors: anchors.filter((anchor) => {
          const element = document.querySelector(`[data-dpp-qa="${anchor}"]`);
          return element && visible(element);
        }),
        expectedProfile: profileId,
      };
    },
    {
      routeName: route.name,
      profileId: expectedProfile,
      anchors: route.anchors,
      firstSurface: route.firstSurface,
    },
  );
}

try {
  for (const testCase of cases) {
    for (const route of routes) {
      const context = await browser.newContext({
        viewport: { width: testCase.width, height: 900 },
      });
      await context.addInitScript((profileId) => {
        localStorage.setItem(
          "dpp.presentation.v1",
          JSON.stringify({ schemaVersion: 1, profileId }),
        );
      }, testCase.profile);
      const page = await context.newPage();
      const browserErrors = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push(message.text());
      });
      const response = await page.goto(`${baseUrl}${route.path}`, {
        waitUntil: "networkidle",
        timeout: 20_000,
      });
      assert(
        response?.ok(),
        `${route.name}/${testCase.width}: navigation failed`,
      );
      await page
        .locator(route.ready)
        .first()
        .waitFor({
          state: route.readyState || "visible",
          timeout: 10_000,
        });
      const state = await inspectRoute(page, route, testCase.profile);
      assert(
        state.profileId === testCase.profile,
        `${route.name}/${testCase.width}: ${state.profileId} profile`,
      );
      assert(
        state.profileCount === 6,
        `${route.name}/${testCase.width}: ${state.profileCount} profiles`,
      );
      if (testCase.profile === "midnight-dark") {
        assert(
          state.colorScheme.includes("dark"),
          `${route.name}/${testCase.width}: dark scheme missing`,
        );
      }
      if (testCase.profile === "weyland") {
        assert(
          state.profileKind === "weyland" &&
            state.chartStyle === "outlined-vector",
          `${route.name}/${testCase.width}: Weyland profile attributes missing`,
        );
      }
      assert(
        state.overflow <= 1,
        `${route.name}/${testCase.width}: page overflow ${state.overflow}px ${JSON.stringify(state.overflowElements)}`,
      );
      assert(
        state.undersizedTargets.length === 0,
        `${route.name}/${testCase.width}: targets below 24px ${JSON.stringify(state.undersizedTargets)}`,
      );
      assert(
        state.undersizedPrimary.length === 0,
        `${route.name}/${testCase.width}: primary controls below 40px ${JSON.stringify(state.undersizedPrimary)}`,
      );
      assert(
        state.smallText.length === 0,
        `${route.name}/${testCase.width}: evidence below 14px ${JSON.stringify(state.smallText.slice(0, 8))}`,
      );
      assert(
        state.nested === 0,
        `${route.name}/${testCase.width}: ${state.nested} nested interactive controls`,
      );
      assert(
        state.visibleAnchors.length === route.anchors.length,
        `${route.name}/${testCase.width}: missing visible hierarchy anchors ${route.anchors.filter((anchor) => !state.visibleAnchors.includes(anchor)).join(", ")}`,
      );
      if (testCase.width <= 480) {
        assert(
          state.firstSurfaceTop <= 760,
          `${route.name}/${testCase.width}: first decision surface starts at ${Math.round(state.firstSurfaceTop)}px ${JSON.stringify(state.leadBounds)}`,
        );
      }
      assert(
        browserErrors.length === 0,
        `${route.name}/${testCase.width}: ${browserErrors.join("; ")}`,
      );

      if (testCase.profile === "warm-studio" && testCase.width === 1024) {
        if (route.name === "catalog") {
          await page.locator('[data-mode="sku"]').click();
          assert(
            new URL(page.url()).searchParams.get("mode") === "sku",
            "Catalog SKU mode lost URL state",
          );
          assert(
            await page.locator(".catalog-filter-field").isHidden(),
            "Catalog SKU mode left filter label visible",
          );
          await page.goBack();
          await page
            .locator('[data-mode="family"][aria-pressed="true"]')
            .waitFor();
          assert(
            await page.locator(".catalog-filter-field").isVisible(),
            "Catalog Family mode hid filter controls",
          );
          for (const mode of ["dimension:ruling", "deleted"]) {
            await page.locator(`[data-mode="${mode}"]`).click();
            assert(
              new URL(page.url()).searchParams.get("mode") === mode,
              `Catalog ${mode} mode lost URL state`,
            );
            assert(
              await page.locator(".catalog-filter-field").isHidden(),
              `Catalog ${mode} mode left filter label visible`,
            );
          }
          await page.locator('[data-mode="family"]').click();
          assert(
            !new URL(page.url()).searchParams.has("mode") &&
              (await page.locator(".catalog-filter-field").isVisible()),
            "Catalog Family mode did not restore controls and canonical URL state",
          );
        } else if (route.name === "product") {
          await page.locator('[data-metric="units"]').click();
          await page.locator('[data-days="90"]').click();
          assert(
            (await page
              .locator('[data-metric="units"]')
              .getAttribute("aria-pressed")) === "true" &&
              (await page
                .locator('[data-days="90"]')
                .getAttribute("aria-pressed")) === "true",
            "Product chart controls did not expose pressed state",
          );
          assert(
            (await page
              .locator(".decision-block--inventory")
              .getAttribute("data-tone")) === "critical",
            "Product STOCKOUT decision is not rendered with critical semantics",
          );
        } else {
          await page.locator("#howBtn").click();
          assert(
            (await page.locator("#howBtn").getAttribute("aria-expanded")) ===
              "true",
            "Inventory disclosure state failed",
          );
          await page.locator('[data-filter="no_velocity"]').click();
          assert(
            (await page.locator("#rows tr").count()) === 1,
            "Inventory no-velocity filter changed truth scope",
          );
          const table = await page
            .locator(".inventory-table")
            .evaluate((element) => ({
              caption: element.querySelector("caption")?.textContent.trim(),
              columns: element.querySelectorAll('thead th[scope="col"]').length,
              rows: element.querySelectorAll('tbody th[scope="row"]').length,
            }));
          assert(
            table.caption === "Inventory records and actions" &&
              table.columns === 10 &&
              table.rows === 1,
            `Inventory table semantics failed: ${JSON.stringify(table)}`,
          );
        }
      }

      results.push({
        route: route.name,
        ...testCase,
        firstSurfaceTop: state.firstSurfaceTop,
        documentHeight: state.documentHeight,
        state: "PASS",
      });
      await context.close();
    }
  }
} catch (error) {
  failures.push(error.message);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  console.error(
    JSON.stringify(
      { status: "FAIL", failures, completed: results.length },
      null,
      2,
    ),
  );
  process.exit(1);
}

for (const route of routes) {
  const warm = results.find(
    (result) =>
      result.route === route.name &&
      result.profile === "warm-studio" &&
      result.width === 320,
  );
  const weyland = results.find(
    (result) =>
      result.route === route.name && result.profile === "weyland" && result.width === 320,
  );
  assert(
    weyland.documentHeight <= warm.documentHeight * 1.2,
    `${route.name}/320: Weyland is ${Math.round((weyland.documentHeight / warm.documentHeight) * 100)}% of Warm Studio height`,
  );
}

console.log(
  JSON.stringify(
    { status: "PASS", checks: results.length, widths: widthMatrix },
    null,
    2,
  ),
);
