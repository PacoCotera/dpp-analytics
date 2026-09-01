import { chromium, webkit } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

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
const viewports = [
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "1440x1200", width: 1440, height: 1200 },
];
const engines = [
  ["chromium", chromium],
  ["webkit", webkit],
];
const shortRoutes = [
  { path: "/ads", stateSelector: "#emptyState" },
  { path: "/admin", stateSelector: ".admin-login" },
];
const failures = [];
const checks = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function loadRoute(page, route) {
  const response = await page.goto(`${baseUrl}${route}`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  const status = response?.status();
  assert(response?.ok() || status === 304, `${route} returned ${status}`);
  await settle(page);
}

async function shellGeometry(page) {
  return page.evaluate(() => {
    const app = document.querySelector(".app");
    const main = [...(app?.querySelectorAll(":scope > main") || [])].find(
      (candidate) => getComputedStyle(candidate).display !== "none",
    );
    const footer = app?.querySelector(":scope > footer.footer");
    if (!app || !main || !footer) return null;
    const appRect = app.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const footerRect = footer.getBoundingClientRect();
    const appStyle = getComputedStyle(app);
    const mainStyle = getComputedStyle(main);
    return {
      viewportHeight: window.innerHeight,
      documentHeight: document.documentElement.scrollHeight,
      horizontalOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 2,
      appBottom: appRect.bottom,
      appPaddingBottom: Number.parseFloat(appStyle.paddingBottom),
      appDisplay: appStyle.display,
      appDirection: appStyle.flexDirection,
      mainBottom: mainRect.bottom,
      mainFlexGrow: mainStyle.flexGrow,
      mainFlexShrink: mainStyle.flexShrink,
      footerTop: footerRect.top,
      footerBottom: footerRect.bottom,
    };
  });
}

function assertSharedShell(geometry, label) {
  assert(geometry, `${label} shell geometry is unavailable`);
  assert(
    geometry.appDisplay === "flex" && geometry.appDirection === "column",
    `${label} app is ${geometry.appDisplay}/${geometry.appDirection}`,
  );
  assert(
    geometry.mainFlexGrow === "1" && geometry.mainFlexShrink === "0",
    `${label} main flex is ${geometry.mainFlexGrow}/${geometry.mainFlexShrink}`,
  );
  assert(!geometry.horizontalOverflow, `${label} has horizontal overflow`);
  assert(
    geometry.footerTop >= geometry.mainBottom,
    `${label} footer overlaps main`,
  );
  const expectedFooterBottom = geometry.appBottom - geometry.appPaddingBottom;
  assert(
    Math.abs(geometry.footerBottom - expectedFooterBottom) <= 2,
    `${label} footer does not terminate at the shell floor: ${JSON.stringify(geometry)}`,
  );
}

for (const [engineName, engine] of engines) {
  const browser = await engine.launch({ headless: true });
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const browserErrors = [];
    const failedResponses = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400 && response.url().startsWith(baseUrl)) {
        failedResponses.push(`${response.status()} ${response.url()}`);
      }
    });
    await page.route("**/api/ads", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "not_initialized",
          local_time: "2026-08-28T08:00:00-06:00",
          connection: {
            state: "NOT_CONNECTED",
            badge: "Ads not connected",
            headline: "Amazon Ads is not connected.",
            detail:
              "Connect Amazon Ads before paid-support reporting can start.",
          },
          freshness: null,
          quality: {
            state: "NO_DATA",
            trusted_for_operating_decisions: false,
            issues: [],
          },
          summary: {},
          daily: [],
          campaigns: [],
          products: [],
          targets: [],
          search_terms: [],
          actions: [],
        }),
      }),
    );

    try {
      for (const route of shortRoutes) {
        await loadRoute(page, route.path);
        await page
          .locator(route.stateSelector)
          .waitFor({ state: "visible", timeout: 10_000 });
        for (const profile of profiles) {
          await page.evaluate(
            (profileId) => window.dppPresentation.setProfile(profileId),
            profile,
          );
          await settle(page);
          const geometry = await shellGeometry(page);
          const label = `${engineName} ${viewport.label} ${profile} ${route.path}`;
          assertSharedShell(geometry, label);
          assert(
            Math.abs(geometry.documentHeight - geometry.viewportHeight) <= 2 &&
              geometry.footerBottom <= geometry.viewportHeight,
            `${label} leaves a short-state canvas beyond the footer: ${JSON.stringify(geometry)}`,
          );
          checks.push(`${label}: short-state footer reaches shell floor`);
        }
        await page.screenshot({
          path: path.join(
            outDir,
            `${engineName}-short-state-footer-${viewport.label}-${route.path.slice(1)}.png`,
          ),
          fullPage: true,
        });
      }

      await loadRoute(page, "/sales?view=products");
      for (const profile of profiles) {
        await page.evaluate(
          (profileId) => window.dppPresentation.setProfile(profileId),
          profile,
        );
        await settle(page);
        const geometry = await shellGeometry(page);
        const label = `${engineName} ${viewport.label} ${profile} /sales`;
        assertSharedShell(geometry, label);
        assert(
          geometry.documentHeight > geometry.viewportHeight + 2 &&
            geometry.footerBottom > geometry.viewportHeight,
          `${label} does not retain natural long-page scrolling: ${JSON.stringify(geometry)}`,
        );
        checks.push(`${label}: long route scrolls naturally`);
      }
      assert(
        !browserErrors.length,
        `${engineName} ${viewport.label} browser errors: ${browserErrors}`,
      );
      assert(
        !failedResponses.length,
        `${engineName} ${viewport.label} failed responses: ${failedResponses}`,
      );
    } catch (error) {
      failures.push(`${engineName} ${viewport.label}: ${error.message}`);
    } finally {
      await context.close();
    }
  }
  await browser.close();
}

const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  status: failures.length ? "FAIL" : "PASS",
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "short-state-footer-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(
  JSON.stringify(
    { status: summary.status, checks: checks.length, failures },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 3;
