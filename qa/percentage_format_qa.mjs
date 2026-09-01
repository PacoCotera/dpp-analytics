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
const routes = [
  "/today",
  "/business",
  "/sales?view=products",
  "/catalog",
  "/product?sku=PNC-001",
  "/trajectory",
  "/finance",
  "/ads",
];
const expectedProbes = [
  ["null", "—"],
  ["undefined", "—"],
  ["invalid", "—"],
  ["zero", "0.0%"],
  ["zero-digits", "0%"],
  ["positive", "+12.4%"],
  ["negative", "−12.4%"],
  ["unsigned-positive", "12.4%"],
  ["unsigned-negative", "−12.4%"],
  ["scaled-ratio", "12.5%"],
  ["locale", "+1,234.56%"],
  ["locale-negative", "−1,235%"],
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

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function formatterProbes(page) {
  return page.evaluate(async () => {
    const asset = document.querySelector(
      'meta[name="dpp-asset-revision"]',
    )?.content;
    const suffix = asset ? `?v=${asset}` : "";
    const core = await import(`/assets/format-core.js${suffix}`);
    const shared = await import(`/assets/ui-utils.js${suffix}`);
    const values = [
      ["null", core.percent(null)],
      ["undefined", core.percent(undefined)],
      ["invalid", core.percent("not-a-number")],
      ["zero", core.percent(0)],
      ["zero-digits", core.percent(0, { digits: 0 })],
      ["positive", core.percent(12.44)],
      ["negative", core.percent(-12.44)],
      ["unsigned-positive", core.percent(12.44, { sign: false })],
      ["unsigned-negative", core.percent(-12.44, { sign: false })],
      ["scaled-ratio", core.percent(0.125, { scale: 100, sign: false })],
      ["locale", core.percent(1234.56, { digits: 2 })],
      ["locale-negative", core.percent(-1234.56, { digits: 0, sign: false })],
    ];
    return {
      values,
      sharedNegative: shared.percent(-12.44),
      build: document.querySelector('meta[name="dpp-build-revision"]')?.content,
      asset,
    };
  });
}

async function loadRoute(page, route) {
  const response = await page.goto(`${baseUrl}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const status = response?.status();
  assert(response?.ok() || status === 304, `${route} returned ${status}`);
  await page.waitForTimeout(900);
  await settle(page);
}

if (engines.length) {
  for (const [engineName, engine] of engines) {
    const browser = await engine.launch({ headless: true });
    const scenarios = [
      { label: "desktop-1440", viewport: { width: 1440, height: 1200 } },
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
      const page = await context.newPage();
      const pageMonitor = monitor(page);
      try {
        await loadRoute(page, "/business");
        for (const profile of profiles) {
          await page.evaluate((profileId) => {
            window.dppPresentation.setProfile(profileId);
          }, profile);
          await settle(page);
          const probes = await formatterProbes(page);
          assert(
            JSON.stringify(probes.values) === JSON.stringify(expectedProbes),
            `${engineName} ${scenario.label} ${profile} formatter mismatch: ${JSON.stringify(probes)}`,
          );
          assert(
            probes.sharedNegative === "−12.4%",
            `${engineName} ${scenario.label} ${profile} ui-utils did not re-export canonical percent`,
          );
          checkCount += expectedProbes.length;
        }

        for (const route of routes) {
          await loadRoute(page, route);
          for (const profile of profiles) {
            await page.evaluate((profileId) => {
              window.dppPresentation.setProfile(profileId);
            }, profile);
            await settle(page);
            const asciiPercentages = await page.evaluate(() => {
              const text = document.body.innerText;
              return [...text.matchAll(/(^|[^\w−])-\d[\d,]*(?:\.\d+)?%/gm)].map(
                (match) => match[0].trim(),
              );
            });
            assert(
              !asciiPercentages.length,
              `${engineName} ${scenario.label} ${profile} ${route} renders ASCII-minus percentages: ${asciiPercentages.join(", ")}`,
            );
            checkCount += 1;
          }
        }

        await loadRoute(page, "/sales?view=products");
        await page.locator("#products").screenshot({
          path: path.join(
            outDir,
            `${engineName}-percentage-format-${scenario.label}.png`,
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
          `${engineName} ${scenario.label}: canonical probes and ${routes.length} routes pass in ${profiles.length} profiles`,
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
  routes,
  expectedProbes,
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "percentage-format-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
