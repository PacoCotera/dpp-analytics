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
  await context.route("**/api/data-health*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/data-health") {
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

async function loadDataHealth(page) {
  const response = await page.goto(`${baseUrl}/data-health`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  assert(response?.ok(), `Data Health returned ${response?.status()}`);
  await page
    .locator("#summaryCount")
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelector("#summaryCount")?.textContent.trim() !== "—",
    null,
    { timeout: 10_000 },
  );
  await settle(page);
}

async function setProfileAndClose(page, profile) {
  await page.evaluate((profileId) => {
    window.dppPresentation.setProfile(profileId);
    document.querySelector("#warehouseReference").removeAttribute("open");
  }, profile);
  await settle(page);
}

async function disclosureState(page) {
  const summary = page.locator("#warehouseReferenceSummary");
  const action = page.locator("#warehouseReferenceAction");
  const [snapshot, state] = await Promise.all([
    summary.ariaSnapshot(),
    page.evaluate(() => {
      const reference = document.querySelector("#warehouseReference");
      const summaryNode = document.querySelector("#warehouseReferenceSummary");
      const actionNode = document.querySelector("#warehouseReferenceAction");
      const style = getComputedStyle(actionNode);
      const pseudo = getComputedStyle(actionNode, "::before");
      return {
        open: reference.open,
        accessibleName: summaryNode.getAttribute("aria-label"),
        actionText: actionNode.textContent.trim(),
        actionVisible: actionNode.getClientRects().length > 0,
        actionFontSize: Number.parseFloat(style.fontSize),
        actionWhiteSpace: style.whiteSpace,
        pseudoContent: pseudo.content,
        warehouseTotalsVisible:
          document.querySelector(".source-grid").getClientRects().length > 0,
        pageOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    }),
  ]);
  return { ...state, snapshot };
}

function assertDisclosure(state, expectedOpen, label) {
  const expectedName = expectedOpen
    ? "Hide warehouse totals"
    : "Show warehouse totals";
  assert(state.open === expectedOpen, `${label} has the wrong open state`);
  assert(
    state.accessibleName === expectedName && state.actionText === expectedName,
    `${label} accessible/visible copy diverged: ${JSON.stringify({
      accessibleName: state.accessibleName,
      actionText: state.actionText,
    })}`,
  );
  assert(
    state.snapshot.includes(expectedName) &&
      !state.snapshot.includes("HideShow") &&
      !state.snapshot.includes("ShowHide"),
    `${label} accessibility snapshot is contradictory: ${state.snapshot}`,
  );
  assert(
    state.actionVisible &&
      state.actionFontSize >= 14 &&
      state.actionWhiteSpace === "nowrap",
    `${label} does not visibly render the real action text`,
  );
  assert(
    !state.pseudoContent.includes("Show") &&
      !state.pseudoContent.includes("Hide"),
    `${label} still generates semantic state copy in CSS`,
  );
  assert(
    state.warehouseTotalsVisible === expectedOpen,
    `${label} visible totals do not match disclosure state`,
  );
  assert(
    state.pageOverflow <= 1,
    `${label} creates ${state.pageOverflow}px of page overflow`,
  );
}

let api;
try {
  const response = await fetch(`${baseUrl}/api/data-health`, {
    headers: { accept: "application/json" },
  });
  assert(response.ok, `Data Health API returned ${response.status}`);
  api = await response.json();
} catch (error) {
  failures.push(`API snapshot: ${error.message}`);
}

if (api) {
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
      await installApiSnapshot(context, api);
      const page = await context.newPage();
      const pageMonitor = monitor(page);
      try {
        await loadDataHealth(page);
        for (const profile of profiles) {
          const label = `${engineName} ${scenario.label} ${profile}`;
          await setProfileAndClose(page, profile);
          assertDisclosure(
            await disclosureState(page),
            false,
            `${label} closed`,
          );
          checkCount += 1;

          await page.locator("#warehouseReferenceSummary").focus();
          await page.keyboard.press("Enter");
          await page.waitForFunction(
            () => document.querySelector("#warehouseReference")?.open,
          );
          await settle(page);
          assertDisclosure(await disclosureState(page), true, `${label} Enter`);
          checkCount += 1;

          await page.locator("#warehouseReferenceSummary").focus();
          await page.keyboard.press("Space");
          await page.waitForFunction(
            () => !document.querySelector("#warehouseReference")?.open,
          );
          await settle(page);
          assertDisclosure(
            await disclosureState(page),
            false,
            `${label} Space`,
          );
          checkCount += 1;
        }

        await setProfileAndClose(page, "warm-studio");
        await page.locator("#warehouseReferenceSummary").click();
        await settle(page);
        await page.locator("#warehouseReference").screenshot({
          path: path.join(
            outDir,
            `${engineName}-data-health-disclosure-${scenario.label}.png`,
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
          `${engineName} ${scenario.label}: exact names, visible parity, Enter/Space, and snapshots pass in ${profiles.length} profiles`,
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
  apiState: api
    ? {
        checkedAt: api.checked_at,
        jobs: api.jobs?.length || 0,
      }
    : null,
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "data-health-disclosure-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
