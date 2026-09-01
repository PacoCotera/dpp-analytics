import fs from "node:fs/promises";
import path from "node:path";

import { chromium, webkit } from "playwright";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
const apiSnapshotUrl =
  process.env.DPP_QA_TRAJECTORY_API_URL || `${baseUrl}/api/trajectory`;
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

function utcMondayKey(dateText) {
  const date = new Date(`${dateText.slice(0, 10)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function markContract(series, windowName) {
  let rows;
  if (windowName === "90d") rows = series.slice(-90);
  else if (windowName === "ytd") {
    const year = String(series.at(-1)?.business_date || "").slice(0, 4);
    rows = series.filter((row) =>
      String(row.business_date || "").startsWith(year),
    );
  } else rows = series.slice(-180);

  if (rows.length <= 120) {
    return {
      weekly: false,
      marks: rows.map((row) => ({
        date: row.business_date.slice(0, 10),
        days: 1,
      })),
    };
  }

  const groups = new Map();
  for (const row of rows) {
    const key = utcMondayKey(row.business_date);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return {
    weekly: true,
    marks: [...groups.values()].map((group) => ({
      date: group[0].business_date.slice(0, 10),
      days: group.length,
    })),
  };
}

function dateLabel(dateText) {
  const date = new Date(`${dateText}T12:00:00Z`);
  return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()]} ${date.getUTCDate()}`;
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
    .locator("#chart .dpp-bar")
    .first()
    .waitFor({ state: "visible", timeout: 10_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function selectWindow(page, windowName) {
  await page.locator(`[data-trajectory-window="${windowName}"]`).click();
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
    const axes = [...document.querySelectorAll("#chart .dpp-axis")];
    const tickNodes = [
      ...(axes.at(-1)?.querySelectorAll(".tick text") || []),
    ].filter((node) => node.textContent.trim());
    const ticks = tickNodes
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          text: node.textContent.trim(),
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      })
      .sort((a, b) => a.left - b.left);
    const bars = [...document.querySelectorAll("#chart .dpp-bar")].map(
      (node) => ({
        date: node.__data__.date.toISOString().slice(0, 10),
        days: node.__data__.days || 1,
      }),
    );
    return {
      activeProfile: document.documentElement.getAttribute("data-dpp-theme"),
      activeWindow: document.querySelector(
        '[data-trajectory-window][aria-pressed="true"]',
      )?.dataset.trajectoryWindow,
      url: location.pathname + location.search,
      description: document
        .querySelector("#trajectoryChartDescription")
        ?.textContent.trim(),
      ariaLabel: document.querySelector("#chart")?.getAttribute("aria-label"),
      bars,
      ticks,
      gaps: ticks.slice(1).map((tick, index) => tick.left - ticks[index].right),
      ticksReadable: ticks.every(
        (tick) =>
          tick.left >= -1 &&
          tick.right <= document.documentElement.clientWidth + 1,
      ),
      pageOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  }, profile);
}

function assertState(
  state,
  contract,
  engineName,
  scenario,
  profile,
  windowName,
) {
  const label = `${engineName} ${scenario.label} ${profile} ${windowName}`;
  assert(
    state.activeProfile === profile,
    `${label} did not apply its presentation profile`,
  );
  assert(
    state.activeWindow === windowName,
    `${label} did not activate the requested window`,
  );
  const expectedUrl =
    windowName === "180d" ? "/trajectory" : `/trajectory?window=${windowName}`;
  assert(
    state.url === expectedUrl,
    `${label} URL state is ${state.url}, expected ${expectedUrl}`,
  );
  assert(
    state.description.startsWith(
      `${windowName === "90d" ? "90 days" : windowName === "ytd" ? "Year to date" : "180 days"} · ${contract.weekly ? "weekly average daily" : "daily"}`,
    ),
    `${label} description does not disclose the aggregation`,
  );
  assert(
    state.ariaLabel.startsWith(
      contract.weekly ? "Weekly average daily" : "Daily shopper spend",
    ),
    `${label} chart label does not disclose the aggregation`,
  );
  assert(
    JSON.stringify(state.bars) === JSON.stringify(contract.marks),
    `${label} changed the selected rows or weekly aggregation`,
  );
  assert(
    state.ticks.length >= 2,
    `${label} rendered fewer than two x-axis labels`,
  );
  assert(
    state.gaps.every((gap) => gap >= -0.5),
    `${label} has intersecting x-axis labels: ${JSON.stringify({ ticks: state.ticks, gaps: state.gaps })}`,
  );
  assert(
    state.ticksReadable,
    `${label} renders an x-axis label outside the readable viewport`,
  );
  assert(
    state.pageOverflow <= 1,
    `${label} creates ${state.pageOverflow}px of page overflow`,
  );
  if (contract.weekly) {
    assert(
      state.ticks[0].text === dateLabel(contract.marks[0].date) &&
        state.ticks.at(-1).text === dateLabel(contract.marks.at(-1).date),
      `${label} dropped a weekly endpoint label: ${JSON.stringify(state.ticks.map((tick) => tick.text))}`,
    );
  }
}

let api;
try {
  const response = await fetch(apiSnapshotUrl, {
    headers: { accept: "application/json" },
  });
  assert(response.ok, `Trajectory API returned ${response.status}`);
  api = await response.json();
} catch (error) {
  failures.push(`API snapshot: ${error.message}`);
}

if (api) {
  const contracts = Object.fromEntries(
    ["90d", "180d", "ytd"].map((windowName) => [
      windowName,
      markContract(api.series || [], windowName),
    ]),
  );
  for (const [engineName, engine] of engines) {
    const browser = await engine.launch({ headless: true });
    const scenarios = [
      { label: "desktop-1440", viewport: { width: 1440, height: 1200 } },
      { label: "desktop-641", viewport: { width: 641, height: 900 } },
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
        await loadTrajectory(page);
        for (const profile of profiles) {
          for (const windowName of ["90d", "180d", "ytd"]) {
            await selectWindow(page, windowName);
            const state = await measure(page, profile);
            assertState(
              state,
              contracts[windowName],
              engineName,
              scenario,
              profile,
              windowName,
            );
            checkCount += 1;
          }
        }
        await selectWindow(page, "180d");
        await measure(page, "warm-studio");
        await page.screenshot({
          path: path.join(
            outDir,
            `${engineName}-trajectory-axis-${scenario.label}.png`,
          ),
          fullPage: false,
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
          `${engineName} ${scenario.label}: 90D/180D/YTD aggregation, endpoints, and label bounds pass in ${profiles.length} profiles`,
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
        throughDate: api.headline?.business_date,
        seriesRows: api.series?.length || 0,
      }
    : null,
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "trajectory-axis-ticks-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
