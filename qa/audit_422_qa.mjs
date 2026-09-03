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
const failures = [];
const checks = [];

function record(condition, message, evidence) {
  checks.push({ message, ok: Boolean(condition), evidence });
  if (!condition) failures.push(`${message}: ${JSON.stringify(evidence)}`);
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
}

async function open(page, route, readySelector) {
  const response = await page.goto(`${baseUrl}${route}`, {
    waitUntil: "networkidle",
    timeout: 30_000,
  });
  if (!response?.ok())
    throw new Error(`${route} returned ${response?.status()}`);
  if (readySelector) {
    await page.locator(readySelector).first().waitFor({
      state: "visible",
      timeout: 15_000,
    });
  }
  await settle(page);
}

async function applyProfile(page, profile) {
  await page.evaluate(
    (id) => window.dppPresentation.setProfile(id, { persist: false }),
    profile,
  );
  await settle(page);
}

const engines = [
  ["chromium", chromium],
  ["webkit", webkit],
];

for (const [engineName, engine] of engines) {
  for (const scenario of [
    { name: "desktop", viewport: { width: 1440, height: 900 } },
    {
      name: "mobile",
      viewport: { width: engineName === "chromium" ? 360 : 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    },
  ]) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({
      viewport: scenario.viewport,
      isMobile: scenario.isMobile || false,
      hasTouch: scenario.hasTouch || false,
    });
    const page = await context.newPage();
    const prefix = `${engineName}-${scenario.name}-${scenario.viewport.width}`;
    page.on("pageerror", (error) =>
      failures.push(`${prefix}: ${error.message}`),
    );
    page.on("console", (message) => {
      if (
        message.type() === "error" &&
        !message.text().startsWith("Failed to load resource:")
      ) {
        failures.push(`${prefix}: ${message.text()}`);
      }
    });

    try {
      await open(page, "/ads?view=products", "#productRows tr");
      for (const profile of profiles) {
        await applyProfile(page, profile);
        const state = await page.evaluate(() => {
          const table = document.querySelector(
            ".ads-product-table .data-table",
          );
          const scroller = document.querySelector(
            ".ads-product-table .data-table-scroll",
          );
          const firstRow = document.querySelector("#productRows tr");
          const disclosure = firstRow?.querySelector(
            "[data-record-disclosure]",
          );
          const secondary = [
            ...(firstRow?.querySelectorAll("[data-record-secondary]") || []),
          ];
          const visible = (node) =>
            Boolean(
              node &&
                node.getClientRects().length &&
                getComputedStyle(node).display !== "none",
            );
          return {
            viewport: innerWidth,
            documentOverflow:
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
            tableWidth: table?.getBoundingClientRect().width,
            scrollerWidth: scroller?.clientWidth,
            scrollerOverflow:
              (scroller?.scrollWidth || 0) - (scroller?.clientWidth || 0),
            rowHeight: firstRow?.getBoundingClientRect().height,
            disclosureVisible: visible(disclosure),
            disclosureTarget: disclosure
              ?.querySelector("summary")
              ?.getBoundingClientRect().height,
            visibleSecondary: secondary.filter(visible).length,
            headerCount: table?.querySelectorAll("thead th").length,
            cellCount: firstRow?.children.length,
          };
        });
        record(
          state.documentOverflow <= 1,
          `${prefix}/${profile}: Advertising does not overflow the document`,
          state,
        );
        if (scenario.name === "mobile") {
          record(
            state.scrollerOverflow <= 1 &&
              state.tableWidth <= state.scrollerWidth + 1,
            `${prefix}/${profile}: product records fit their mobile scroller`,
            state,
          );
          record(
            state.disclosureVisible &&
              state.disclosureTarget >= 44 &&
              state.visibleSecondary === 0 &&
              state.rowHeight < 720,
            `${prefix}/${profile}: product evidence is prioritized and disclosed`,
            state,
          );
        } else {
          record(
            state.scrollerOverflow > 0 && state.headerCount === state.cellCount,
            `${prefix}/${profile}: desktop product table remains aligned and bounded`,
            state,
          );
        }
      }
      await page.locator(".ads-product-table").screenshot({
        path: path.join(outDir, `${prefix}-ads-products.png`),
      });

      await open(page, "/sales?view=geography", "#geoRankedRows tr");
      for (const profile of profiles) {
        await applyProfile(page, profile);
        const state = await page.evaluate(() => ({
          rows: document.querySelectorAll("#geoRankedRows tr").length,
          rowHeaders: document.querySelectorAll(
            '#geoRankedRows th[scope="row"]',
          ).length,
          sortTargets: [
            ...document.querySelectorAll("[data-geo-sort] button"),
          ].map((node) => {
            const rect = node.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          }),
          rowTargets: [
            ...document.querySelectorAll('#geoRankedRows tr[role="button"]'),
          ].map((node) => {
            const rect = node.getBoundingClientRect();
            return { width: rect.width, height: rect.height };
          }),
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        }));
        record(
          state.documentOverflow <= 1 && state.rowHeaders === state.rows,
          `${prefix}/${profile}: Geography records are semantic and contained`,
          state,
        );
        record(
          scenario.name !== "mobile" || state.rows <= 6,
          `${prefix}/${profile}: Geography defaults to a concise mobile ranking`,
          state,
        );
        record(
          state.sortTargets.every(
            ({ width, height }) => width >= 44 && height >= 44,
          ) &&
            state.rowTargets.every(
              ({ width, height }) => width >= 44 && height >= 44,
            ),
          `${prefix}/${profile}: Geography interactive targets meet the control contract`,
          state,
        );
      }
      await page.locator(".geo-ranked-panel").screenshot({
        path: path.join(outDir, `${prefix}-sales-geography.png`),
      });

      await open(page, "/catalog?mode=deleted", "#portfolio .analysis-row");
      for (const profile of profiles) {
        await applyProfile(page, profile);
        const catalog = await page.evaluate(() => {
          const targets = [
            ...document.querySelectorAll(
              "#portfolio a.analysis-link, #portfolio a.analysis-open",
            ),
          ].map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              label:
                node.getAttribute("aria-label") ||
                node.textContent.trim().slice(0, 80),
              width: rect.width,
              height: rect.height,
            };
          });
          return {
            targets,
            documentOverflow:
              document.documentElement.scrollWidth -
              document.documentElement.clientWidth,
          };
        });
        record(
          catalog.targets.length > 0 &&
            catalog.targets.every(
              (target) => target.width >= 44 && target.height >= 44,
            ) &&
            catalog.documentOverflow <= 1,
          `${prefix}/${profile}: Catalog product links meet the touch-target contract`,
          catalog,
        );
      }

      await open(page, "/inventory", "#rows tr");
      const inventory = await page.evaluate(() => {
        const scroller = document.querySelector(
          ".inventory-shell .data-table-scroll",
        );
        const headers = [
          ...document.querySelectorAll(".inventory-table thead th"),
        ].map((node) => ({
          label: node.textContent.trim(),
          clientWidth: node.clientWidth,
          scrollWidth: node.scrollWidth,
        }));
        const paidTargets = [
          ...document.querySelectorAll(".inventory-paid-support"),
        ]
          .filter((node) => node.tagName === "A")
          .map((node) => node.getBoundingClientRect().height);
        return {
          headers,
          paidTargets,
          hintVisible: Boolean(
            document.querySelector(".inventory-table-hint")?.getClientRects()
              .length,
          ),
          internalOverflow:
            (scroller?.scrollWidth || 0) - (scroller?.clientWidth || 0),
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });
      record(
        inventory.documentOverflow <= 1 &&
          inventory.headers.every(
            (header) => header.scrollWidth <= header.clientWidth + 1,
          ),
        `${prefix}: Inventory headers remain readable without document overflow`,
        inventory,
      );
      record(
        inventory.hintVisible &&
          inventory.paidTargets.every((height) => height >= 44) &&
          (scenario.name !== "mobile" || inventory.internalOverflow > 0),
        `${prefix}: Inventory uses a disclosed bounded table and full-size actions`,
        inventory,
      );

      await open(page, "/trajectory", "#paidContext");
      const trajectory = await page.evaluate(async () => {
        const payload = await fetch("/api/trajectory").then((response) =>
          response.json(),
        );
        const asset = document.querySelector(
          'meta[name="dpp-asset-revision"]',
        )?.content;
        const { percent } = await import(
          `/assets/ui-utils.js${asset ? `?v=${asset}` : ""}`
        );
        const metrics = Object.fromEntries(
          [...document.querySelectorAll("#paidMetrics > div")].map((node) => [
            node.querySelector("span")?.textContent.trim(),
            node.querySelector("strong")?.textContent.trim(),
          ]),
        );
        return {
          ready:
            payload.ads?.status === "ready" &&
            Number(payload.ads?.spend || 0) > 0,
          actual: { ACOS: metrics.ACOS, TACOS: metrics.TACOS },
          expected: {
            ACOS: percent(payload.ads?.acos, { scale: 100, sign: false }),
            TACOS: percent(payload.ads?.tacos, { scale: 100, sign: false }),
          },
        };
      });
      record(
        !trajectory.ready ||
          JSON.stringify(trajectory.actual) ===
            JSON.stringify(trajectory.expected),
        `${prefix}: Trajectory ratios match the server-owned Ads contract`,
        trajectory,
      );

      await open(page, "/admin", "#loginPanel");
      const controls = await page.evaluate(() => ({
        appearance: document
          .querySelector(".appearance-trigger")
          ?.getBoundingClientRect().height,
        password: document.querySelector("#password")?.getBoundingClientRect()
          .height,
        signIn: document
          .querySelector('#loginForm button[type="submit"]')
          ?.getBoundingClientRect().height,
        h1Count: document.querySelectorAll("main h1").length,
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      }));
      record(
        controls.appearance >= 44 &&
          controls.password >= 44 &&
          controls.signIn >= 44 &&
          controls.h1Count === 1 &&
          controls.documentOverflow <= 1,
        `${prefix}: Admin and global appearance controls meet the shared contract`,
        controls,
      );
    } catch (error) {
      failures.push(`${prefix}: ${error.message}`);
    } finally {
      await context.close();
      await browser.close();
    }
  }
}

const summary = {
  status: failures.length ? "FAIL" : "PASS",
  checks: checks.length,
  profiles,
  failures,
  results: checks,
};
await fs.writeFile(
  path.join(outDir, "audit-422-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 22;
