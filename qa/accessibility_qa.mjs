import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const routes = [
  { name: "business", url: "/" },
  { name: "today", url: "/today" },
  { name: "sales", url: "/sales" },
  { name: "catalog", url: "/catalog" },
  { name: "product", url: "/product?sku=PNC-001" },
  { name: "inventory", url: "/inventory" },
  { name: "ads", url: "/ads" },
  { name: "finance", url: "/finance" },
  { name: "trajectory", url: "/trajectory" },
  { name: "data-health", url: "/data-health" },
  { name: "admin", url: "/admin" },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertPressedGroup(page, selector) {
  const states = await page
    .locator(selector)
    .evaluateAll((items) =>
      items.map((item) => item.getAttribute("aria-pressed")),
    );
  assert(states.length > 1, `${selector} has fewer than two choices`);
  assert(
    states.every((state) => state === "true" || state === "false"),
    `${selector} is missing aria-pressed: ${states}`,
  );
  assert(
    states.filter((state) => state === "true").length === 1,
    `${selector} must have exactly one pressed choice: ${states}`,
  );
}

async function activateAndAssertPressed(page, selector, key) {
  const target = page.locator(selector);
  await target.focus();
  await page.keyboard.press(key);
  await target.waitFor({ state: "attached" });
  await page.waitForFunction(
    (query) =>
      document.querySelector(query)?.getAttribute("aria-pressed") === "true",
    selector,
  );
}

const browser = await chromium.launch({ headless: true });
const results = [];

for (const route of routes) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });

  try {
    let financeChartFocus = null;
    const response = await page.goto(`${baseUrl}${route.url}`, {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    assert(
      response?.ok(),
      `${route.name} navigation returned ${response?.status()}`,
    );
    await page
      .locator(".primary-nav.app-navigation")
      .waitFor({ timeout: 5000 });
    if (route.name === "product")
      await page
        .locator('.hero-name:not(:has-text("One moment"))')
        .waitFor({ timeout: 10000 });

    const headings = await page.locator("h1").allTextContents();
    assert(
      headings.length === 1,
      `${route.name} has ${headings.length} H1 elements: ${JSON.stringify(headings)}`,
    );
    assert(headings[0].trim().length > 0, `${route.name} H1 is empty`);

    const unnamedLinks = await page.locator("a[href]").evaluateAll((links) =>
      links
        .filter(
          (link) =>
            link.getClientRects().length > 0 &&
            link.getAttribute("aria-hidden") !== "true",
        )
        .filter((link) => {
          const name = [
            link.getAttribute("aria-label"),
            link.textContent,
            link.getAttribute("title"),
            ...Array.from(link.querySelectorAll("img[alt]")).map((image) =>
              image.getAttribute("alt"),
            ),
          ]
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          return !name;
        })
        .map((link) => link.outerHTML.slice(0, 240)),
    );
    assert(
      unnamedLinks.length === 0,
      `${route.name} has unnamed visible links: ${JSON.stringify(unnamedLinks)}`,
    );

    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    });
    await page.keyboard.press("Tab");
    const keyboardTarget = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      return {
        tag: element.tagName,
        role: element.getAttribute("role"),
        name: (
          element.getAttribute("aria-label") ||
          element.textContent ||
          element.getAttribute("title") ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim(),
        visible: element.getClientRects().length > 0,
      };
    });
    assert(
      keyboardTarget?.visible,
      `${route.name} first keyboard target is not visible: ${JSON.stringify(keyboardTarget)}`,
    );
    assert(
      ["A", "BUTTON", "INPUT", "SELECT", "SUMMARY"].includes(
        keyboardTarget.tag,
      ) || keyboardTarget.role,
      `${route.name} first keyboard target is not interactive: ${JSON.stringify(keyboardTarget)}`,
    );
    assert(
      keyboardTarget.name,
      `${route.name} first keyboard target has no accessible name`,
    );

    const reducedMotion = await page
      .locator(".primary-nav a")
      .first()
      .evaluate((element) => {
        const style = getComputedStyle(element);
        const seconds = (value) =>
          value
            .split(",")
            .map((part) => Number.parseFloat(part) || 0)
            .map((duration, index) =>
              value.split(",")[index]?.trim().endsWith("ms")
                ? duration / 1000
                : duration,
            );
        return {
          transitionDuration: style.transitionDuration,
          animationDuration: style.animationDuration,
          transitionSeconds: seconds(style.transitionDuration),
          animationSeconds: seconds(style.animationDuration),
        };
      });
    assert(
      [
        ...reducedMotion.transitionSeconds,
        ...reducedMotion.animationSeconds,
      ].every((duration) => duration <= 0.001),
      `${route.name} does not suppress motion: ${JSON.stringify(reducedMotion)}`,
    );

    const visibleSummaries = page.locator("summary:visible");
    const summaryFocus = [];
    if ((await visibleSummaries.count()) > 0) {
      const summary = visibleSummaries.first();
      await summary.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      summaryFocus.push(
        await summary.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 80),
            active: document.activeElement === element,
            focusVisible: element.matches(":focus-visible"),
            outlineStyle: style.outlineStyle,
            outlineWidth: Number.parseFloat(style.outlineWidth) || 0,
            boxShadow: style.boxShadow,
          };
        }),
      );
    }
    assert(
      summaryFocus.every(
        (focus) =>
          focus.active &&
          focus.focusVisible &&
          ((focus.outlineStyle !== "none" && focus.outlineWidth >= 2) ||
            focus.boxShadow !== "none"),
      ),
      `${route.name} has a disclosure without a visible focus indicator: ${JSON.stringify(summaryFocus)}`,
    );

    if (route.name === "today") {
      await assertPressedGroup(page, "[data-period]");
      await activateAndAssertPressed(page, '[data-period="7"]', "Enter");
      await assertPressedGroup(page, "[data-period]");
      await page.locator("[data-date]").first().waitFor({ timeout: 10000 });
      await assertPressedGroup(page, "[data-date]");
      const secondDate = await page
        .locator("[data-date]")
        .nth(1)
        .getAttribute("data-date");
      await activateAndAssertPressed(
        page,
        `[data-date="${secondDate}"]`,
        "Space",
      );
      await assertPressedGroup(page, "[data-date]");
    }

    if (route.name === "catalog") {
      await page.locator('[data-mode="family"]').waitFor({ timeout: 10000 });
      await assertPressedGroup(page, "[data-mode]");
      await assertPressedGroup(page, "[data-filter]");
      await activateAndAssertPressed(
        page,
        '[data-filter="attention"]',
        "Space",
      );
      await assertPressedGroup(page, "[data-filter]");
      await activateAndAssertPressed(page, '[data-mode="sku"]', "Enter");
      await assertPressedGroup(page, "[data-mode]");
    }

    if (route.name === "product") {
      await assertPressedGroup(page, "[data-metric]");
      await assertPressedGroup(page, "[data-days]");
      await activateAndAssertPressed(page, '[data-metric="units"]', "Enter");
      await activateAndAssertPressed(page, '[data-days="90"]', "Space");
      await assertPressedGroup(page, "[data-metric]");
      await assertPressedGroup(page, "[data-days]");
    }

    if (route.name === "inventory") {
      await assertPressedGroup(page, "[data-filter]");
      await activateAndAssertPressed(
        page,
        '[data-filter="attention"]',
        "Enter",
      );
      await assertPressedGroup(page, "[data-filter]");
    }

    if (route.name === "finance") {
      await page
        .locator("#history tbody tr")
        .first()
        .waitFor({ timeout: 10000 });
      const table = await page.locator("table#history").evaluate((element) => ({
        caption: element.querySelector("caption")?.textContent?.trim(),
        columns: element.querySelectorAll('thead th[scope="col"]').length,
        rows: element.querySelectorAll("tbody tr").length,
        rowHeaders: element.querySelectorAll('tbody th[scope="row"]').length,
      }));
      assert(
        table.caption === "Immutable monthly Finance report",
        `Finance table caption is ${table.caption}`,
      );
      assert(
        table.columns === 8,
        `Finance table has ${table.columns} column headers`,
      );
      assert(
        table.rows > 0 && table.rows === table.rowHeaders,
        `Finance row headers do not match rows: ${JSON.stringify(table)}`,
      );
      const financeChartTarget = page
        .locator(".finance-chart-month-hit")
        .first();
      await financeChartTarget.focus();
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Tab");
      financeChartFocus = await financeChartTarget.evaluate((target) => {
        target.focus();
        const bar = target.querySelector(".finance-chart-bar");
        const style = bar ? getComputedStyle(bar) : null;
        return {
          active: document.activeElement === target,
          focusVisible: target.matches(":focus-visible"),
          strokeWidth: Number.parseFloat(style?.strokeWidth || "0"),
        };
      });
      assert(
        financeChartFocus.active &&
          financeChartFocus.focusVisible &&
          financeChartFocus.strokeWidth >= 3,
        `Finance chart focus indicator is incomplete: ${JSON.stringify(financeChartFocus)}`,
      );
    }

    assert(
      browserErrors.length === 0,
      `${route.name} browser errors: ${JSON.stringify(browserErrors)}`,
    );
    results.push({
      name: route.name,
      ok: true,
      h1: headings[0].trim(),
      keyboardTarget,
      reducedMotion,
      summaryFocus,
      financeChartFocus,
    });
  } catch (error) {
    results.push({
      name: route.name,
      ok: false,
      error: error.message,
      browserErrors,
    });
  }
  await context.close();
}

await browser.close();
const summary = {
  baseUrl,
  status: results.every((result) => result.ok) ? "PASS" : "FAIL",
  results,
};
await fs.writeFile(
  path.join(outDir, "accessibility-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (summary.status !== "PASS") process.exitCode = 3;
