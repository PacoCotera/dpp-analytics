import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const BUSINESS = "RECONCILED_BUSINESS_T28";
const PRODUCT = "RECONCILED_PRODUCT_T28";
const INVENTORY = "INVENTORY_ORDER_VELOCITY_T28";
const failures = [];
const summary = { ok: false, contracts: {}, sharedValues: {}, surfaces: [] };

function fail(message) {
  failures.push(message);
}

function numeric(value) {
  return Number(value || 0);
}

function assertClose(label, actual, expected, tolerance = 0.01) {
  if (Math.abs(numeric(actual) - numeric(expected)) > tolerance) {
    fail(`${label}: ${actual} != ${expected}`);
  }
}

function fingerprint(window) {
  return JSON.stringify({
    id: window?.id,
    source_id: window?.source_id,
    grain: window?.grain,
    included_days: window?.included_days,
    start_date: window?.start_date,
    through_date: window?.through_date,
    source_as_of: window?.source_as_of,
    timezone: window?.timezone,
  });
}

function validateWindow(surface, window) {
  const required = [
    "id",
    "label",
    "source_id",
    "source",
    "grain",
    "definition",
    "start_date",
    "through_date",
    "source_as_of",
    "timezone",
  ];
  for (const field of required) {
    if (!window?.[field])
      fail(`${surface} ${window?.id || "window"} is missing ${field}`);
  }
  if (Number(window?.included_days) !== 28)
    fail(`${surface} does not disclose 28 included days`);
  const start = new Date(`${window?.start_date}T12:00:00Z`);
  const through = new Date(`${window?.through_date}T12:00:00Z`);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(through.getTime())
  ) {
    fail(`${surface} has invalid included dates`);
  } else if (Math.round((through - start) / 86400000) + 1 !== 28) {
    fail(`${surface} date range is not 28 inclusive days`);
  }
}

async function api(route) {
  const separator = route.includes("?") ? "&" : "?";
  const response = await fetch(
    `${baseUrl}${route}${separator}refresh=metric-window-qa`,
    {
      cache: "no-store",
    },
  );
  if (!response.ok) throw new Error(`${route} returned ${response.status}`);
  return response.json();
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("console", (message) => {
  if (message.type() === "error") fail(`console: ${message.text()}`);
});
page.on("pageerror", (error) => fail(`page: ${error.message}`));

try {
  const [home, sales, catalog, inventory, trajectory] = await Promise.all([
    api("/api/home"),
    api("/api/sales"),
    api("/api/catalog"),
    api("/api/inventory"),
    api("/api/trajectory"),
  ]);

  const windows = {
    homeBusiness: home.metric_windows?.[BUSINESS],
    salesBusiness: sales.metric_windows?.[BUSINESS],
    salesProduct: sales.metric_windows?.[PRODUCT],
    catalogProduct: catalog.metric_windows?.[PRODUCT],
    inventoryVelocity: inventory.metric_windows?.[INVENTORY],
    trajectoryBusiness: trajectory.metric_windows?.[BUSINESS],
  };
  for (const [surface, window] of Object.entries(windows))
    validateWindow(surface, window);

  const businessFingerprint = fingerprint(windows.salesBusiness);
  if (fingerprint(windows.homeBusiness) !== businessFingerprint)
    fail("Home and Sales business windows differ");
  if (fingerprint(windows.trajectoryBusiness) !== businessFingerprint)
    fail("Trajectory and Sales business windows differ");
  const productFingerprint = fingerprint(windows.salesProduct);
  if (fingerprint(windows.catalogProduct) !== productFingerprint)
    fail("Catalog and Sales product windows differ");
  if (windows.salesProduct?.source_id === windows.inventoryVelocity?.source_id)
    fail("Product demand and inventory velocity share a source identifier");
  if (windows.salesProduct?.grain === windows.inventoryVelocity?.grain)
    fail("Product demand and inventory velocity share a grain");

  const horizon28 =
    (trajectory.horizons || []).find((row) => row.label === "28D") || {};
  for (const [key, trajectoryKey] of [
    ["sales_t28", "sales"],
    ["orders_t28", "orders"],
    ["units_t28", "units"],
  ]) {
    assertClose(
      `Home/Sales ${key}`,
      home.rolling?.[key],
      sales.headline?.[key],
    );
    assertClose(
      `Trajectory/Sales ${key}`,
      horizon28[trajectoryKey],
      sales.headline?.[key],
    );
  }

  const currentOffers = (catalog.products || []).filter(
    (row) =>
      row.is_offer_owner &&
      ["SELLABLE_VARIATION", "SELLABLE_STANDALONE"].includes(
        row.product_role,
      ) &&
      String(row.catalog_membership || "").toUpperCase() === "CURRENT_OFFER",
  );
  if (!currentOffers.length)
    fail("Catalog has no current canonical offers to reconcile");
  if (currentOffers.length !== Number(catalog.summary?.sellable_offers || 0))
    fail(
      `Catalog current-offer contract returned ${currentOffers.length} rows but summary reports ${catalog.summary?.sellable_offers}`,
    );
  const catalogBySku = new Map(currentOffers.map((row) => [row.sku, row]));
  for (const row of sales.skus || []) {
    const catalogRow = catalogBySku.get(row.sku);
    if (!catalogRow) {
      fail(`Sales product ${row.sku} is not a current canonical Catalog offer`);
      continue;
    }
    assertClose(
      `${row.sku} Sales/Catalog product sales`,
      row.sales_t28,
      catalogRow.sales_t28,
    );
    assertClose(
      `${row.sku} Sales/Catalog product units`,
      row.units_t28,
      catalogRow.units_t28,
      0,
    );
  }

  const productPayloads = await Promise.all(
    currentOffers.map((row) =>
      api(`/api/product?sku=${encodeURIComponent(row.sku)}`),
    ),
  );
  for (const [index, productPayload] of productPayloads.entries()) {
    const row = currentOffers[index];
    const productWindow = productPayload.metric_windows?.[PRODUCT];
    const inventoryWindow = productPayload.metric_windows?.[INVENTORY];
    validateWindow(`product ${row.sku}`, productWindow);
    validateWindow(`product inventory ${row.sku}`, inventoryWindow);
    if (fingerprint(productWindow) !== productFingerprint)
      fail(`${row.sku} Product and Catalog demand windows differ`);
    if (fingerprint(inventoryWindow) !== fingerprint(windows.inventoryVelocity))
      fail(`${row.sku} Product and Inventory velocity windows differ`);
    assertClose(
      `${row.sku} Product/Catalog sales`,
      productPayload.performance?.sales_t28,
      row.sales_t28,
    );
    assertClose(
      `${row.sku} Product/Catalog units`,
      productPayload.performance?.units_t28,
      row.units_t28,
      0,
    );
    const inventoryRow = (inventory.rows || []).find(
      (item) => item.sku === row.sku,
    );
    if (inventoryRow) {
      assertClose(
        `${row.sku} Product/Inventory order units`,
        productPayload.profile?.inventory_units_t28,
        inventoryRow.units_t28,
        0,
      );
    }
  }

  const surfaceChecks = [
    {
      route: "/",
      selector: "#homeBusinessWindow",
      patterns: [/Sales & Traffic/i, /source updated/i, /28 included days/i],
    },
    {
      route: "/inventory",
      selector: "#inventoryVelocityWindow",
      patterns: [/Amazon Orders/i, /source updated/i, /28 included days/i],
    },
    {
      route: "/sales",
      selector: "#salesBusinessWindow",
      patterns: [/Sales & Traffic/i, /source updated/i, /28 included days/i],
    },
    {
      route: "/catalog",
      selector: "#catalogDemandWindow",
      patterns: [/CHILD-ASIN/i, /source updated/i, /28 included days/i],
    },
    {
      route: `/product?sku=${encodeURIComponent(currentOffers[0]?.sku || "PNC-001")}`,
      selector: "#productDemandWindow",
      patterns: [/CHILD-ASIN/i, /source updated/i, /28 included days/i],
    },
    {
      route: "/trajectory",
      selector: "#trajectoryBusinessWindow",
      patterns: [/Sales & Traffic/i, /source updated/i, /28 included days/i],
    },
  ];
  for (const check of surfaceChecks) {
    await page.goto(`${baseUrl}${check.route}`, {
      waitUntil: "networkidle",
      timeout: 30000,
    });
    const element = page.locator(check.selector);
    await element.waitFor({ state: "visible", timeout: 15000 });
    const text = ((await element.textContent()) || "").trim();
    for (const pattern of check.patterns) {
      if (!pattern.test(text))
        fail(`${check.route} disclosure does not match ${pattern}: ${text}`);
    }
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    if (overflow > 1)
      fail(`${check.route} has ${overflow}px horizontal overflow`);
    summary.surfaces.push({ route: check.route, disclosure: text });
  }

  await page.goto(`${baseUrl}/sales`, {
    waitUntil: "networkidle",
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Drivers" }).click();
  const driverWindow = page.locator("#salesProductWindow");
  await driverWindow.waitFor({ state: "visible", timeout: 5000 });
  const driverText = ((await driverWindow.textContent()) || "").trim();
  if (!/CHILD-ASIN/i.test(driverText) || !/source updated/i.test(driverText))
    fail(`Sales Drivers disclosure is incomplete: ${driverText}`);

  summary.contracts = windows;
  summary.sharedValues = {
    business: {
      sales: sales.headline?.sales_t28,
      orders: sales.headline?.orders_t28,
      units: sales.headline?.units_t28,
    },
    currentOffersChecked: currentOffers.length,
    salesProductsChecked: (sales.skus || []).length,
  };
  summary.failures = failures;
  summary.ok = failures.length === 0;
  await fs.writeFile(
    path.join(outDir, "metric-windows-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  summary.error = error.message;
  summary.failures = failures;
  await fs.writeFile(
    path.join(outDir, "metric-windows-summary.json"),
    JSON.stringify(summary, null, 2),
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
