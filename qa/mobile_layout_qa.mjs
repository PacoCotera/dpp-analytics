import { chromium, webkit } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
const requestedEngine = process.argv[4] || "";
await fs.mkdir(outDir, { recursive: true });

const profiles = [
  "warm-studio",
  "midnight-saffron",
  "aubergine-aqua",
  "midnight-dark",
  "aubergine-dark",
  "weyland",
];
const errors = [];
const checks = [];

function record(condition, message) {
  checks.push({ message, ok: Boolean(condition) });
  if (!condition) errors.push(message);
}

function boxesOverlap(a, b, gap = 0) {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

const engines = [
  ["chromium", chromium],
  ["webkit", webkit],
].filter(([engineName]) => !requestedEngine || engineName === requestedEngine);

for (const [engineName, engine] of engines) {
  for (const viewport of [
    { width: 360, height: 800 },
    { width: 412, height: 915 },
  ]) {
    const browser = await engine.launch({ headless: true });
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const prefix = `${engineName}-${viewport.width}`;
    page.on("pageerror", (error) => errors.push(`${prefix}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error")
        errors.push(`${prefix}: ${message.text()}`);
    });

    await page.goto(
      `${baseUrl}/finance?window=month&month=2026-08&cogs=excluded`,
      {
        waitUntil: "networkidle",
      },
    );
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#progression .finance-chart-value").length >=
        5,
    );
    for (const profile of profiles) {
      await page.evaluate(
        (id) => window.dppPresentation.setProfile(id, { persist: false }),
        profile,
      );
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      const state = await page.locator("#progression").evaluate((svg) => {
        const boxes = [...svg.querySelectorAll(".finance-chart-value")].map(
          (label) => {
            const box = label.getBBox();
            return {
              text: label.textContent.trim(),
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
            };
          },
        );
        const gridTop = Math.min(
          ...[...svg.querySelectorAll(".finance-chart-grid, .dpp-zero")].map(
            (line) => Number(line.getAttribute("y1")),
          ),
        );
        return {
          boxes,
          gridTop,
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });
      record(
        state.boxes.every((box) => box.y + box.height <= state.gridTop - 6),
        `${prefix}/finance/${profile}: value labels clear the plot (${JSON.stringify(state)})`,
      );
      record(
        state.boxes.every((box, index) =>
          state.boxes
            .slice(index + 1)
            .every((other) => !boxesOverlap(box, other, 2)),
        ),
        `${prefix}/finance/${profile}: value labels do not overlap each other`,
      );
      record(
        state.boxes.length >= 5 &&
          state.boxes.some((box) => box.text.startsWith("+")) &&
          state.boxes.some((box) => box.text.startsWith("−")),
        `${prefix}/finance/${profile}: signed August annotations are present (${state.boxes.map((box) => box.text).join(", ")})`,
      );
      record(
        state.documentOverflow === 0,
        `${prefix}/finance/${profile}: document overflow is zero`,
      );
      if (
        viewport.width === 360 &&
        ["warm-studio", "weyland"].includes(profile)
      ) {
        await page.locator("#progression").screenshot({
          path: path.join(outDir, `${prefix}-finance-${profile}.png`),
        });
      }
    }

    await page.goto(`${baseUrl}/data-health`, { waitUntil: "networkidle" });
    await page.locator("#toggle").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#jobs .health-job").length > 1,
    );
    for (const profile of profiles) {
      await page.evaluate(
        (id) => window.dppPresentation.setProfile(id, { persist: false }),
        profile,
      );
      const state = await page.evaluate(() => {
        const header = document.querySelector(".health-job--header");
        const rows = [...document.querySelectorAll("#jobs .health-job")];
        return {
          headerDisplay: getComputedStyle(header).display,
          rows: rows.map((row) => {
            const rowRect = row.getBoundingClientRect();
            const identityRect = row
              .querySelector(".health-job__identity")
              .getBoundingClientRect();
            return {
              leftGutter: identityRect.left - rowRect.left,
              rightGutter:
                rowRect.right -
                Math.max(
                  ...[...row.children].map(
                    (child) => child.getBoundingClientRect().right,
                  ),
                ),
              paddingLeft: getComputedStyle(row).paddingLeft,
              paddingRight: getComputedStyle(row).paddingRight,
            };
          }),
          documentOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });
      record(
        state.headerDisplay === "none",
        `${prefix}/data-health/${profile}: desktop header is removed from mobile layout`,
      );
      record(
        state.rows.every(
          (row) =>
            row.leftGutter >= 11 &&
            row.rightGutter >= 11 &&
            Number.parseFloat(row.paddingLeft) >= 11 &&
            Number.parseFloat(row.paddingRight) >= 11,
        ),
        `${prefix}/data-health/${profile}: job rows preserve both inner gutters (${JSON.stringify(state.rows)})`,
      );
      record(
        state.documentOverflow === 0,
        `${prefix}/data-health/${profile}: document overflow is zero`,
      );
      if (
        viewport.width === 360 &&
        ["warm-studio", "weyland"].includes(profile)
      ) {
        await page.locator("[data-dpp-qa='data-health-pipeline']").screenshot({
          path: path.join(outDir, `${prefix}-data-health-${profile}.png`),
        });
      }
    }

    await browser.close();
  }
}

const summary = {
  baseUrl,
  checks: checks.length,
  errors,
  ok: errors.length === 0,
};
await fs.writeFile(
  path.join(outDir, "mobile-layout-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ mobileLayoutQA: summary }, null, 2));
if (errors.length) process.exitCode = 14;
