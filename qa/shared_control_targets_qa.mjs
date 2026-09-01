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
  "/finance",
  "/trajectory",
];
const requestedEngines = new Set(
  String(process.env.DPP_QA_ENGINES || "chromium,webkit")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const engines = [
  ["chromium", chromium, { width: 393, height: 727 }],
  ["webkit", webkit, { width: 390, height: 664 }],
].filter(([name]) => requestedEngines.has(name));
const failures = [];
const checks = [];
let checkCount = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const [engineName, engine, viewport] of engines) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
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

  for (const route of routes) {
    try {
      const response = await page.goto(`${baseUrl}${route}`, {
        waitUntil: "networkidle",
        timeout: 30_000,
      });
      assert(
        response?.ok(),
        `${engineName} ${route} returned ${response?.status()}`,
      );
      await page
        .locator(".rule-trigger:visible,.segmented-control__item:visible")
        .first()
        .waitFor({
          state: "visible",
          timeout: 10_000,
        });

      let expectedHeights = null;
      for (const profile of profiles) {
        const state = await page.evaluate(async (profileId) => {
          window.dppPresentation.setProfile(profileId);
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
          const root = document.documentElement;
          const visible = (node) => {
            const style = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              rect.width > 0 &&
              rect.height > 0
            );
          };
          const lineCount = (node) => {
            const tops = new Set();
            for (const child of node.childNodes) {
              if (
                child.nodeType !== Node.TEXT_NODE ||
                !child.textContent.trim()
              )
                continue;
              const range = document.createRange();
              range.selectNodeContents(child);
              for (const rect of range.getClientRects())
                tops.add(Math.round(rect.top));
            }
            return tops.size || 1;
          };
          const targets = [
            ...document.querySelectorAll(
              ".rule-trigger,.segmented-control__item",
            ),
          ]
            .filter(visible)
            .map((node, index) => {
              const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node);
              return {
                index,
                label: node.textContent.trim().replace(/\s+/g, " "),
                kind: node.classList.contains("rule-trigger")
                  ? "rule-trigger"
                  : "segmented-control__item",
                width: Number(rect.width.toFixed(2)),
                height: Number(rect.height.toFixed(2)),
                minHeight: Number.parseFloat(style.minHeight),
                lineCount: lineCount(node),
              };
            });
          const groupHeights = [
            ...document.querySelectorAll(".segmented-control"),
          ]
            .filter(visible)
            .map((group) =>
              [...group.querySelectorAll(".segmented-control__item")]
                .filter(visible)
                .map((item) =>
                  Number(item.getBoundingClientRect().height.toFixed(2)),
                ),
            );
          return {
            profile: root.getAttribute("data-dpp-theme"),
            token: getComputedStyle(root)
              .getPropertyValue("--dpp-control-height")
              .trim(),
            targets,
            groupHeights,
            pageOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
          };
        }, profile);

        assert(
          state.profile === profile,
          `${engineName} ${route} did not apply ${profile}`,
        );
        assert(
          state.token === "44px",
          `${engineName} ${route} ${profile} token is ${state.token}`,
        );
        assert(
          state.targets.length > 0,
          `${engineName} ${route} ${profile} has no shared targets`,
        );
        assert(
          state.targets.every(
            (target) =>
              target.minHeight >= 44 &&
              target.width >= 44 &&
              target.height >= 44,
          ),
          `${engineName} ${route} ${profile} undersized targets: ${JSON.stringify(state.targets)}`,
        );
        assert(
          state.targets.every((target) => target.lineCount === 1),
          `${engineName} ${route} ${profile} wrapped targets: ${JSON.stringify(state.targets)}`,
        );
        assert(
          state.groupHeights.every((heights) => new Set(heights).size <= 1),
          `${engineName} ${route} ${profile} has segmented height jumps: ${JSON.stringify(state.groupHeights)}`,
        );
        assert(
          state.pageOverflow === 0,
          `${engineName} ${route} ${profile} creates page overflow`,
        );

        const heights = state.targets.map(({ kind, label, height }) => ({
          kind,
          label,
          height,
        }));
        if (expectedHeights === null) {
          expectedHeights = heights;
        } else {
          assert(
            JSON.stringify(heights) === JSON.stringify(expectedHeights),
            `${engineName} ${route} ${profile} changes target heights`,
          );
        }
        checkCount += 1;
      }

      if (route === "/") {
        for (const period of ["7", "mtd", "30", "ytd"]) {
          await page.locator(`[data-period="${period}"]`).click();
          const selected = await page
            .locator(`[data-period="${period}"]`)
            .evaluate((node) => ({
              pressed: node.getAttribute("aria-pressed"),
              height: node.getBoundingClientRect().height,
              overflow: Math.max(
                0,
                document.documentElement.scrollWidth -
                  document.documentElement.clientWidth,
              ),
            }));
          assert(
            selected.pressed === "true" &&
              selected.height >= 44 &&
              selected.overflow === 0,
            `${engineName} Today ${period} selected state changed target geometry: ${JSON.stringify(selected)}`,
          );
        }
      }
      checks.push(
        `${engineName} ${route}: ${profiles.length} profiles at 44px with stable geometry`,
      );
    } catch (error) {
      failures.push(`${engineName} ${route}: ${error.message}`);
    }
  }

  if (browserErrors.length)
    failures.push(`${engineName} browser errors: ${browserErrors.join("; ")}`);
  if (failedResponses.length)
    failures.push(
      `${engineName} failed responses: ${failedResponses.join("; ")}`,
    );
  await browser.close();
}

const summary = {
  status: failures.length ? "FAIL" : "PASS",
  checkCount,
  engines: engines.map(([name]) => name),
  profiles,
  routes,
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "shared-control-targets-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
