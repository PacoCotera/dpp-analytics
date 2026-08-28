import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  timezoneId: "UTC",
  viewport: { width: 1280, height: 800 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

await page.goto(`${baseUrl}/ads`, { waitUntil: "networkidle", timeout: 20000 });
const dateCases = await page.evaluate(async () => {
  const { formatBusinessClock, formatBusinessTimestamp } = await import(
    "/assets/ui-utils.js"
  );
  return {
    browserZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    winter2021: formatBusinessClock("2021-01-15T12:00:00Z"),
    summer2021: formatBusinessClock("2021-07-15T12:00:00Z"),
    winter2026: formatBusinessClock("2026-01-15T12:00:00Z"),
    summer2026: formatBusinessClock("2026-07-15T12:00:00Z"),
    timestamp2026: formatBusinessTimestamp("2026-07-15T12:34:00Z"),
  };
});

const expectedCases = {
  browserZone: "UTC",
  winter2021: "06:00 Mexico City",
  summer2021: "07:00 Mexico City",
  winter2026: "06:00 Mexico City",
  summer2026: "06:00 Mexico City",
  timestamp2026: "Jul 15, 6:34 AM Mexico City",
};
for (const [key, expected] of Object.entries(expectedCases)) {
  if (dateCases[key] !== expected)
    errors.push(`${key}: ${dateCases[key]} != ${expected}`);
}

const routes = [
  "/",
  "/today",
  "/sales",
  "/catalog",
  "/inventory",
  "/finance",
  "/trajectory",
  "/ads",
  "/data-health",
  "/product?sku=PNC-001",
];
const clocks = [];
for (const route of routes) {
  try {
    const response = await page.goto(baseUrl + route, {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    if (!response?.ok())
      throw new Error(`navigation ${response?.status() || "failed"}`);
    const clock = ((await page.locator("#clock").textContent()) || "").trim();
    if (!clock.endsWith(" Mexico City"))
      throw new Error(`ambiguous clock ${JSON.stringify(clock)}`);
    clocks.push({ route, clock });
  } catch (error) {
    errors.push(`${route}: ${error.message}`);
  }
}

await page.goto(`${baseUrl}/data-health`, {
  waitUntil: "networkidle",
  timeout: 20000,
});
const health = await page.evaluate(async () => {
  const payload = await fetch("/api/data-health?refresh=timezone-qa").then(
    (response) => response.json(),
  );
  const { formatBusinessTimestamp } = await import("/assets/ui-utils.js");
  return {
    checkedAt: payload.checked_at,
    expected: `Health checked ${formatBusinessTimestamp(payload.checked_at)} · refreshes every 60s`,
    rendered: document.querySelector("#healthUpdated")?.textContent,
  };
});
if (health.rendered !== health.expected) {
  errors.push(
    `Data Health absolute timestamp: ${health.rendered} != ${health.expected}`,
  );
}

const summary = {
  baseUrl,
  dateCases,
  clocks,
  health,
  errors,
  ok: errors.length === 0,
};
await fs.writeFile(
  path.join(outDir, "timezone-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ timezoneQA: summary }, null, 2));
await browser.close();
if (errors.length) process.exitCode = 7;
