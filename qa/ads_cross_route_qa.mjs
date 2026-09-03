import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
const page = await context.newPage();
const failures = [];
const checks = [];
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") failures.push(`console: ${message.text()}`);
});

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

async function api(endpoint) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return body;
  }, endpoint);
}

function businessSignature(payload) {
  const business = payload?.ads?.business || {};
  return [
    business.through_date,
    business.spend,
    business.attributed_sales,
    business.total_business_sales,
    business.tacos,
    business.observed_ads_days,
    business.mature_ads_days,
  ].map((value) => (value == null ? null : String(value)));
}

async function open(route) {
  const response = await page.goto(`${baseUrl}${route}`, { waitUntil: "networkidle", timeout: 30_000 });
  check(`${route} responds`, Boolean(response?.ok()), String(response?.status()));
}

try {
  await open("/");
  const [today, home, sales, inventory] = await Promise.all([
    api("/api/today"),
    api("/api/home"),
    api("/api/sales"),
    api("/api/inventory"),
  ]);
  const ready = Boolean(home.ads?.business?.through_date);

  if (ready) {
    const expected = JSON.stringify(businessSignature(home));
    check(
      "Today, Business and Sales share one Ads business contract",
      [today, sales].every((payload) => JSON.stringify(businessSignature(payload)) === expected),
      JSON.stringify({ today: businessSignature(today), home: businessSignature(home), sales: businessSignature(sales) }),
    );
    await page.waitForSelector("#paidSupportWatch:not([hidden])");
    check(
      "Today labels paid support as a completed window",
      (await page.locator("#paidSupportWatch .section-label").innerText()).includes("completed 28-day window"),
    );
    check(
      "Today keeps one paid-support destination",
      (await page.locator("#paidSupportWatch a").count()) === 1 &&
        (await page.locator("#paidSupportOpen").innerText()).includes("Review in Ads"),
    );

    const wide = await browser.newContext({ viewport: { width: 2048, height: 1111 }, reducedMotion: "reduce" });
    const widePage = await wide.newPage();
    try {
      await widePage.goto(`${baseUrl}/`, { waitUntil: "networkidle", timeout: 30_000 });
      await widePage.waitForSelector("#paidSupportWatch:not([hidden])");
      await widePage.evaluate(() => window.dppPresentation.setProfile("aubergine-aqua", { persist: false }));
      const layout = await widePage.locator("#paidSupportWatch").evaluate((panel) => {
        const action = panel.querySelector("#paidSupportAction");
        const metrics = panel.querySelector("#paidSupportMetrics");
        const metricWidths = [...metrics.children].map((metric) => metric.getBoundingClientRect().width);
        return {
          panelWidth: panel.getBoundingClientRect().width,
          panelHeight: panel.getBoundingClientRect().height,
          panelOverflow: panel.scrollWidth - panel.clientWidth,
          actionVisible: !action.hidden && getComputedStyle(action).display !== "none",
          actionWidth: action.getBoundingClientRect().width,
          metricsWidth: metrics.getBoundingClientRect().width,
          metricWidths,
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          nestedInOperations: Boolean(panel.closest(".today-operations")),
        };
      });
      check("Today gives paid support its own sibling panel", !layout.nestedInOperations, JSON.stringify(layout));
      check("Today wide paid-support card is contained", layout.panelOverflow <= 1, JSON.stringify(layout));
      check("Today wide page has no horizontal overflow", layout.documentOverflow <= 1, JSON.stringify(layout));
      check(
        "Today wide paid-support content has readable width",
        (!layout.actionVisible || layout.actionWidth >= layout.metricsWidth - 1) &&
          layout.metricWidths.every((width) => width >= 120),
        JSON.stringify(layout),
      );
      check("Today wide paid-support card stays compact", layout.panelHeight <= 360, JSON.stringify(layout));
    } finally {
      await wide.close();
    }

    await open("/business");
    await page.waitForSelector("#adsRead:not([hidden])");
    const origin = page.url();
    const businessActionHref = await page.locator("#adsOpen").getAttribute("href");
    check(
      "Business preserves the server-owned Ads destination",
      businessActionHref === new URL(page.url()).pathname || /\/ads\?/.test(businessActionHref || ""),
      businessActionHref || "missing",
    );
    await page.locator("#adsOpen").click();
    await page.waitForURL(/\/ads(?:\?|$)/);
    await page.goBack({ waitUntil: "networkidle" });
    check("Back restores the Business analysis", page.url() === origin, page.url());

    await open("/sales");
    await page.waitForSelector("#salesAdsContext:not([hidden])");
    const salesText = await page.locator("#salesAdsContext").innerText();
    check(
      "Sales separates attribution from incrementality",
      salesText.includes("not incremental sales") && salesText.includes("not exact organic sales"),
    );
    await page.getByRole("tab", { name: "Drivers" }).click();
    check(
      "Sales Drivers adds SKU-level paid support",
      (await page.locator("#skuRows .product-paid-support").count()) > 0,
    );

    const sku = sales.ads?.products?.[0]?.sku || "PNC-001";
    await open(`/product?sku=${encodeURIComponent(sku)}`);
    const product = await api(`/api/product?sku=${encodeURIComponent(sku)}`);
    if (product.ads?.through_date) {
      await page.waitForSelector("#productAdsModule:not([hidden])");
      const demandHref = await page.locator("#productAdsDemandLink").getAttribute("href");
      const actionHref = await page.locator("#productAdsActionLink").getAttribute("href");
      check(
        "Product exposes exact product and demand destinations",
        new URL(demandHref, baseUrl).searchParams.get("sku") === sku &&
          new URL(demandHref, baseUrl).searchParams.get("view") === "demand" &&
          new URL(actionHref, baseUrl).searchParams.get("sku") === sku,
        JSON.stringify({ demandHref, actionHref }),
      );
      const productText = await page.locator("#productAdsModule").innerText();
      check(
        "Product keeps seller sales, spend, conversion, attribution and TACOS together",
        ["Seller sales", "Ad spend", "TACOS", "Conversion", "Attributed sales"].every((label) => productText.includes(label)),
      );
      check(
        "Product action is API-owned",
        (await page.locator("#productAdsRecommendation").innerText()) === product.ads.recommendation?.title,
      );
    }

    await open("/inventory");
    const expectedActions = inventory.ads?.actions || [];
    const watchVisible = await page.locator("#inventoryAdsWatch").isVisible();
    check(
      "Inventory exposure visibility follows server eligibility",
      watchVisible === (expectedActions.length > 0),
      `${expectedActions.length} API actions, visible=${watchVisible}`,
    );
    if (expectedActions.length) {
      check(
        "Inventory paid-support list is bounded",
        (await page.locator("#inventoryAdsActions > li").count()) === Math.min(4, expectedActions.length),
      );
      const inventoryText = await page.locator("#inventoryAdsWatch").innerText();
      check(
        "Inventory avoids prescriptive campaign action",
        inventoryText.includes("not a recommendation to pause, reduce, bid or scale"),
      );
    }
  } else {
    check("Unavailable Ads state is explicit", Boolean(home.ads?.status), JSON.stringify(home.ads));
    check("Today hides paid support without a reportable window", !(await page.locator("#paidSupportWatch").isVisible()));
  }

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const mobilePage = await mobile.newPage();
  try {
    for (const [name, route, selector, maximum] of [
      ["today", "/", "#paidSupportAction:not([hidden])", 1],
      ["sales", "/sales?view=products", "#skuRows tr:visible", 6],
      ["inventory", "/inventory", "#inventoryAdsActions > li", 4],
    ]) {
      await mobilePage.goto(`${baseUrl}${route}`, { waitUntil: "networkidle", timeout: 30_000 });
      const state = await mobilePage.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        h1: document.querySelectorAll("h1").length,
      }));
      check(`${name} mobile document is contained`, state.overflow <= 1, JSON.stringify(state));
      check(`${name} mobile keeps one H1`, state.h1 === 1, String(state.h1));
      check(`${name} mobile Ads list is bounded`, (await mobilePage.locator(selector).count()) <= maximum);
    }
    await mobilePage.screenshot({ path: path.join(outDir, "ads-cross-route-mobile.png"), fullPage: true });
  } finally {
    await mobile.close();
  }

  await page.screenshot({ path: path.join(outDir, "ads-cross-route-desktop.png"), fullPage: true });
} catch (error) {
  failures.push(error.stack || error.message);
} finally {
  await fs.writeFile(
    path.join(outDir, "ads-cross-route-qa.json"),
    JSON.stringify({ checks, failures }, null, 2),
  );
  await context.close();
  await browser.close();
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Ads cross-route QA passed: ${checks.length} checks`);
