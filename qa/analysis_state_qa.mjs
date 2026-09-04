import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const failures = [];
const checks = [];
let renderedAdsPayload = null;
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") failures.push(`console: ${message.text()}`);
});
page.on("response", (response) => {
  if (
    response.ok() &&
    response.url().startsWith(baseUrl) &&
    new URL(response.url()).pathname === "/api/ads"
  ) {
    renderedAdsPayload = response.json().catch(() => null);
  }
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function currentParams() {
  return new URL(page.url()).searchParams;
}

function assertParam(name, expected) {
  const actual = currentParams().get(name);
  assert(
    actual === expected,
    `${name} is ${actual}, expected ${expected} in ${page.url()}`,
  );
}

async function salesState() {
  return page.evaluate(() => ({
    view: document.querySelector(".tabs [data-view].active")?.dataset.view,
    range: document.querySelector(
      '.sales-range [data-range][aria-pressed="true"]',
    )?.dataset.range,
    geoRange: document.querySelector('[data-geo-range][aria-pressed="true"]')
      ?.dataset.geoRange,
    metric: document.getElementById("geoMetric")?.value,
    sku: document.getElementById("geoProduct")?.value,
    state: document.getElementById("geoStateSelect")?.value,
  }));
}

async function catalogState() {
  return page.evaluate(() => ({
    mode: document.querySelector('[data-mode][aria-pressed="true"]')?.dataset
      .mode,
    filter: document.querySelector('[data-filter][aria-pressed="true"]')
      ?.dataset.filter,
    sort: document.getElementById("sort")?.value,
  }));
}

async function catalogRows() {
  return page.evaluate(() => {
    const number = (node) =>
      Number(
        String(node?.textContent || "")
          .replace(/−/g, "-")
          .replace(/[^0-9.-]/g, ""),
      );
    const fromRow = (row, nameSelector) => ({
      id: row.dataset.family || "",
      name: row.querySelector(nameSelector)?.textContent?.trim() || "",
      sales: number(
        row.querySelector(
          ":scope > summary .metric-sales strong, :scope > .metric-sales strong",
        ),
      ),
      traffic: number(
        row.querySelector(
          ":scope > summary .metric-funnel strong, :scope > .metric-funnel strong",
        ),
      ),
      conversion: number(
        row.querySelector(
          ":scope > summary .metric-funnel b, :scope > .metric-funnel b",
        ),
      ),
      stock: number(
        row.querySelector(
          ":scope > summary .metric-stock b, :scope > .metric-stock b",
        ),
      ),
    });
    const families = [...document.querySelectorAll("#portfolio > .family")].map(
      (row) => fromRow(row, ".family-name"),
    );
    if (families.length) return families;
    return [...document.querySelectorAll("#portfolio > .analysis-row")].map(
      (row) => fromRow(row, ".analysis-identity strong"),
    );
  });
}

async function inventoryState() {
  return page.evaluate(() => ({
    scope: document.querySelector('.filter[aria-pressed="true"]')?.dataset
      .filter,
    search: document.getElementById("search")?.value,
    rows: [
      ...document.querySelectorAll("#rows tr th[scope='row'] .product-sku"),
    ].map((node) => node.textContent?.trim()),
  }));
}

async function adsState() {
  return page.evaluate(() => ({
    view: document.querySelector('[data-ads-view][aria-selected="true"]')
      ?.dataset.adsView,
    sku: document.getElementById("demandSku")?.value || "",
    campaign: document.getElementById("demandCampaign")?.value || "",
    signalType: document.getElementById("demandType")?.value || "",
    filter: document.getElementById("demandFilter")?.value || "",
    sort: document.getElementById("demandSort")?.value || "",
    search: document.getElementById("demandSearch")?.value || "",
    page: document.getElementById("demandPage")?.textContent?.trim() || "",
    highlightedSignal:
      document.querySelector("#demandRows tr.is-highlighted")?.dataset
        .signalId || "",
  }));
}

function expectedInventoryRows(payload, scope, search = "") {
  const attentionActions = new Set(["STOCKOUT", "PRODUCE", "PLAN"]);
  const query = String(search || "")
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim()
    .toLowerCase();
  return (payload.rows || [])
    .filter((row) => {
      if (
        query &&
        !`${row.product || ""} ${row.sku || ""} ${row.canonical_sku || ""}`
          .toLowerCase()
          .includes(query)
      )
        return false;
      if (scope === "current" && !row.is_default_inventory) return false;
      if (
        scope === "attention" &&
        (!row.is_default_inventory || !attentionActions.has(row.action))
      )
        return false;
      if (scope === "ok" && (!row.is_default_inventory || row.action !== "OK"))
        return false;
      if (scope === "no_velocity" && row.has_velocity) return false;
      if (scope === "alias" && row.inventory_lifecycle !== "ALIAS")
        return false;
      if (scope === "retired" && row.inventory_lifecycle !== "RETIRED")
        return false;
      if (scope === "archived" && row.inventory_lifecycle !== "ARCHIVED")
        return false;
      return true;
    })
    .map((row) => row.sku);
}

async function assertInventoryView(payload, scope, search = "") {
  const inventory = await inventoryState();
  const expectedRows = expectedInventoryRows(payload, scope, search);
  assert(
    inventory.scope === scope,
    `Inventory selected ${inventory.scope}, expected ${scope}`,
  );
  assert(
    inventory.search === search,
    `Inventory search is ${inventory.search}, expected ${search}`,
  );
  assert(
    JSON.stringify(inventory.rows) === JSON.stringify(expectedRows),
    `Inventory ${scope}/${search} rows are wrong: ${JSON.stringify(inventory.rows)} vs ${JSON.stringify(expectedRows)}`,
  );
  return inventory;
}

async function productState() {
  return page.evaluate(() => {
    const days = document.querySelector('[data-days][aria-pressed="true"]')
      ?.dataset.days;
    return {
      metric: document.querySelector('[data-metric][aria-pressed="true"]')
        ?.dataset.metric,
      window: days === "ytd" ? "ytd" : `${days}d`,
      description: document.getElementById("chartSub")?.textContent?.trim(),
      signature: [...document.querySelectorAll("#chart .dpp-bar")].map(
        (node) => ({
          businessDate: String(node.__data__?.business_date || ""),
          sales: Number(node.__data__?.sales || 0),
          units: Number(node.__data__?.units || 0),
          value: Number(node.__data__?.value || 0),
        }),
      ),
    };
  });
}

function expectedProductRows(payload, windowKey) {
  const series = payload.series || [];
  if (windowKey === "ytd") {
    const year = String(series.at(-1)?.business_date || "").slice(0, 4);
    return year
      ? series.filter((row) => String(row.business_date || "").startsWith(year))
      : series;
  }
  return series.slice(-Number.parseInt(windowKey, 10));
}

async function assertProductView(payload, metric, windowKey) {
  const state = await productState();
  const expectedRows = expectedProductRows(payload, windowKey);
  const expectedSignature = expectedRows.map((row) => ({
    businessDate: String(row.business_date || ""),
    sales: Number(row.sales || 0),
    units: Number(row.units || 0),
    value: Number(metric === "units" ? row.units || 0 : row.sales || 0),
  }));
  const expectedDescription =
    metric === "units"
      ? "Units ordered · reconciled Amazon Sales & Traffic"
      : "Shopper spend incl. IVA · reconciled Amazon Sales & Traffic";
  const expectedWindow =
    windowKey === "ytd"
      ? "year to date"
      : `last ${Number.parseInt(windowKey, 10)} days`;
  assert(
    state.metric === metric && state.window === windowKey,
    `Product controls restored ${state.metric}/${state.window}, expected ${metric}/${windowKey}`,
  );
  assert(
    state.description === `${expectedDescription} · ${expectedWindow}`,
    `Product ${metric}/${windowKey} description is wrong: ${state.description}`,
  );
  assert(
    JSON.stringify(state.signature) === JSON.stringify(expectedSignature),
    `Product ${metric}/${windowKey} chart is not synchronized to the API series`,
  );
  return state;
}

async function waitForProductControls(metric, windowKey) {
  await page.waitForFunction(
    ([expectedMetric, expectedWindow]) => {
      const days = document.querySelector('[data-days][aria-pressed="true"]')
        ?.dataset.days;
      return (
        document.querySelector('[data-metric][aria-pressed="true"]')?.dataset
          .metric === expectedMetric &&
        (days === "ytd" ? "ytd" : `${days}d`) === expectedWindow
      );
    },
    [metric, windowKey],
  );
}

async function trajectoryState() {
  return page.evaluate(() => ({
    selected: document.querySelector(
      '[data-trajectory-window][aria-pressed="true"]',
    )?.dataset.trajectoryWindow,
    description: document
      .getElementById("trajectoryChartDescription")
      ?.textContent?.trim(),
    barCount: document.querySelectorAll("#chart .dpp-bar").length,
  }));
}

function expectedTrajectoryState(payload, selected) {
  const series = payload.series || [];
  let rows;
  if (selected === "90d") rows = series.slice(-90);
  else if (selected === "ytd") {
    const year = String(series.at(-1)?.business_date || "").slice(0, 4);
    rows = series.filter((row) =>
      String(row.business_date || "").startsWith(year),
    );
  } else rows = series.slice(-180);

  const weekly = rows.length > 120;
  const marks = weekly
    ? new Set(
        rows.map((row) => {
          const date = new Date(`${row.business_date}T00:00:00Z`);
          date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
          return date.toISOString().slice(0, 10);
        }),
      ).size
    : rows.length;
  const label =
    selected === "90d"
      ? "90 days"
      : selected === "ytd"
        ? "Year to date"
        : "180 days";
  return {
    marks,
    descriptionStart: `${label} · ${weekly ? "weekly average daily" : "daily"}`,
  };
}

async function assertTrajectoryWindow(payload, selected) {
  const state = await trajectoryState();
  const expected = expectedTrajectoryState(payload, selected);
  assert(
    state.selected === selected,
    `Trajectory selected ${state.selected}, expected ${selected}`,
  );
  assert(
    state.description?.startsWith(expected.descriptionStart),
    `Trajectory ${selected} aggregation label is wrong: ${state.description}`,
  );
  assert(
    state.barCount === expected.marks,
    `Trajectory ${selected} rendered ${state.barCount} marks, expected ${expected.marks}`,
  );
  return state;
}

async function financeState() {
  return page.evaluate(() => ({
    window: document.querySelector(
      '[data-finance-window][aria-selected="true"]',
    )?.dataset.financeWindow,
    month: document.getElementById("monthPicker")?.value?.slice(0, 7),
    includeCogs:
      document.getElementById("cogsToggle")?.getAttribute("aria-pressed") ===
      "true",
    title: document.getElementById("progressionTitle")?.textContent?.trim(),
    description: document.getElementById("progressionSub")?.textContent?.trim(),
    aria: document.getElementById("progression")?.getAttribute("aria-label"),
    months: [...document.querySelectorAll("#progression [data-month]")].map(
      (node) => node.dataset.month?.slice(0, 7),
    ),
    signature: [
      ...document.querySelectorAll("#progression .finance-chart-bar"),
    ].map((node) => [
      node.getAttribute("class"),
      node.getAttribute("x"),
      node.getAttribute("y"),
      node.getAttribute("height"),
      node.parentElement?.querySelector("title")?.textContent || "",
    ]),
  }));
}

function financeRows(payload) {
  const rows = (payload.closed_months || [])
    .map((row) => ({ ...row, current: false }))
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));
  const current = payload.current_month || {};
  if (current.month) {
    rows.push({
      month: current.month,
      contribution_after_product_cogs:
        current.estimated_contribution_before_current_ads,
      current: true,
    });
  }
  return rows;
}

function expectedFinanceMonths(payload, windowKey) {
  const rows = financeRows(payload);
  const currentMonth = payload.current_month?.month;
  const currentDate = new Date(`${String(currentMonth).slice(0, 10)}T12:00:00`);
  const currentOrdinal =
    currentDate.getFullYear() * 12 + currentDate.getMonth();
  return rows
    .filter((row) => {
      const date = new Date(`${String(row.month).slice(0, 10)}T12:00:00`);
      const ordinal = date.getFullYear() * 12 + date.getMonth();
      if (windowKey === "3m")
        return ordinal >= currentOrdinal - 2 && ordinal <= currentOrdinal;
      if (windowKey === "ytd")
        return date.getFullYear() === currentDate.getFullYear();
      if (windowKey === "12m")
        return ordinal >= currentOrdinal - 11 && ordinal <= currentOrdinal;
      if (windowKey === "lastYear")
        return date.getFullYear() === currentDate.getFullYear() - 1;
      return true;
    })
    .filter(
      (row) =>
        row.contribution_after_product_cogs !== null &&
        row.contribution_after_product_cogs !== undefined,
    )
    .map((row) => String(row.month).slice(0, 7));
}

async function assertFinanceWindow(payload, windowKey, includeCogs = true) {
  const state = await financeState();
  assert(
    state.window === windowKey,
    `Finance selected ${state.window}, expected ${windowKey}`,
  );
  assert(
    state.includeCogs === includeCogs,
    `Finance ${windowKey} COGS state is ${state.includeCogs}, expected ${includeCogs}`,
  );
  if (windowKey !== "month") {
    const expectedMonths = expectedFinanceMonths(payload, windowKey);
    assert(
      JSON.stringify(state.months) === JSON.stringify(expectedMonths),
      `Finance ${windowKey} chart months are wrong: ${JSON.stringify(state.months)} vs ${JSON.stringify(expectedMonths)}`,
    );
    assert(
      state.aria?.includes(
        includeCogs ? "product COGS included" : "product COGS excluded",
      ),
      `Finance ${windowKey} chart label does not expose the COGS basis: ${state.aria}`,
    );
  }
  assert(
    state.signature.length > 0,
    `Finance ${windowKey} rendered no chart signature`,
  );
  return state;
}

function assertCatalogOrder(rows, sort, mode, familyAttention) {
  assert(
    rows.length > 1,
    `${mode}/${sort} did not render enough rows to verify ordering`,
  );
  const compare = (previous, current) => {
    if (sort === "name") return previous.name.localeCompare(current.name) <= 0;
    if (sort === "stock") return previous.stock <= current.stock;
    const key = sort === "attention" ? "sales" : sort;
    if (sort === "attention" && mode === "family") {
      const previousAttention = familyAttention.get(previous.id) ? 1 : 0;
      const currentAttention = familyAttention.get(current.id) ? 1 : 0;
      return (
        previousAttention > currentAttention ||
        (previousAttention === currentAttention &&
          previous.sales >= current.sales)
      );
    }
    return previous[key] >= current[key];
  };
  assert(
    rows.slice(1).every((row, index) => compare(rows[index], row)),
    `${mode}/${sort} row order is not canonical: ${JSON.stringify(rows)}`,
  );
}

try {
  await page.goto(
    `${baseUrl}/sales?view=geography&geo_range=30d&metric=orders&sku=PNC-001&state=09&trace=keep`,
    { waitUntil: "networkidle", timeout: 20000 },
  );
  await page.locator("#geography.view.active").waitFor({ timeout: 8000 });
  await page.locator("#geoRankedRows tr").first().waitFor({ timeout: 10000 });
  let state = await salesState();
  assert(
    JSON.stringify(state) ===
      JSON.stringify({
        view: "geography",
        range: "12m",
        geoRange: "30d",
        metric: "orders",
        sku: "PNC-001",
        state: "09",
      }),
    `Sales direct state did not restore: ${JSON.stringify(state)}`,
  );
  assertParam("trace", "keep");
  checks.push(
    "Sales direct Geography URL restores tab, date window, metric, product, and state drill-down",
  );

  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#geoRankedRows tr").first().waitFor({ timeout: 10000 });
  state = await salesState();
  assert(
    state.view === "geography" &&
      state.geoRange === "30d" &&
      state.metric === "orders",
    "Sales refresh lost Geography state",
  );
  assert(
    state.sku === "PNC-001" && state.state === "09",
    "Sales refresh lost product or state drill-down",
  );
  checks.push("Sales refresh preserves the shared Geography state");

  await page.locator("#geoStateSelect").selectOption("all");
  assertParam("state", null);
  await page.goBack({ waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.getElementById("geoStateSelect")?.value === "09",
  );
  assertParam("state", "09");
  await page.goForward({ waitUntil: "networkidle" });
  await page.waitForFunction(
    () => document.getElementById("geoStateSelect")?.value === "all",
  );
  assertParam("state", null);
  checks.push(
    "Sales browser back/forward restores the selected-state drill-down",
  );

  await page.locator('[data-geo-range="ytd"]').click();
  await page.locator("#geoMetric").selectOption("units");
  await page.locator("#geoProduct").selectOption("all");
  assertParam("geo_range", "ytd");
  assertParam("metric", "units");
  assertParam("sku", null);
  assertParam("trace", "keep");
  await page.reload({ waitUntil: "networkidle" });
  state = await salesState();
  assert(
    state.geoRange === "ytd" && state.metric === "units" && state.sku === "all",
    `Sales Geography filters did not survive refresh: ${JSON.stringify(state)}`,
  );
  checks.push(
    "Sales Geography filter interactions write canonical URL state and survive refresh",
  );

  await page.locator('[data-view="overview"]').click();
  assertParam("view", null);
  assertParam("geo_range", null);
  assertParam("metric", null);
  assertParam("sku", null);
  assertParam("state", null);
  assertParam("trace", "keep");
  await page.goBack({ waitUntil: "networkidle" });
  await page.waitForFunction(() =>
    document
      .querySelector('.tabs [data-view="geography"]')
      ?.classList.contains("active"),
  );
  state = await salesState();
  assert(
    state.geoRange === "ytd" && state.metric === "units",
    `Sales Back did not restore the prior Geography view: ${JSON.stringify(state)}`,
  );
  checks.push(
    "Leaving Geography clears latent filters; Back restores the exact prior view",
  );

  await page.goto(`${baseUrl}/sales?range=28d&trace=keep`, {
    waitUntil: "networkidle",
    timeout: 20000,
  });
  state = await salesState();
  assert(
    state.view === "overview" && state.range === "28d",
    `Sales overview date window did not restore: ${JSON.stringify(state)}`,
  );
  await page.locator('[data-range="90d"]').click();
  assertParam("range", "90d");
  await page.reload({ waitUntil: "networkidle" });
  state = await salesState();
  assert(
    state.range === "90d",
    `Sales overview date window did not survive refresh: ${JSON.stringify(state)}`,
  );
  checks.push("Sales overview date window is shareable and refresh-stable");

  await page.goto(`${baseUrl}/catalog?mode=sku&sort=name&trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page
    .locator('[data-mode="sku"][aria-pressed="true"]')
    .waitFor({ timeout: 15000 });
  await page
    .locator("#portfolio > .analysis-row")
    .first()
    .waitFor({ timeout: 15000 });
  let catalog = await catalogState();
  assert(
    catalog.mode === "sku" &&
      catalog.filter === "all" &&
      catalog.sort === "name",
    `Catalog direct mode/sort did not restore: ${JSON.stringify(catalog)}`,
  );
  assertParam("sort", "name");
  const catalogPayload = await page.evaluate(async () =>
    (await fetch("/api/catalog", { cache: "no-store" })).json(),
  );
  const familyAttention = new Map(
    (catalogPayload.families || []).map((family) => [
      family.family_asin || "",
      Boolean(family.needs_attention),
    ]),
  );
  assertCatalogOrder(await catalogRows(), "name", "sku", familyAttention);
  checks.push("Catalog direct links restore the selected sort and row order");

  const sorts = [
    "attention",
    "sales",
    "traffic",
    "conversion",
    "stock",
    "name",
  ];
  for (const sort of sorts) {
    await page.locator("#sort").selectOption(sort);
    catalog = await catalogState();
    assert(
      catalog.sort === sort,
      `Catalog SKU sort control did not select ${sort}`,
    );
    assertParam("sort", sort === "attention" ? null : sort);
    assertParam("trace", "keep");
    assertCatalogOrder(await catalogRows(), sort, "sku", familyAttention);
  }
  const skuNameOrder = await catalogRows();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.getElementById("sort")?.value === "name",
  );
  await page
    .locator("#portfolio > .analysis-row")
    .first()
    .waitFor({ timeout: 15000 });
  assert(
    JSON.stringify(await catalogRows()) === JSON.stringify(skuNameOrder),
    "Catalog refresh changed the selected SKU sort order",
  );
  checks.push("Every SKU sort is canonical, shareable, and refresh-stable");

  await page.locator('[data-mode="family"]').click();
  await page.locator('[data-filter="attention"]').click();
  assertParam("mode", null);
  assertParam("filter", "attention");
  assertParam("sort", "name");
  assertParam("trace", "keep");

  await page.goBack();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-filter="all"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  catalog = await catalogState();
  assert(
    catalog.mode === "family" &&
      catalog.filter === "all" &&
      catalog.sort === "name",
    `Catalog Back did not restore Family/All: ${JSON.stringify(catalog)}`,
  );
  await page.goBack();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-mode="sku"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  catalog = await catalogState();
  assert(
    catalog.mode === "sku" &&
      catalog.filter === "all" &&
      catalog.sort === "name",
    `Catalog Back did not restore SKU mode: ${JSON.stringify(catalog)}`,
  );
  await page.goForward();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-mode="family"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  checks.push(
    "Catalog browser back/forward restores mode, filter, and sort state",
  );

  await page.locator('[data-filter="attention"]').click();
  await page.locator("#sort").selectOption("sales");
  const familySalesOrder = await catalogRows();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.getElementById("sort")?.value === "sales",
  );
  await page.waitForFunction(() =>
    document.querySelector("#portfolio > .family, #portfolio > .empty"),
  );
  catalog = await catalogState();
  assert(
    catalog.mode === "family" &&
      catalog.filter === "attention" &&
      catalog.sort === "sales",
    `Catalog refresh lost mode/filter/sort: ${JSON.stringify(catalog)}`,
  );
  assert(
    JSON.stringify(await catalogRows()) === JSON.stringify(familySalesOrder),
    "Catalog refresh changed the selected Family sort order",
  );
  await page.locator('[data-filter="all"]').click();
  assertParam("filter", null);

  for (const sort of sorts) {
    await page.locator("#sort").selectOption(sort);
    catalog = await catalogState();
    assert(
      catalog.sort === sort,
      `Catalog Family sort control did not select ${sort}`,
    );
    assertParam("sort", sort === "attention" ? null : sort);
    assertParam("filter", null);
    assertCatalogOrder(await catalogRows(), sort, "family", familyAttention);
  }
  checks.push(
    "Every Family sort is canonical and preserves compatible filter state",
  );

  await page.goto(
    `${baseUrl}/catalog?mode=invalid&filter=invalid&sort=invalid&trace=keep`,
    {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    },
  );
  await page.waitForFunction(
    () => document.getElementById("sort")?.value === "attention",
  );
  catalog = await catalogState();
  assert(
    catalog.mode === "family" &&
      catalog.filter === "all" &&
      catalog.sort === "attention",
    `Invalid Catalog URL did not fall back safely: ${JSON.stringify(catalog)}`,
  );
  assertParam("mode", null);
  assertParam("filter", null);
  assertParam("sort", null);
  assertParam("trace", "keep");
  checks.push(
    "Invalid state is normalized without deleting unrelated query parameters",
  );

  const productMetrics = ["sales", "units"];
  const productWindows = ["28d", "90d", "ytd"];
  let productPayload;
  for (const productMetric of productMetrics) {
    for (const productWindow of productWindows) {
      await page.goto(
        `${baseUrl}/product?sku=PNC-001&metric=${productMetric}&window=${productWindow}&trace=keep`,
        { waitUntil: "domcontentloaded", timeout: 30000 },
      );
      await page.locator("#chart .dpp-bar").first().waitFor({ timeout: 15000 });
      productPayload ||= await page.evaluate(async () =>
        (await fetch("/api/product?sku=PNC-001", { cache: "no-store" })).json(),
      );
      const directState = await assertProductView(
        productPayload,
        productMetric,
        productWindow,
      );
      assertParam("metric", productMetric === "sales" ? null : productMetric);
      assertParam("window", productWindow === "28d" ? null : productWindow);
      assertParam("sku", "PNC-001");
      assertParam("trace", "keep");
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForProductControls(productMetric, productWindow);
      await page.locator("#chart .dpp-bar").first().waitFor({ timeout: 15000 });
      assert(
        JSON.stringify(await productState()) === JSON.stringify(directState),
        `Product refresh changed ${productMetric}/${productWindow}`,
      );
    }
  }
  checks.push(
    "Every Product metric/window direct link and refresh renders the exact API-backed series",
  );

  await page.goto(`${baseUrl}/product?sku=PNC-001&trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.locator("#chart .dpp-bar").first().waitFor({ timeout: 15000 });
  const productHistory = [
    ["sales", "28d"],
    ["units", "28d"],
    ["units", "90d"],
    ["sales", "90d"],
    ["sales", "ytd"],
    ["units", "ytd"],
  ];
  await page.locator('[data-metric="units"]').click();
  await page.locator('[data-days="90"]').click();
  await page.locator('[data-metric="sales"]').click();
  await page.locator('[data-days="ytd"]').click();
  await page.locator('[data-metric="units"]').click();
  for (let index = productHistory.length - 2; index >= 0; index -= 1) {
    await page.goBack();
    const [productMetric, productWindow] = productHistory[index];
    await waitForProductControls(productMetric, productWindow);
    await assertProductView(productPayload, productMetric, productWindow);
  }
  for (let index = 1; index < productHistory.length; index += 1) {
    await page.goForward();
    const [productMetric, productWindow] = productHistory[index];
    await waitForProductControls(productMetric, productWindow);
    await assertProductView(productPayload, productMetric, productWindow);
  }
  assertParam("metric", "units");
  assertParam("window", "ytd");
  assertParam("sku", "PNC-001");
  assertParam("trace", "keep");
  checks.push(
    "Product Back and Forward restore all supported metric/window combinations and chart data",
  );

  await page.goto(
    `${baseUrl}/product?sku=PNC-001&metric=invalid&window=invalid&trace=keep`,
    { waitUntil: "domcontentloaded", timeout: 30000 },
  );
  await page.locator("#chart .dpp-bar").first().waitFor({ timeout: 15000 });
  await assertProductView(productPayload, "sales", "28d");
  assertParam("metric", null);
  assertParam("window", null);
  assertParam("sku", "PNC-001");
  assertParam("trace", "keep");
  checks.push(
    "Invalid Product state normalizes to Money/28D without losing product or unrelated parameters",
  );

  const inventoryScopes = [
    "current",
    "attention",
    "ok",
    "no_velocity",
    "alias",
    "retired",
    "archived",
    "all",
  ];
  let inventoryPayload;
  for (const scope of inventoryScopes) {
    await page.goto(`${baseUrl}/inventory?scope=${scope}&trace=keep`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForFunction(() =>
      document.getElementById("asof")?.textContent?.startsWith("Snapshot"),
    );
    inventoryPayload ||= await page.evaluate(async () =>
      (await fetch("/api/inventory", { cache: "no-store" })).json(),
    );
    await assertInventoryView(inventoryPayload, scope);
    assertParam("scope", scope === "current" ? null : scope);
    assertParam("q", null);
    assertParam("trace", "keep");
  }
  checks.push(
    "Every Inventory scope restores its selected ARIA state and exact rows from a canonical direct link",
  );

  const inventoryQuery = String(
    inventoryPayload.rows?.find((row) => row.sku)?.sku || "",
  ).trim();
  assert(inventoryQuery, "Inventory has no SKU available for search-state QA");
  await page.goto(
    `${baseUrl}/inventory?scope=all&q=${encodeURIComponent(inventoryQuery)}&trace=keep`,
    { waitUntil: "domcontentloaded", timeout: 30000 },
  );
  await page.waitForFunction(
    (query) => document.getElementById("search")?.value === query,
    inventoryQuery,
  );
  const inventorySearchState = await assertInventoryView(
    inventoryPayload,
    "all",
    inventoryQuery,
  );
  assertParam("scope", "all");
  assertParam("q", inventoryQuery);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (query) => document.getElementById("search")?.value === query,
    inventoryQuery,
  );
  assert(
    JSON.stringify(await inventoryState()) ===
      JSON.stringify(inventorySearchState),
    "Inventory search result changed after refresh",
  );
  checks.push(
    "Inventory search is shareable and refresh-stable with the exact result rows",
  );

  await page.goto(`${baseUrl}/inventory?trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(() =>
    document.getElementById("asof")?.textContent?.startsWith("Snapshot"),
  );
  await page.locator("#search").fill(inventoryQuery);
  await page.waitForFunction(
    (query) => new URL(window.location.href).searchParams.get("q") === query,
    inventoryQuery,
  );
  assertParam("q", inventoryQuery);
  assertParam("scope", null);
  await page.locator('[data-filter="all"]').click();
  const inventoryAllHistory = await assertInventoryView(
    inventoryPayload,
    "all",
    inventoryQuery,
  );
  assertParam("scope", "all");
  await page.locator('[data-filter="alias"]').click();
  await assertInventoryView(inventoryPayload, "alias", inventoryQuery);
  assertParam("scope", "alias");
  await page.goBack();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-filter="all"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  assert(
    JSON.stringify(await inventoryState()) ===
      JSON.stringify(inventoryAllHistory),
    "Inventory Back did not restore All records with its search",
  );
  await page.goBack();
  await page.waitForFunction(
    (query) =>
      document
        .querySelector('[data-filter="current"]')
        ?.getAttribute("aria-pressed") === "true" &&
      new URL(window.location.href).searchParams.get("q") === query,
    inventoryQuery,
  );
  await assertInventoryView(inventoryPayload, "current", inventoryQuery);
  await page.goForward();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-filter="all"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  assert(
    JSON.stringify(await inventoryState()) ===
      JSON.stringify(inventoryAllHistory),
    "Inventory Forward did not restore All records with its search",
  );
  checks.push(
    "Inventory scope changes create useful Back and Forward history while preserving search",
  );

  const overlongSearch = "inventory ".repeat(20);
  const normalizedSearch = overlongSearch
    .replace(/\s+/g, " ")
    .slice(0, 120)
    .trim();
  await page.goto(
    `${baseUrl}/inventory?scope=invalid&q=${encodeURIComponent(overlongSearch)}&trace=keep`,
    { waitUntil: "domcontentloaded", timeout: 30000 },
  );
  await page.waitForFunction(
    (query) => document.getElementById("search")?.value === query,
    normalizedSearch,
  );
  await assertInventoryView(inventoryPayload, "current", normalizedSearch);
  assertParam("scope", null);
  assertParam("q", normalizedSearch);
  assertParam("trace", "keep");
  checks.push(
    "Invalid Inventory scope and overlong search normalize without losing unrelated parameters",
  );

  await page.goto(`${baseUrl}/trajectory?window=90d&trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(
    () => document.querySelectorAll("#chart .dpp-bar").length > 0,
  );
  const trajectoryPayload = await page.evaluate(async () =>
    (await fetch("/api/trajectory", { cache: "no-store" })).json(),
  );
  await assertTrajectoryWindow(trajectoryPayload, "90d");
  assertParam("window", "90d");
  assertParam("trace", "keep");

  await page.goto(`${baseUrl}/trajectory?window=ytd&trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-trajectory-window="ytd"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  await assertTrajectoryWindow(trajectoryPayload, "ytd");
  assertParam("window", "ytd");

  await page.goto(`${baseUrl}/trajectory?window=180d&trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-trajectory-window="180d"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  await assertTrajectoryWindow(trajectoryPayload, "180d");
  assertParam("window", null);
  checks.push("Trajectory deep links restore every window and its aggregation");

  await page.locator('[data-trajectory-window="90d"]').click();
  await assertTrajectoryWindow(trajectoryPayload, "90d");
  assertParam("window", "90d");
  await page.locator('[data-trajectory-window="ytd"]').click();
  const ytdState = await assertTrajectoryWindow(trajectoryPayload, "ytd");
  assertParam("window", "ytd");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-trajectory-window="ytd"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  assert(
    JSON.stringify(await trajectoryState()) === JSON.stringify(ytdState),
    "Trajectory YTD state or aggregation changed after refresh",
  );
  checks.push(
    "Trajectory interactions write canonical refresh-stable window state",
  );

  await page.goBack();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-trajectory-window="90d"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  await assertTrajectoryWindow(trajectoryPayload, "90d");
  await page.goBack();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-trajectory-window="180d"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  await assertTrajectoryWindow(trajectoryPayload, "180d");
  await page.goForward();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-trajectory-window="90d"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  await assertTrajectoryWindow(trajectoryPayload, "90d");
  checks.push(
    "Trajectory Back and Forward restore window state and aggregation",
  );

  await page.goto(`${baseUrl}/trajectory?window=invalid&trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-trajectory-window="180d"]')
        ?.getAttribute("aria-pressed") === "true",
  );
  await assertTrajectoryWindow(trajectoryPayload, "180d");
  assertParam("window", null);
  assertParam("trace", "keep");
  checks.push(
    "Invalid Trajectory windows normalize without losing unrelated state",
  );

  renderedAdsPayload = null;
  await page.goto(`${baseUrl}/ads?trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(
    () =>
      !document.getElementById("readyState")?.hidden ||
      !document.getElementById("emptyState")?.hidden,
  );
  const adsPayload =
    (await renderedAdsPayload) ||
    (await page.evaluate(async () =>
      (await fetch("/api/ads", { cache: "no-store" })).json(),
    ));
  const adsReady =
    adsPayload.connection?.state === "READY" && adsPayload.status === "ready";
  if (adsReady) {
  const demandSignal = (adsPayload.demand?.items || []).find(
    (signal) =>
      signal.signal_id &&
      signal.campaign_id &&
      signal.recommendation?.state &&
      signal.signal_type &&
      signal.product_refs?.[0]?.sku,
  );
  assert(
    demandSignal,
    "Advertising has no product-associated demand signal for URL-state QA",
  );
  const adsSku = demandSignal.product_refs[0].sku;
  const adsCampaign = String(demandSignal.campaign_id);
  const adsFilter = String(demandSignal.recommendation.state).toLowerCase();
  const adsSignalType = String(demandSignal.signal_type).toLowerCase();
  const demandUrl =
    `${baseUrl}/ads?view=demand&sku=${encodeURIComponent(adsSku)}` +
    `&campaign=${encodeURIComponent(adsCampaign)}` +
    `&signal=${encodeURIComponent(demandSignal.signal_id)}` +
    `&filter=${encodeURIComponent(adsFilter)}&sort=spend-desc` +
    `&signal_type=${encodeURIComponent(adsSignalType)}&trace=keep`;
  await page.goto(demandUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(
    (signalId) =>
      !document.getElementById("demand").hidden &&
      document.querySelector("#demandRows tr.is-highlighted")?.dataset
        .signalId === signalId,
    demandSignal.signal_id,
  );
  const directAdsState = await adsState();
  assert(
    directAdsState.view === "demand" &&
      directAdsState.sku === adsSku &&
      directAdsState.campaign === adsCampaign &&
      directAdsState.signalType === adsSignalType &&
      directAdsState.filter === adsFilter &&
      directAdsState.sort === "spend-desc" &&
      directAdsState.highlightedSignal === demandSignal.signal_id,
    `Ads direct demand state did not restore: ${JSON.stringify(directAdsState)}`,
  );
  assertParam("page", null);
  assertParam("trace", "keep");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (signalId) =>
      document.querySelector("#demandRows tr.is-highlighted")?.dataset
        .signalId === signalId,
    demandSignal.signal_id,
  );
  assert(
    JSON.stringify(await adsState()) === JSON.stringify(directAdsState),
    "Ads demand deep link changed after refresh",
  );
  checks.push(
    "Ads direct links and refresh restore the exact product-associated demand evidence",
  );

  await page.locator("#demandSort").selectOption("sales-desc");
  await page.waitForFunction(
    () =>
      new URL(window.location.href).searchParams.get("sort") === "sales-desc",
  );
  assertParam("trace", "keep");
  await page.goBack();
  await page.waitForFunction(
    () => document.getElementById("demandSort")?.value === "spend-desc",
  );
  assertParam("sort", "spend-desc");
  await page.goForward();
  await page.waitForFunction(
    () => document.getElementById("demandSort")?.value === "sales-desc",
  );
  assertParam("sort", "sales-desc");
  checks.push("Ads Back and Forward restore server-backed demand sorting");

  await page.goto(
    `${baseUrl}/ads?view=products&sku=${encodeURIComponent(adsSku)}&trace=keep`,
    { waitUntil: "domcontentloaded", timeout: 30000 },
  );
  await page.waitForFunction(
    (sku) =>
      !document.getElementById("products").hidden &&
      document.querySelector("#productRows tr.is-highlighted")?.dataset.sku ===
        sku,
    adsSku,
  );
  await page.locator("#productRows .product-line").first().click();
  await page.waitForURL(/\/product\?sku=/);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (sku) =>
      !document.getElementById("products").hidden &&
      document.querySelector("#productRows tr.is-highlighted")?.dataset.sku ===
        sku,
    adsSku,
  );
  assertParam("view", "products");
  assertParam("sku", adsSku);
  assertParam("trace", "keep");
  checks.push(
    "Product Workspace round-trip returns to the exact Ads SKU analysis",
  );

  await page.goto(
    `${baseUrl}/ads?view=invalid&filter=invalid&sort=invalid&page=-2&signal_type=invalid&trace=keep`,
    { waitUntil: "domcontentloaded", timeout: 30000 },
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-ads-view="impact"]')
        ?.getAttribute("aria-selected") === "true",
  );
  assertParam("view", null);
  assertParam("filter", null);
  assertParam("sort", null);
  assertParam("page", null);
  assertParam("signal_type", null);
  assertParam("trace", "keep");
  checks.push(
    "Invalid Ads state normalizes to Business impact without losing unrelated parameters",
  );
  } else {
    const unavailable = await page.evaluate(() => ({
      emptyVisible: !document.getElementById("emptyState")?.hidden,
      impactSelected:
        document
          .querySelector('[data-ads-view="impact"]')
          ?.getAttribute("aria-selected") === "true",
      drillsDisabled: [...document.querySelectorAll('[data-ads-view]')]
        .slice(1)
        .every(
          (tab) => tab.disabled && tab.getAttribute("aria-disabled") === "true",
        ),
    }));
    assert(
      unavailable.emptyVisible &&
        unavailable.impactSelected &&
        unavailable.drillsDisabled,
      `Ads unavailable state is unsafe: ${JSON.stringify(unavailable)}`,
    );
    await page.goto(
      `${baseUrl}/ads?view=invalid&filter=invalid&sort=invalid&page=-2&signal_type=invalid&trace=keep`,
      { waitUntil: "domcontentloaded", timeout: 30000 },
    );
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-ads-view="impact"]')
          ?.getAttribute("aria-selected") === "true",
    );
    assertParam("view", null);
    assertParam("filter", null);
    assertParam("sort", null);
    assertParam("page", null);
    assertParam("signal_type", null);
    assertParam("trace", "keep");
    checks.push(
      "Ads unavailable state disables unsafe drills and normalizes invalid URL state",
    );
  }

  const financeWindows = ["3m", "ytd", "12m", "lastYear", "all"];
  let financePayload;
  for (const windowKey of financeWindows) {
    await page.goto(`${baseUrl}/finance?window=${windowKey}&trace=keep`, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.waitForFunction(
      (key) =>
        document
          .querySelector(`[data-finance-window="${key}"]`)
          ?.getAttribute("aria-selected") === "true",
      windowKey,
    );
    financePayload ||= await page.evaluate(async () =>
      (await fetch("/api/finance", { cache: "no-store" })).json(),
    );
    await assertFinanceWindow(financePayload, windowKey);
    assertParam("window", windowKey === "ytd" ? null : windowKey);
    assertParam("month", null);
    assertParam("cogs", null);
    assertParam("trace", "keep");
  }
  checks.push(
    "Every Finance trajectory window restores from a canonical deep link",
  );

  await page.goto(`${baseUrl}/finance?window=3m&cogs=excluded&trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.waitForFunction(
    () =>
      document.getElementById("cogsToggle")?.getAttribute("aria-pressed") ===
      "false",
  );
  const excludedState = await assertFinanceWindow(financePayload, "3m", false);
  assertParam("window", "3m");
  assertParam("cogs", "excluded");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      document.getElementById("cogsToggle")?.getAttribute("aria-pressed") ===
      "false",
  );
  assert(
    JSON.stringify(await financeState()) === JSON.stringify(excludedState),
    "Finance excluded-COGS chart changed after refresh",
  );
  await page.locator("#cogsToggle").click();
  const includedState = await assertFinanceWindow(financePayload, "3m", true);
  assertParam("cogs", null);
  assert(
    JSON.stringify(includedState.signature) !==
      JSON.stringify(excludedState.signature),
    "Finance COGS toggle did not change the chart data signature",
  );
  checks.push(
    "Finance COGS state is canonical, visible in the chart, and refresh-stable",
  );

  const closedMonth = String(
    financePayload.closed_months?.at(-1)?.month || "",
  ).slice(0, 7);
  assert(
    /^\d{4}-\d{2}$/.test(closedMonth),
    "Finance has no valid closed month for URL-state QA",
  );
  await page.goto(
    `${baseUrl}/finance?window=month&month=${closedMonth}&trace=keep`,
    {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    },
  );
  await page.waitForFunction(
    (month) => document.getElementById("monthPicker")?.value?.startsWith(month),
    closedMonth,
  );
  const monthState = await assertFinanceWindow(financePayload, "month");
  assert(
    monthState.month === closedMonth,
    `Finance selected month is ${monthState.month}`,
  );
  assertParam("window", "month");
  assertParam("month", closedMonth);
  assertParam("cogs", null);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (month) => document.getElementById("monthPicker")?.value?.startsWith(month),
    closedMonth,
  );
  assert(
    JSON.stringify(await financeState()) === JSON.stringify(monthState),
    "Finance month chart changed after refresh",
  );
  checks.push(
    "Finance Month deep links restore the month and exact chart signature",
  );

  await page.goto(`${baseUrl}/finance?window=month&month=1900-01&trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  const fallbackMonth = String(financePayload.current_month?.month || "").slice(
    0,
    7,
  );
  await page.waitForFunction(
    (month) => document.getElementById("monthPicker")?.value?.startsWith(month),
    fallbackMonth,
  );
  const fallbackState = await assertFinanceWindow(financePayload, "month");
  assert(
    fallbackState.month === fallbackMonth,
    "Finance invalid month did not select current month",
  );
  assertParam("window", "month");
  assertParam("month", fallbackMonth);
  assertParam("trace", "keep");

  await page.goto(`${baseUrl}/finance?trace=keep`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await page.locator('[data-finance-window="3m"]').click();
  const historyIncluded = await assertFinanceWindow(financePayload, "3m", true);
  await page.locator("#cogsToggle").click();
  const historyExcluded = await assertFinanceWindow(
    financePayload,
    "3m",
    false,
  );
  await page.locator('[data-finance-window="all"]').click();
  await assertFinanceWindow(financePayload, "all", false);
  await page.goBack();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-finance-window="3m"]')
        ?.getAttribute("aria-selected") === "true" &&
      document.getElementById("cogsToggle")?.getAttribute("aria-pressed") ===
        "false",
  );
  assert(
    JSON.stringify(await financeState()) === JSON.stringify(historyExcluded),
    "Finance Back did not restore 3M with COGS excluded",
  );
  await page.goBack();
  await page.waitForFunction(
    () =>
      document.getElementById("cogsToggle")?.getAttribute("aria-pressed") ===
      "true",
  );
  assert(
    JSON.stringify(await financeState()) === JSON.stringify(historyIncluded),
    "Finance Back did not restore 3M with COGS included",
  );
  await page.goForward();
  await page.waitForFunction(
    () =>
      document.getElementById("cogsToggle")?.getAttribute("aria-pressed") ===
      "false",
  );
  assert(
    JSON.stringify(await financeState()) === JSON.stringify(historyExcluded),
    "Finance Forward did not restore 3M with COGS excluded",
  );
  checks.push("Finance Back and Forward restore window, COGS, and chart state");

  await page.goto(
    `${baseUrl}/finance?window=invalid&month=1900-99&cogs=invalid&trace=keep`,
    { waitUntil: "domcontentloaded", timeout: 30000 },
  );
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-finance-window="ytd"]')
        ?.getAttribute("aria-selected") === "true",
  );
  await assertFinanceWindow(financePayload, "ytd", true);
  assertParam("window", null);
  assertParam("month", null);
  assertParam("cogs", null);
  assertParam("trace", "keep");
  checks.push(
    "Invalid Finance state normalizes without losing unrelated parameters",
  );
} catch (error) {
  failures.push(error.message);
}

await browser.close();
const summary = { status: failures.length ? "FAIL" : "PASS", checks, failures };
await fs.writeFile(
  path.join(outDir, "analysis-state-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
