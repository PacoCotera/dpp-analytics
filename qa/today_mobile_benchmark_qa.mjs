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
const boundaryWidths = [639, 640, 641];
const requestedEngines = new Set(
  String(process.env.DPP_QA_ENGINES || "chromium,webkit")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const engines = [
  ["chromium", chromium, { width: 393, height: 727, deviceScaleFactor: 2.75 }],
  ["webkit", webkit, { width: 390, height: 664, deviceScaleFactor: 3 }],
].filter(([name]) => requestedEngines.has(name));
const failures = [];
const checks = [];
let checkCount = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function signedPercent0(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "—";
  return `${numeric >= 0 ? "+" : "−"}${Math.abs(numeric).toFixed(0)}%`;
}

function expectedBenchmarks(api) {
  const context = api.context || {};
  return [
    { label: "MTD", value: signedPercent0(Number(context.mtd_delta_pct)) },
    { label: "30D", value: signedPercent0(Number(context.last30_delta_pct)) },
    { label: "WTD", value: signedPercent0(Number(context.week_delta_pct)) },
  ];
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
  await context.route("**/api/today*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== "/api/today") {
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

async function loadToday(page) {
  const response = await page.goto(`${baseUrl}/`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  assert(response?.ok(), `Today returned ${response?.status()}`);
  await page
    .locator("#pulseExplanation .business-benchmark")
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
      if (!node) return null;
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
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      return (
        getComputedStyle(node).display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const context = document.querySelector(".today-context");
    const contextLabel = document.querySelector("#pulseContextLabel");
    const headline = document.querySelector("#pulseHeadline");
    const explanation = document.querySelector("#pulseExplanation");
    const definition = context.querySelector(":scope > .rule-trigger");
    const benchmarks = [
      ...explanation.querySelectorAll(".business-benchmark"),
    ].map((benchmark) => ({
      label: benchmark.querySelector("b")?.textContent?.trim(),
      value: benchmark.querySelector("strong")?.textContent?.trim(),
      box: box(benchmark),
      fontSize: Number.parseFloat(getComputedStyle(benchmark).fontSize),
    }));
    return {
      activeProfile: document.documentElement.getAttribute("data-dpp-theme"),
      viewport: { width: innerWidth, height: innerHeight },
      context: {
        box: box(context),
        live: context.getAttribute("aria-live"),
        labelledBy: context.getAttribute("aria-labelledby"),
        describedBy: context.getAttribute("aria-describedby"),
      },
      contextLabel: {
        id: contextLabel.id,
        text: contextLabel.textContent.trim(),
      },
      headline: {
        text:
          headline.childNodes[0]?.textContent?.trim() ||
          headline.textContent.trim(),
        box: box(headline),
        describedBy: headline.getAttribute("aria-describedby"),
      },
      explanation: {
        box: box(explanation),
        visible: visible(explanation),
        display: getComputedStyle(explanation).display,
      },
      definition: definition
        ? {
            box: box(definition),
            visible: visible(definition),
          }
        : null,
      benchmarks,
      lead: box(document.querySelector(".today-lead")),
      demand: box(document.querySelector(".today-demand")),
      pageOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  }, profile);
}

function assertBenchmarks(state, expected, label, { compact }) {
  const profile = label.split(" ").at(-1);
  assert(
    state.activeProfile === profile,
    `${label} did not apply its presentation profile`,
  );
  assert(
    state.context.live === "polite" &&
      state.context.labelledBy === "pulseContextLabel pulseHeadline" &&
      state.context.describedBy === "pulseExplanation" &&
      state.headline.describedBy === "pulseExplanation",
    `${label} has incomplete benchmark associations`,
  );
  assert(
    state.contextLabel.id === "pulseContextLabel" &&
      state.contextLabel.text === "Business context",
    `${label} lost its context label`,
  );
  assert(
    state.explanation.visible && state.benchmarks.length === 3,
    `${label} does not expose all three benchmarks`,
  );
  const rendered = state.benchmarks.map(({ label: benchmarkLabel, value }) => ({
    label: benchmarkLabel,
    value,
  }));
  assert(
    JSON.stringify(rendered) === JSON.stringify(expected),
    `${label} rendered ${JSON.stringify(rendered)} instead of ${JSON.stringify(expected)}`,
  );
  for (let index = 0; index < state.benchmarks.length; index += 1) {
    const benchmark = state.benchmarks[index];
    assert(
      benchmark.fontSize >= 14 &&
        benchmark.box.left >= state.explanation.box.left - 1 &&
        benchmark.box.right <= state.explanation.box.right + 1 &&
        benchmark.box.top >= state.explanation.box.top - 1 &&
        benchmark.box.bottom <= state.explanation.box.bottom + 1,
      `${label} benchmark ${benchmark.label} is clipped or below the 14px reading floor`,
    );
    if (index > 0) {
      assert(
        state.benchmarks[index - 1].box.right <= benchmark.box.left + 1,
        `${label} benchmark ${benchmark.label} overlaps its neighbour`,
      );
    }
  }
  assert(
    state.pageOverflow <= 1,
    `${label} creates ${state.pageOverflow}px page overflow`,
  );
  if (compact) {
    assert(
      state.explanation.display === "grid" &&
        state.context.box.height <= 108 &&
        state.lead.height <= 460 &&
        state.demand.top <= 760,
      `${label} regressed the compact first viewport: ${JSON.stringify({
        context: state.context.box,
        lead: state.lead,
        demand: state.demand,
      })}`,
    );
    if (state.definition) {
      assert(
        state.definition.visible &&
          state.definition.box.width >= 44 &&
          state.definition.box.height >= 44,
        `${label} definition target is not visible at 44×44`,
      );
    }
  }
}

let api;
try {
  const response = await fetch(`${baseUrl}/api/today`, {
    headers: { accept: "application/json" },
  });
  assert(response.ok, `Today API returned ${response.status}`);
  api = await response.json();
} catch (error) {
  failures.push(`API snapshot: ${error.message}`);
}

if (api) {
  const expected = expectedBenchmarks(api);
  for (const [engineName, engine, mobile] of engines) {
    const browser = await engine.launch({ headless: true });
    try {
      const desktopContext = await browser.newContext({
        viewport: { width: 1440, height: 1200 },
      });
      await installApiSnapshot(desktopContext, api);
      const desktopPage = await desktopContext.newPage();
      const desktopMonitor = monitor(desktopPage);
      await loadToday(desktopPage);
      for (const profile of profiles) {
        const state = await measure(desktopPage, profile);
        assertBenchmarks(state, expected, `${engineName} desktop ${profile}`, {
          compact: false,
        });
        checkCount += 1;
      }
      assert(
        !desktopMonitor.browserErrors.length,
        `${engineName} desktop browser errors: ${desktopMonitor.browserErrors.join("; ")}`,
      );
      assert(
        !desktopMonitor.failedResponses.length,
        `${engineName} desktop failed responses: ${desktopMonitor.failedResponses.join("; ")}`,
      );
      checks.push(
        `${engineName} desktop: API snapshot matches visible benchmarks in ${profiles.length} profiles`,
      );
      await desktopContext.close();

      const mobileContext = await browser.newContext({
        viewport: { width: mobile.width, height: mobile.height },
        deviceScaleFactor: mobile.deviceScaleFactor,
        isMobile: true,
        hasTouch: true,
      });
      await installApiSnapshot(mobileContext, api);
      const mobilePage = await mobileContext.newPage();
      const mobileMonitor = monitor(mobilePage);
      await loadToday(mobilePage);
      for (const profile of profiles) {
        const state = await measure(mobilePage, profile);
        assertBenchmarks(state, expected, `${engineName} mobile ${profile}`, {
          compact: true,
        });
        checkCount += 1;
      }
      await mobilePage.screenshot({
        path: path.join(outDir, `${engineName}-today-mobile-benchmarks.png`),
        fullPage: false,
      });
      checks.push(
        `${engineName} ${mobile.width}×${mobile.height} @${mobile.deviceScaleFactor}: compact evidence is visible in ${profiles.length} profiles`,
      );

      for (const width of boundaryWidths) {
        await mobilePage.setViewportSize({ width, height: 915 });
        await loadToday(mobilePage);
        for (const profile of profiles) {
          const state = await measure(mobilePage, profile);
          assertBenchmarks(
            state,
            expected,
            `${engineName} ${width}px ${profile}`,
            { compact: width <= 640 },
          );
          checkCount += 1;
        }
        checks.push(
          `${engineName} ${width}px: benchmark evidence survives the responsive boundary`,
        );
      }
      assert(
        !mobileMonitor.browserErrors.length,
        `${engineName} mobile browser errors: ${mobileMonitor.browserErrors.join("; ")}`,
      );
      assert(
        !mobileMonitor.failedResponses.length,
        `${engineName} mobile failed responses: ${mobileMonitor.failedResponses.join("; ")}`,
      );
      await mobileContext.close();
    } catch (error) {
      failures.push(`${engineName}: ${error.message}`);
    } finally {
      await browser.close();
    }
  }
}

const summary = {
  status: failures.length ? "FAIL" : "PASS",
  checkCount,
  engines: engines.map(([name]) => name),
  profiles,
  nativeViewports: Object.fromEntries(
    engines.map(([name, , viewport]) => [name, viewport]),
  ),
  boundaryWidths,
  apiState: api
    ? {
        selectedDate: api.selected_date || api.local_today,
        benchmarks: expectedBenchmarks(api),
      }
    : null,
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "today-mobile-benchmark-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
