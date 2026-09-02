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

async function loadExpandedSales(page) {
  const response = await page.goto(`${baseUrl}/sales`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  assert(response?.ok(), `Sales returned ${response?.status()}`);
  await page
    .locator("#monthChart .dpp-bar")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 });
  await page.locator("#salesReference > summary").click();
  await page.locator("#salesReference[open] .sales-momentum-card").waitFor({
    state: "visible",
    timeout: 5_000,
  });
  await settle(page);
}

async function momentumState(page) {
  const snapshot = await page.locator("#salesReference").ariaSnapshot();
  const geometry = await page.evaluate(() => {
    const reference = document.getElementById("salesReference");
    const card = reference?.querySelector(".sales-momentum-card");
    const rows = [...(card?.querySelectorAll(".sales-momentum-row") || [])];
    const ytd = reference?.querySelector(".sales-utility-ytd");
    if (!reference || !card || rows.length !== 2 || !ytd) return null;

    const referenceRect = reference.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const contained = (node, ownerRect = referenceRect) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.left >= ownerRect.left - 1 &&
        rect.right <= ownerRect.right + 1 &&
        rect.top >= ownerRect.top - 1 &&
        rect.bottom <= ownerRect.bottom + 1
      );
    };
    const valueNodes = [
      ...rows.flatMap((row) => [
        ...row.querySelectorAll(
          ".sales-signal-label,.sales-signal-value,.sales-volume,.sales-signal-note",
        ),
      ]),
      ...ytd.querySelectorAll(
        ".sales-signal-label,.sales-signal-value,.sales-volume,.sales-signal-note",
      ),
    ];
    const valueRects = valueNodes.map((node) => ({
      label: node.textContent.trim(),
      rect: node.getBoundingClientRect(),
    }));
    const collisions = [];
    for (let index = 0; index < valueRects.length; index += 1) {
      for (let compare = index + 1; compare < valueRects.length; compare += 1) {
        const first = valueRects[index];
        const second = valueRects[compare];
        if (
          first.rect.left < second.rect.right - 1 &&
          first.rect.right > second.rect.left + 1 &&
          first.rect.top < second.rect.bottom - 1 &&
          first.rect.bottom > second.rect.top + 1
        ) {
          collisions.push([first.label, second.label]);
        }
      }
    }
    const rowRects = rows.map((row) => row.getBoundingClientRect());
    return {
      referenceWidth: referenceRect.width,
      referenceClientWidth: reference.clientWidth,
      referenceScrollWidth: reference.scrollWidth,
      cardWidth: cardRect.width,
      cardClientWidth: card.clientWidth,
      cardScrollWidth: card.scrollWidth,
      gridColumns: getComputedStyle(card).gridTemplateColumns,
      rows: rowRects.map((rect) => ({
        width: rect.width,
        left: rect.left,
        right: rect.right,
      })),
      rowsContained: rows.map((row) => contained(row, cardRect)),
      valuesContained: valueNodes.map((node) => contained(node)),
      collisions,
      ytdContained: contained(ytd),
      rowOverlap: rowRects[0].bottom > rowRects[1].top + 1,
      documentOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
      text: reference.textContent,
    };
  });
  return { snapshot, geometry };
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
      await loadExpandedSales(page);
      for (const profile of profiles) {
        await page.evaluate(
          (profileId) => window.dppPresentation.setProfile(profileId),
          profile,
        );
        await settle(page);
        const state = await momentumState(page);
        assert(
          state.geometry,
          `${scenario} ${profile} momentum geometry is unavailable`,
        );
        const { geometry, snapshot } = state;
        assert(
          geometry.referenceScrollWidth <= geometry.referenceClientWidth + 1 &&
            geometry.cardScrollWidth <= geometry.cardClientWidth + 1 &&
            geometry.documentOverflow <= 1,
          `${scenario} ${profile} overflows: ${JSON.stringify(geometry)}`,
        );
        assert(
          geometry.rowsContained.every(Boolean) &&
            geometry.valuesContained.every(Boolean) &&
            geometry.ytdContained,
          `${scenario} ${profile} clips momentum content: ${JSON.stringify(geometry)}`,
        );
        assert(
          !geometry.rowOverlap,
          `${scenario} ${profile} overlaps momentum rows`,
        );
        assert(
          !geometry.collisions.length,
          `${scenario} ${profile} overlaps momentum values: ${JSON.stringify(geometry.collisions)}`,
        );
        assert(
          geometry.rows.every((row) => row.width >= geometry.cardWidth - 28),
          `${scenario} ${profile} compresses momentum rows: ${JSON.stringify(geometry.rows)}`,
        );
        for (const expected of [
          "7D · incl. IVA",
          "28D · incl. IVA",
          "YTD · incl. IVA",
        ]) {
          assert(
            geometry.text.includes(expected) && snapshot.includes(expected),
            `${scenario} ${profile} is missing ${expected}`,
          );
        }
        checkCount += 1;
      }

      await page.evaluate(() =>
        window.dppPresentation.setProfile("warm-studio"),
      );
      await settle(page);
      await page.locator("#salesReference").screenshot({
        path: path.join(
          outDir,
          `${engineName}-sales-momentum-${viewport.width}x${viewport.height}.png`,
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
        `${scenario}: expanded 7D/28D/YTD content is contained in ${profiles.length} profiles`,
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
  path.join(outDir, "sales-momentum-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
