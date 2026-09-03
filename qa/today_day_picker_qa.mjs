import fs from "node:fs/promises";
import path from "node:path";

import { chromium, webkit } from "playwright";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
await fs.mkdir(outDir, { recursive: true });

const failures = [];
const checks = [];
const requestedEngines = new Set(
  String(process.env.DPP_QA_ENGINES || "chromium,webkit")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const engines = [
  ["chromium", chromium, { width: 393, height: 727 }],
  ["chromium-tablet", chromium, { width: 1024, height: 768 }],
  ["webkit", webkit, { width: 390, height: 664 }],
].filter(([name]) => requestedEngines.has(name.split("-")[0]));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expectedTitle(date, live) {
  if (live) return "Today";
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
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

  try {
    await page.goto(`${baseUrl}/`, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    await page.locator("#dayPicker .day-choice").first().waitFor();
    const dates = await page
      .locator("#dayPicker .day-choice")
      .evaluateAll((buttons) => buttons.map((button) => button.dataset.date));
    assert(
      dates.length === 8,
      `${engineName} rendered ${dates.length} day choices`,
    );
    const localToday = dates[0];

    for (const date of dates) {
      await page.locator(`#dayPicker .day-choice[data-date="${date}"]`).click();
      await page
        .locator(
          `#dayPicker .day-choice[data-date="${date}"][aria-pressed="true"]`,
        )
        .waitFor({ timeout: 10_000 });
      const state = await page.evaluate(() => {
        const picker = document.getElementById("dayPicker");
        const choices = [...picker.querySelectorAll(".day-choice")];
        const active = picker.querySelector('.day-choice[aria-pressed="true"]');
        const pickerRect = picker.getBoundingClientRect();
        const activeRect = active.getBoundingClientRect();
        return {
          activeDate: active.dataset.date,
          pressedCount: choices.filter(
            (choice) => choice.getAttribute("aria-pressed") === "true",
          ).length,
          widths: choices.map((choice) => choice.getBoundingClientRect().width),
          heights: choices.map(
            (choice) => choice.getBoundingClientRect().height,
          ),
          activeVisible:
            activeRect.left >= pickerRect.left - 1 &&
            activeRect.right <= pickerRect.right + 1,
          overflowX: getComputedStyle(picker).overflowX,
          scrollRange: picker.scrollWidth - picker.clientWidth,
          urlDate: new URL(location.href).searchParams.get("date"),
          title: document.getElementById("todayTitle")?.textContent?.trim(),
          dayState: document
            .getElementById("todayDayState")
            ?.textContent?.trim(),
          pageOverflow:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        };
      });
      const api = await page.evaluate(
        async (selectedDate) => {
          const query = selectedDate
            ? `?date=${encodeURIComponent(selectedDate)}`
            : "";
          return (
            await fetch(`/api/today${query}`, { cache: "no-store" })
          ).json();
        },
        date === localToday ? "" : date,
      );
      const live = date === localToday;
      assert(
        (api.selected_date || api.local_today) === date,
        `${engineName} API selected ${api.selected_date || api.local_today} instead of ${date}`,
      );
      assert(
        Boolean(api.is_live) === live,
        `${engineName} ${date} live state disagrees with the API`,
      );
      assert(
        state.activeDate === date && state.pressedCount === 1,
        `${engineName} ${date} selected state is not singular`,
      );
      assert(
        Math.min(...state.widths) >= 44 && Math.min(...state.heights) >= 44,
        `${engineName} ${date} target is below 44px: ${Math.min(...state.widths)}×${Math.min(...state.heights)}`,
      );
      if (viewport.width <= 640) {
        assert(
          state.overflowX === "auto" && state.scrollRange > 0,
          `${engineName} picker is not a contained scroll region: ${JSON.stringify(state)}`,
        );
      } else {
        assert(
          state.scrollRange === 0,
          `${engineName} picker unexpectedly scrolls: ${JSON.stringify(state)}`,
        );
      }
      assert(
        state.activeVisible,
        `${engineName} ${date} is selected outside the visible picker`,
      );
      assert(
        state.urlDate === (live ? null : date),
        `${engineName} ${date} URL state is ${state.urlDate}`,
      );
      assert(
        state.title === expectedTitle(date, live) &&
          state.dayState ===
            (live ? "Live operating day" : "Closed operating day"),
        `${engineName} ${date} visible state disagrees with the API`,
      );
      assert(
        state.pageOverflow === 0,
        `${engineName} ${date} creates page overflow`,
      );
    }
    assert(
      !browserErrors.length,
      `${engineName} browser errors: ${browserErrors.join("; ")}`,
    );
    assert(
      !failedResponses.length,
      `${engineName} failed responses: ${failedResponses.join("; ")}`,
    );
    checks.push(
      `${engineName}: all eight dates reachable, API-synchronized, visible, and at least 44×44`,
    );
  } catch (error) {
    failures.push(`${engineName}: ${error.message}`);
  } finally {
    await browser.close();
  }
}

const summary = {
  status: failures.length ? "FAIL" : "PASS",
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "today-day-picker-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
