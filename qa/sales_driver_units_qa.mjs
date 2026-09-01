import fs from "node:fs/promises";
import path from "node:path";

import { chromium, webkit } from "playwright";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const profiles = [
  "warm-studio",
  "midnight-saffron",
  "aubergine-aqua",
  "midnight-dark",
  "aubergine-dark",
  "weyland",
];
const requestedEngines = new Set(
  String(process.env.DPP_QA_ENGINES || "chromium,webkit")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const engines = [
  ["chromium", chromium],
  ["webkit", webkit],
].filter(([name]) => requestedEngines.has(name));
const expectedCounts = [
  { value: 0, text: "0 units / 28D" },
  { value: 1, text: "1 unit / 28D" },
  { value: 2, text: "2 units / 28D" },
];
const failures = [];
const checks = [];
let checkCount = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function monitor(page) {
  const browserErrors = [];
  const failedResponses = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().startsWith("Failed to load resource:")
    ) {
      browserErrors.push(message.text());
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === new URL(baseUrl).origin && response.status() >= 400) {
      failedResponses.push(`${response.status()} ${url.pathname}${url.search}`);
    }
  });
  return { browserErrors, failedResponses };
}

async function installApiSnapshot(context, api) {
  await context.route("**/api/sales*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/sales") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(api),
    });
  });
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function loadSales(page) {
  const response = await page.goto(`${baseUrl}/sales?view=products`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  assert(response?.ok(), `Sales returned ${response?.status()}`);
  await page.locator("#skuRows tr").first().waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await settle(page);
}

async function unitState(page, sku) {
  const cell = page
    .locator("#skuRows tr")
    .filter({ has: page.locator(`.product-sku:text-is("${sku}")`) })
    .first()
    .locator(".product-units");
  await cell.waitFor({ state: "visible", timeout: 10_000 });
  const [snapshot, state] = await Promise.all([
    cell.ariaSnapshot(),
    cell.evaluate((node) => ({
      text: node.textContent.trim(),
      visibleText: node.innerText.trim(),
      before: getComputedStyle(node, "::before").content,
      after: getComputedStyle(node, "::after").content,
      visible: node.checkVisibility(),
      overflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    })),
  ]);
  return { ...state, snapshot };
}

let api;
let auditedRows = [];
try {
  const response = await fetch(`${baseUrl}/api/sales`, {
    headers: { accept: "application/json" },
  });
  assert(response.ok, `Sales API returned ${response.status}`);
  api = await response.json();
  assert((api.skus || []).length >= 3, "Sales API needs three product rows");
  api = structuredClone(api);
  auditedRows = api.skus.slice(0, 3).map((row, index) => ({
    ...row,
    units_t28: expectedCounts[index].value,
  }));
  api.skus = [...auditedRows, ...api.skus.slice(3)];
} catch (error) {
  failures.push(`API snapshot: ${error.message}`);
}

if (api) {
  for (const [engineName, engine] of engines) {
    const browser = await engine.launch({ headless: true });
    const scenarios = [
      { label: "desktop-1440", viewport: { width: 1440, height: 1200 } },
      { label: "compact-900", viewport: { width: 900, height: 1000 } },
      {
        label: engineName === "chromium" ? "mobile-393" : "mobile-390",
        viewport: {
          width: engineName === "chromium" ? 393 : 390,
          height: engineName === "chromium" ? 727 : 664,
        },
        isMobile: true,
        hasTouch: true,
      },
    ];
    for (const scenario of scenarios) {
      const context = await browser.newContext({
        viewport: scenario.viewport,
        isMobile: scenario.isMobile || false,
        hasTouch: scenario.hasTouch || false,
      });
      await installApiSnapshot(context, api);
      const page = await context.newPage();
      const pageMonitor = monitor(page);
      try {
        await loadSales(page);
        for (const profile of profiles) {
          await page.evaluate((profileId) => {
            window.dppPresentation.setProfile(profileId);
          }, profile);
          await settle(page);
          for (const [index, row] of auditedRows.entries()) {
            const label = `${engineName} ${scenario.label} ${profile} ${row.sku}`;
            const state = await unitState(page, row.sku);
            const expected = expectedCounts[index].text;
            assert(state, `${label} product unit cell is missing`);
            assert(
              state.text === expected &&
                state.visibleText === expected &&
                state.snapshot.includes(expected),
              `${label} visible/accessibility text diverged: ${JSON.stringify(state)}`,
            );
            assert(
              !state.before.includes("unit") &&
                !state.after.includes("unit") &&
                !state.before.includes("28D") &&
                !state.after.includes("28D"),
              `${label} still generates unit semantics in CSS`,
            );
            assert(state.visible, `${label} product unit cell is not visible`);
            assert(
              state.overflow <= 1,
              `${label} creates ${state.overflow}px of page overflow`,
            );
            checkCount += 1;
          }
        }

        await page.evaluate(() => {
          window.dppPresentation.setProfile("warm-studio");
        });
        await settle(page);
        await page
          .locator("#skuRows tr")
          .first()
          .screenshot({
            path: path.join(
              outDir,
              `${engineName}-sales-driver-units-${scenario.label}.png`,
            ),
          });
        assert(
          !pageMonitor.browserErrors.length,
          `${engineName} ${scenario.label} browser errors: ${pageMonitor.browserErrors.join("; ")}`,
        );
        assert(
          !pageMonitor.failedResponses.length,
          `${engineName} ${scenario.label} failed responses: ${pageMonitor.failedResponses.join("; ")}`,
        );
        checks.push(
          `${engineName} ${scenario.label}: 0/1/plural visible/accessibility parity passes in ${profiles.length} profiles`,
        );
      } catch (error) {
        failures.push(`${engineName} ${scenario.label}: ${error.message}`);
      } finally {
        await context.close();
      }
    }
    await browser.close();
  }
}

const summary = {
  status: failures.length ? "FAIL" : "PASS",
  checkCount,
  engines: engines.map(([name]) => name),
  profiles,
  expectedCounts,
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "sales-driver-units-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
