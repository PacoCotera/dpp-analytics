import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
const checks = [];
const failures = [];

function check(name, condition, detail) {
  checks.push(name);
  if (!condition) failures.push(`${name}: ${detail}`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));
page.on("console", (message) => {
  if (message.type() === "error") failures.push(`console: ${message.text()}`);
});

try {
  await page.goto(`${baseUrl}/business`, { waitUntil: "networkidle", timeout: 20000 });
  const shared = await page.evaluate(async () => {
    const formats = await import(`/assets/format-core.js?qa=${Date.now()}`);
    return {
      counts: [0, 1, 2].map((value) => formats.formatCount(value, "order")),
      positive: formats.money(884),
      negative: formats.money(-884),
      month: formats.formatMonthYear("2026-08-01"),
    };
  });
  check(
    "Shared pluralization handles zero, singular, and plural",
    JSON.stringify(shared.counts) ===
      JSON.stringify(["0 orders", "1 order", "2 orders"]),
    JSON.stringify(shared.counts),
  );
  check(
    "Shared currency places the sign before the symbol",
    shared.positive === "$884" && shared.negative === "−$884",
    `${shared.positive} / ${shared.negative}`,
  );
  check(
    "Shared month-year label uses a four-digit year",
    shared.month === "Aug 2026",
    shared.month,
  );

  const businessFinance = (
    await page
      .locator('.business-health-card[href="/finance"] strong')
      .first()
      .textContent()
  )?.trim();
  check(
    "Business uses canonical negative currency",
    !String(businessFinance).includes("$-") &&
      /^−\$/.test(String(businessFinance)),
    businessFinance || "missing",
  );

  await page.goto(`${baseUrl}/finance`, {
    waitUntil: "networkidle",
    timeout: 20000,
  });
  const monthLabels = await page
    .locator('#history tbody th[scope="row"]')
    .evaluateAll((nodes) =>
      nodes
        .map((node) => node.childNodes[0]?.textContent?.trim() || "")
        .filter(Boolean),
    );
  check(
    "Finance report months are unambiguous month-year labels",
    monthLabels.length > 0 &&
      monthLabels.every((label) => /^[A-Z][a-z]{2} \d{4}$/.test(label)),
    JSON.stringify(monthLabels),
  );

  await page.goto(`${baseUrl}/data-health`, {
    waitUntil: "networkidle",
    timeout: 20000,
  });
  const resultHeader = (
    await page.locator(".health-job--header > div").last().textContent()
  )?.trim();
  check(
    "Data Health result column names its row operands",
    resultHeader === "Rows read / stored",
    resultHeader || "missing",
  );
} catch (error) {
  failures.push(error.message);
}

await browser.close();
const summary = { status: failures.length ? "FAIL" : "PASS", checks, failures };
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(
  path.join(outDir, "ui-format-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
