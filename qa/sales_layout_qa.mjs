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
const evidenceProfiles = new Set(["warm-studio", "weyland"]);
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
const viewports = [
  { width: 360, height: 800 },
  { width: 412, height: 915 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
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
  const response = await page.goto(`${baseUrl}/sales`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  assert(response?.ok(), `Sales returned ${response?.status()}`);
  await page.locator("#monthChart .sales-runrate-label").waitFor({
    state: "visible",
    timeout: 15_000,
  });
  await settle(page);
}

async function runRateGeometry(page) {
  return page.evaluate(() => {
    const svg = document.getElementById("monthChart");
    const labels = [...svg.querySelectorAll(".sales-runrate-label")];
    const ghosts = [...svg.querySelectorAll(".sales-runrate-ghost")];
    const svgRect = svg.getBoundingClientRect();
    return {
      documentOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      pairs: labels.map((label, index) => {
        const labelRect = label.getBoundingClientRect();
        const ghostRect = ghosts[index]?.getBoundingClientRect();
        return {
          text: label.textContent.trim(),
          label: {
            left: labelRect.left,
            right: labelRect.right,
            top: labelRect.top,
            bottom: labelRect.bottom,
          },
          ghost: ghostRect
            ? {
                left: ghostRect.left,
                right: ghostRect.right,
                top: ghostRect.top,
                bottom: ghostRect.bottom,
              }
            : null,
          contained:
            labelRect.left >= svgRect.left - 1 &&
            labelRect.right <= svgRect.right + 1 &&
            labelRect.top >= svgRect.top - 1 &&
            labelRect.bottom <= svgRect.bottom + 1,
          clearsProjection: Boolean(
            ghostRect && labelRect.bottom <= ghostRect.top - 2,
          ),
        };
      }),
    };
  });
}

async function driverGeometry(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll("#skuRows tr")].filter(
      (row) => getComputedStyle(row).display !== "none",
    );
    return {
      documentOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      rows: rows.map((row) => {
        const rowRect = row.getBoundingClientRect();
        const identityRect = row.cells[0].getBoundingClientRect();
        const salesRect = row.cells[1].getBoundingClientRect();
        const name = row.querySelector(".product-name");
        const nameRect = name.getBoundingClientRect();
        const lines = new Map();
        const textNode = name.firstChild;
        if (textNode?.nodeType === Node.TEXT_NODE) {
          for (let index = 0; index < textNode.length; index += 1) {
            const range = document.createRange();
            range.setStart(textNode, index);
            range.setEnd(textNode, index + 1);
            const rect = range.getBoundingClientRect();
            const key = Math.round(rect.top);
            lines.set(key, `${lines.get(key) || ""}${textNode.data[index]}`);
          }
        }
        return {
          name: name.textContent.trim(),
          rowWidth: rowRect.width,
          scrollWidth: row.scrollWidth,
          clientWidth: row.clientWidth,
          identityWidth: identityRect.width,
          nameWidth: nameRect.width,
          identityAboveSales: identityRect.bottom <= salesRect.top - 2,
          orphanLines: [...lines.values()].filter(
            (line) => line.trim().length === 1 && /\p{L}/u.test(line),
          ),
        };
      }),
    };
  });
}

let api;
try {
  const response = await fetch(`${baseUrl}/api/sales`, {
    headers: { accept: "application/json" },
  });
  assert(response.ok, `Sales API returned ${response.status}`);
  api = await response.json();
  const partialMonth = [...(api.months || [])]
    .reverse()
    .find((month) => month.partial);
  assert(partialMonth, "Sales API has no partial month for run-rate QA");
  const actual = Number(partialMonth.sales || 0);
  api.headline.projected_month_sales = Math.max(actual + 1_000, actual * 1.25);
} catch (error) {
  failures.push(`API snapshot: ${error.message}`);
}

for (const [engineName, engine] of api ? engines : []) {
  const browser = await engine.launch({ headless: true });
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport,
      isMobile: viewport.width < 720,
      hasTouch: viewport.width < 720,
    });
    await installApiSnapshot(context, api);
    const page = await context.newPage();
    const pageMonitor = monitor(page);
    const scenario = `${engineName} ${viewport.width}x${viewport.height}`;
    try {
      await loadSales(page);
      for (const profile of profiles) {
        await page.evaluate(
          (profileId) => window.dppPresentation.setProfile(profileId),
          profile,
        );
        await settle(page);
        const geometry = await runRateGeometry(page);
        assert(
          geometry.pairs.length > 0,
          `${scenario} ${profile} has no run-rate annotation`,
        );
        assert(
          geometry.pairs.every(
            (pair) => pair.ghost && pair.contained && pair.clearsProjection,
          ),
          `${scenario} ${profile} run-rate collision: ${JSON.stringify(geometry)}`,
        );
        assert(
          geometry.documentOverflow <= 1,
          `${scenario} ${profile} Sales chart overflows`,
        );
        if (evidenceProfiles.has(profile)) {
          await page.locator("#monthChart").screenshot({
            path: path.join(
              outDir,
              `${engineName}-sales-runrate-${profile}-${viewport.width}x${viewport.height}.png`,
            ),
          });
        }
        checkCount += 1;
      }

      await page.locator("#salesProductsTab").click();
      await page
        .locator("#skuRows .product-name")
        .first()
        .waitFor({ state: "visible", timeout: 5_000 });
      await settle(page);
      for (const profile of profiles) {
        await page.evaluate(
          (profileId) => window.dppPresentation.setProfile(profileId),
          profile,
        );
        await settle(page);
        const geometry = await driverGeometry(page);
        assert(
          geometry.rows.length > 0,
          `${scenario} ${profile} has no visible driver rows`,
        );
        assert(
          geometry.rows.every((row) => row.scrollWidth <= row.clientWidth + 1),
          `${scenario} ${profile} driver row overflows: ${JSON.stringify(geometry)}`,
        );
        if (viewport.width < 720) {
          assert(
            geometry.rows.every(
              (row) =>
                row.identityAboveSales &&
                row.identityWidth >= row.rowWidth - 30 &&
                row.nameWidth >= 180 &&
                row.orphanLines.length === 0,
            ),
            `${scenario} ${profile} compresses product identity: ${JSON.stringify(geometry)}`,
          );
        }
        assert(
          geometry.documentOverflow <= 1,
          `${scenario} ${profile} Drivers overflows`,
        );
        if (evidenceProfiles.has(profile)) {
          await page.locator("#skuRows").screenshot({
            path: path.join(
              outDir,
              `${engineName}-sales-drivers-${profile}-${viewport.width}x${viewport.height}.png`,
            ),
          });
        }
        checkCount += 1;
      }

      assert(
        !pageMonitor.browserErrors.length,
        `${scenario} browser errors: ${pageMonitor.browserErrors.join("; ")}`,
      );
      assert(
        !pageMonitor.failedResponses.length,
        `${scenario} failed responses: ${pageMonitor.failedResponses.join("; ")}`,
      );
      checks.push(
        `${scenario}: run-rate labels and Driver identities pass in ${profiles.length} profiles`,
      );
    } catch (error) {
      failures.push(`${scenario}: ${error.message}`);
    } finally {
      await context.close();
    }
  }
  await browser.close();
}

const summary = {
  status: failures.length ? "FAIL" : "PASS",
  checkCount,
  engines: engines.map(([name]) => name),
  viewports,
  profiles,
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "sales-layout-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
