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
const viewports = [
  { width: 360, height: 800 },
  { width: 412, height: 915 },
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

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function settleChevronTransitions(page) {
  await settle(page);
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll(".family[open] > summary > .chev")].every(
        (chevron) =>
          chevron
            .getAnimations()
            .every(
              (animation) =>
                animation.playState !== "running" &&
                animation.playState !== "pending",
            ),
      ),
    undefined,
    { timeout: 2_000 },
  );
  await settle(page);
}

async function familyState(page) {
  return page.evaluate(() => {
    const families = [
      ...document.querySelectorAll("#portfolio > .family[open]"),
    ];
    const rect = (node) => {
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        right: value.right,
        top: value.top,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    const contained = (inner, outer) =>
      inner.left >= outer.left - 1 &&
      inner.right <= outer.right + 1 &&
      inner.top >= outer.top - 1 &&
      inner.bottom <= outer.bottom + 1;

    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      openCount: families.length,
      families: families.map((family) => {
        const familyRect = rect(family);
        const summaryRect = rect(family.querySelector(":scope > summary"));
        const chevronRect = rect(
          family.querySelector(":scope > summary > .chev"),
        );
        const childrenRect = rect(family.querySelector(":scope > .children"));
        return {
          familyRect,
          summaryRect,
          chevronRect,
          childrenRect,
          summaryContained: contained(summaryRect, familyRect),
          chevronContained: contained(chevronRect, summaryRect),
          childrenContained: contained(childrenRect, familyRect),
        };
      }),
    };
  });
}

for (const [engineName, engine] of engines) {
  const browser = await engine.launch({ headless: true });
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport,
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const pageMonitor = monitor(page);
    const scenario = `${engineName} ${viewport.width}x${viewport.height}`;
    try {
      const response = await page.goto(`${baseUrl}/catalog`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      assert(response?.ok(), `Catalog returned ${response?.status()}`);
      const families = page.locator("#portfolio > .family");
      await families.first().waitFor({ state: "visible", timeout: 15_000 });
      await families.first().locator(":scope > summary").click();
      await settleChevronTransitions(page);

      for (const profile of profiles) {
        await page.evaluate(
          (profileId) => window.dppPresentation.setProfile(profileId),
          profile,
        );
        await settle(page);
        const state = await familyState(page);
        assert(
          state.openCount === 1,
          `${scenario} ${profile} lost the open family`,
        );
        assert(
          state.documentWidth <= state.viewportWidth + 1,
          `${scenario} ${profile} page overflow: ${JSON.stringify(state)}`,
        );
        const family = state.families[0];
        assert(
          family.summaryContained &&
            family.chevronContained &&
            family.childrenContained,
          `${scenario} ${profile} clips the expanded family: ${JSON.stringify(family)}`,
        );
        assert(
          family.chevronRect.width <= 42 && family.chevronRect.height <= 42,
          `${scenario} ${profile} stretches the expanded chevron: ${JSON.stringify(family.chevronRect)}`,
        );
        checkCount += 1;
      }

      if ((await families.count()) > 1) {
        await families.nth(1).locator(":scope > summary").click();
        await settleChevronTransitions(page);
        const state = await familyState(page);
        assert(
          state.openCount === 2,
          `${scenario} did not keep both families open`,
        );
        assert(
          state.documentWidth <= state.viewportWidth + 1 &&
            state.families.every(
              (family) =>
                family.summaryContained &&
                family.chevronContained &&
                family.childrenContained &&
                family.chevronRect.width <= 42 &&
                family.chevronRect.height <= 42,
            ),
          `${scenario} overflows with both families open: ${JSON.stringify(state)}`,
        );
      }

      await page.evaluate(() =>
        window.dppPresentation.setProfile("warm-studio"),
      );
      await settle(page);
      await families.first().screenshot({
        path: path.join(
          outDir,
          `${engineName}-catalog-family-${viewport.width}x${viewport.height}.png`,
        ),
      });
      assert(
        !pageMonitor.browserErrors.length,
        `${scenario} browser errors: ${pageMonitor.browserErrors.join("; ")}`,
      );
      assert(
        !pageMonitor.failedResponses.length,
        `${scenario} failed responses: ${pageMonitor.failedResponses.join("; ")}`,
      );
      checks.push(
        `${scenario}: expanded family containment passed in ${profiles.length} profiles`,
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
  path.join(outDir, "catalog-family-overflow-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
