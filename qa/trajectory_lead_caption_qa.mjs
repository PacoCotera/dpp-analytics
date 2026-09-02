import fs from "node:fs/promises";
import path from "node:path";

import { chromium, webkit } from "playwright";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const caption = "28-day shopper-spend change vs prior 28 days";
const stressCaption = `${caption} across reconciled marketplace performance and all comparable prior periods`;
const profiles = [
  "warm-studio",
  "midnight-saffron",
  "aubergine-aqua",
  "midnight-dark",
  "aubergine-dark",
  "weyland",
];
const widths = [819, 820, 821, 1024, 1440];
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

function percent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  const numeric = Number(value);
  if (numeric < 0) return `−${Math.abs(numeric).toFixed(1)}%`;
  return `${numeric > 0 ? "+" : ""}${numeric.toFixed(1)}%`;
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
  await context.route("**/api/trajectory*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/trajectory") {
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

async function loadTrajectory(page) {
  const response = await page.goto(`${baseUrl}/trajectory`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  assert(response?.ok(), `Trajectory returned ${response?.status()}`);
  await page
    .locator(".trajectory-horizon")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function measure(page, profile) {
  return page.evaluate(async (profileId) => {
    window.dppPresentation.setProfile(profileId);
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );

    const box = (node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const lead = document.querySelector(".trajectory-lead");
    const meta = lead.querySelector(".state-read__meta");
    const captionNode = meta.querySelector("span");
    const story = meta.querySelector(".story-number");
    const captionStyle = getComputedStyle(captionNode);
    const range = document.createRange();
    range.selectNodeContents(captionNode);
    return {
      activeProfile: document.documentElement.getAttribute("data-dpp-theme"),
      viewport: { width: innerWidth, height: innerHeight },
      modifier: meta.classList.contains("state-read__meta--prose"),
      caption: captionNode.textContent.trim().replace(/\s+/g, " "),
      story: story.textContent.trim(),
      whiteSpace: captionStyle.whiteSpace,
      overflowWrap: captionStyle.overflowWrap,
      textWrap: captionStyle.textWrap,
      fontSize: Number.parseFloat(captionStyle.fontSize),
      lineCount: range.getClientRects().length,
      captionBox: box(captionNode),
      captionClientWidth: captionNode.clientWidth,
      captionScrollWidth: captionNode.scrollWidth,
      captionClientHeight: captionNode.clientHeight,
      captionScrollHeight: captionNode.scrollHeight,
      metaBox: box(meta),
      leadBox: box(lead),
      leadClientWidth: lead.clientWidth,
      leadScrollWidth: lead.scrollWidth,
      pageOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  }, profile);
}

function assertContained(
  state,
  expectedStory,
  label,
  expectedCaption = caption,
) {
  assert(
    state.activeProfile === label.split(" ").at(-1),
    `${label} did not apply its presentation profile`,
  );
  assert(
    state.modifier &&
      state.whiteSpace === "normal" &&
      state.overflowWrap === "anywhere" &&
      state.textWrap === "pretty",
    `${label} does not use the prose metadata contract`,
  );
  assert(
    state.caption === expectedCaption && state.story === expectedStory,
    `${label} changed the caption or story number: ${JSON.stringify({
      caption: state.caption,
      story: state.story,
    })}`,
  );
  assert(
    state.fontSize >= 14 && state.lineCount >= 1,
    `${label} caption is below the reading floor or has no rendered lines`,
  );
  assert(
    state.captionScrollWidth <= state.captionClientWidth + 1 &&
      state.captionScrollHeight <= state.captionClientHeight + 1,
    `${label} clips caption content: ${JSON.stringify({
      clientWidth: state.captionClientWidth,
      scrollWidth: state.captionScrollWidth,
      clientHeight: state.captionClientHeight,
      scrollHeight: state.captionScrollHeight,
    })}`,
  );
  assert(
    state.captionBox.left >= state.metaBox.left - 1 &&
      state.captionBox.right <= state.metaBox.right + 1 &&
      state.captionBox.top >= state.metaBox.top - 1 &&
      state.captionBox.bottom <= state.metaBox.bottom + 1,
    `${label} caption is outside its metadata aside`,
  );
  assert(
    state.metaBox.left >= state.leadBox.left - 1 &&
      state.metaBox.right <= state.leadBox.right + 1 &&
      state.metaBox.top >= state.leadBox.top - 1 &&
      state.metaBox.bottom <= state.leadBox.bottom + 1,
    `${label} metadata aside is outside the lead`,
  );
  assert(
    state.leadScrollWidth <= state.leadClientWidth + 1 &&
      state.pageOverflow <= 1,
    `${label} creates hidden lead or page overflow`,
  );
}

let api;
try {
  const response = await fetch(`${baseUrl}/api/trajectory`, {
    headers: { accept: "application/json" },
  });
  assert(response.ok, `Trajectory API returned ${response.status}`);
  api = await response.json();
} catch (error) {
  failures.push(`API snapshot: ${error.message}`);
}

if (api) {
  const expectedStory = percent(api.headline?.delta28_pct);
  for (const [engineName, engine] of engines) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1200 },
    });
    await installApiSnapshot(context, api);
    const page = await context.newPage();
    const pageMonitor = monitor(page);
    try {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1200 });
        await loadTrajectory(page);
        for (const profile of profiles) {
          const state = await measure(page, profile);
          assertContained(
            state,
            expectedStory,
            `${engineName} ${width}px ${profile}`,
          );
          if (width > 820) {
            assert(
              state.lineCount >= 2,
              `${engineName} ${width}px ${profile} did not wrap the constrained caption`,
            );
          }
          checkCount += 1;
        }

        await page.evaluate((value) => {
          document.querySelector(
            ".trajectory-lead .state-read__meta span",
          ).textContent = value;
        }, stressCaption);
        const stressState = await measure(page, "weyland");
        assertContained(
          stressState,
          expectedStory,
          `${engineName} ${width}px weyland`,
          stressCaption,
        );
        checkCount += 1;
        await page.evaluate((value) => {
          document.querySelector(
            ".trajectory-lead .state-read__meta span",
          ).textContent = value;
        }, caption);
        checks.push(
          `${engineName} ${width}px: actual and stress captions remain fully contained in ${profiles.length} profiles`,
        );
      }

      await measure(page, "warm-studio");
      await page.screenshot({
        path: path.join(outDir, `${engineName}-trajectory-lead-caption.png`),
        fullPage: false,
      });
      assert(
        !pageMonitor.browserErrors.length,
        `${engineName} browser errors: ${pageMonitor.browserErrors.join("; ")}`,
      );
      assert(
        !pageMonitor.failedResponses.length,
        `${engineName} failed responses: ${pageMonitor.failedResponses.join("; ")}`,
      );
    } catch (error) {
      failures.push(`${engineName}: ${error.message}`);
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

const summary = {
  status: failures.length ? "FAIL" : "PASS",
  checkCount,
  engines: engines.map(([name]) => name),
  profiles,
  widths,
  caption,
  apiState: api
    ? {
        throughDate: api.headline?.business_date,
        storyNumber: percent(api.headline?.delta28_pct),
      }
    : null,
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "trajectory-lead-caption-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
