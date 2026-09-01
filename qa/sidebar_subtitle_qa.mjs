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
  "/",
  "/business",
  "/sales",
  "/catalog",
  "/product?sku=PNC-001",
  "/inventory",
  "/finance",
  "/ads",
  "/trajectory",
  "/data-health",
  "/admin",
];
const breakpointWidths = [899, 900, 901, 1099, 1100, 1101];
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

async function loadShell(page, route) {
  const response = await page.goto(`${baseUrl}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  assert(response?.ok(), `${route} returned ${response?.status()}`);
  await page
    .locator("#app-sidebar .app-sidebar__brand .brand-sub")
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
    const sidebar = document.querySelector("#app-sidebar");
    const header = sidebar.querySelector(".app-sidebar__header");
    const brand = sidebar.querySelector(".app-sidebar__brand");
    const mark = brand.querySelector(".mark");
    const copy = brand.querySelector(".brand-copy");
    const title = brand.querySelector(".brand-title");
    const subtitle = brand.querySelector(".brand-sub");
    const nav = sidebar.querySelector("#app-navigation");
    const shellHeader = document.querySelector(".shell-global-header");
    const subtitleStyle = getComputedStyle(subtitle);
    const range = document.createRange();
    range.selectNodeContents(subtitle);

    return {
      activeProfile: document.documentElement.getAttribute("data-dpp-theme"),
      text: subtitle.textContent.trim().replace(/\s+/g, " "),
      sidebar: {
        ...box(sidebar),
        clientWidth: sidebar.clientWidth,
        scrollWidth: sidebar.scrollWidth,
      },
      header: box(header),
      brand: box(brand),
      mark: box(mark),
      copy: box(copy),
      title: box(title),
      subtitle: {
        ...box(subtitle),
        clientWidth: subtitle.clientWidth,
        scrollWidth: subtitle.scrollWidth,
        clientHeight: subtitle.clientHeight,
        scrollHeight: subtitle.scrollHeight,
        whiteSpace: subtitleStyle.whiteSpace,
        textWrap: subtitleStyle.textWrap,
        lineCount: range.getClientRects().length,
      },
      nav: box(nav),
      shellHeader: box(shellHeader),
      documentOverflow: Math.max(
        0,
        document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    };
  }, profile);
}

function assertContained(state, label, { alignedHeaders }) {
  assert(
    state.text === "Business · Amazon Mexico",
    `${label} has marketplace label ${JSON.stringify(state.text)}`,
  );
  assert(
    state.subtitle.whiteSpace === "normal" &&
      state.subtitle.textWrap === "balance",
    `${label} does not use the balanced wrapping contract`,
  );
  assert(
    state.subtitle.lineCount === 2,
    `${label} uses ${state.subtitle.lineCount} subtitle lines`,
  );
  assert(
    state.subtitle.scrollWidth <= state.subtitle.clientWidth + 1 &&
      state.subtitle.scrollHeight <= state.subtitle.clientHeight + 1,
    `${label} clips its subtitle: ${JSON.stringify(state.subtitle)}`,
  );
  assert(
    state.sidebar.scrollWidth <= state.sidebar.clientWidth + 1,
    `${label} overflows its sidebar: ${JSON.stringify(state.sidebar)}`,
  );
  assert(
    state.brand.left >= state.header.left - 1 &&
      state.brand.right <= state.header.right + 1 &&
      state.brand.top >= state.header.top - 1 &&
      state.brand.bottom <= state.header.bottom + 1,
    `${label} brand is outside its header`,
  );
  assert(
    state.subtitle.left >= state.copy.left - 1 &&
      state.subtitle.right <= state.copy.right + 1 &&
      state.subtitle.top >= state.title.bottom - 1 &&
      state.subtitle.bottom <= state.header.bottom + 1,
    `${label} subtitle is outside its copy/header bounds`,
  );
  assert(
    state.mark.right <= state.copy.left + 1,
    `${label} mark overlaps the brand copy`,
  );
  assert(
    state.nav.top >= state.header.bottom - 1,
    `${label} navigation overlaps the sidebar header`,
  );
  if (alignedHeaders) {
    assert(
      Math.abs(state.header.height - state.shellHeader.height) <= 1 &&
        state.shellHeader.left >= state.sidebar.right - 1,
      `${label} sidebar and global headers are not aligned`,
    );
  }
  assert(
    state.documentOverflow <= 1,
    `${label} creates ${state.documentOverflow}px document overflow`,
  );
}

for (const [engineName, engine] of engines) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
  });
  const page = await context.newPage();
  const routeMonitor = monitor(page);

  for (const route of routes) {
    try {
      await loadShell(page, route);
      for (const profile of profiles) {
        const state = await measure(page, profile);
        assert(
          state.activeProfile === profile,
          `${engineName} ${route} did not apply ${profile}`,
        );
        assertContained(state, `${engineName} ${route} ${profile}`, {
          alignedHeaders: true,
        });
        checkCount += 1;
      }
      checks.push(
        `${engineName} ${route}: full marketplace label contained in ${profiles.length} profiles`,
      );
    } catch (error) {
      failures.push(`${engineName} ${route}: ${error.message}`);
    }
  }

  if (routeMonitor.browserErrors.length) {
    failures.push(
      `${engineName} route browser errors: ${routeMonitor.browserErrors.join("; ")}`,
    );
  }
  if (routeMonitor.failedResponses.length) {
    failures.push(
      `${engineName} route failed responses: ${routeMonitor.failedResponses.join("; ")}`,
    );
  }
  await context.close();

  for (const width of breakpointWidths) {
    const boundaryContext = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const boundaryPage = await boundaryContext.newPage();
    const boundaryMonitor = monitor(boundaryPage);
    try {
      await loadShell(boundaryPage, "/");
      if (width <= 900) {
        await boundaryPage.evaluate((profile) => {
          window.dppPresentation.setProfile(profile);
        }, "weyland");
        await boundaryPage.locator(".shell-menu-button").click();
        await boundaryPage
          .locator("body.shell-drawer-open")
          .waitFor({ timeout: 5_000 });
        await boundaryPage.waitForFunction(
          () =>
            document.querySelector("#app-sidebar").getBoundingClientRect()
              .left >= -1,
          null,
          { timeout: 5_000 },
        );
        const state = await measure(boundaryPage, "weyland");
        assert(
          state.sidebar.left >= -1 && state.sidebar.right <= width + 1,
          `${engineName} ${width}px drawer is outside the viewport`,
        );
        assertContained(state, `${engineName} ${width}px drawer`, {
          alignedHeaders: false,
        });
        checkCount += 1;
      } else {
        for (const profile of profiles) {
          const state = await measure(boundaryPage, profile);
          assert(
            state.sidebar.left >= -1,
            `${engineName} ${width}px sidebar is off-canvas`,
          );
          assertContained(state, `${engineName} ${width}px ${profile}`, {
            alignedHeaders: true,
          });
          checkCount += 1;
        }
      }
      checks.push(`${engineName} ${width}px: breakpoint geometry contained`);
    } catch (error) {
      failures.push(`${engineName} ${width}px: ${error.message}`);
    }
    if (boundaryMonitor.browserErrors.length) {
      failures.push(
        `${engineName} ${width}px browser errors: ${boundaryMonitor.browserErrors.join("; ")}`,
      );
    }
    if (boundaryMonitor.failedResponses.length) {
      failures.push(
        `${engineName} ${width}px failed responses: ${boundaryMonitor.failedResponses.join("; ")}`,
      );
    }
    await boundaryContext.close();
  }

  await browser.close();
}

const summary = {
  status: failures.length ? "FAIL" : "PASS",
  checkCount,
  engines: engines.map(([name]) => name),
  viewport: { width: 1440, height: 1200 },
  profiles,
  routes,
  breakpointWidths,
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "sidebar-subtitle-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
