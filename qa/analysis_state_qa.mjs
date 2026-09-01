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
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") failures.push(`console: ${message.text()}`);
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
