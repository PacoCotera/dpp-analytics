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
  ["chromium", chromium, { width: 1440, height: 1000 }],
  ["webkit", webkit, { width: 390, height: 844 }],
].filter(([name]) => requestedEngines.has(name));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function baseJob() {
  return {
    job_name: "orders_v2026",
    label: "Orders",
    operation: "Amazon SP-API · Orders v2026-01-01",
    source: "Amazon SP-API",
    purpose: "Powers Today sales, recent orders and fulfillment status.",
    domain: "Today",
    latest_status: "success",
    latest_attempt_status: "success",
    is_stale: false,
    age_seconds: 180,
    attempt_age_seconds: 180,
    expected_interval_seconds: 300,
    stale_after_seconds: 900,
    next_due_in_seconds: 120,
    overdue_by_seconds: 0,
    records_read: 8,
    records_written: 8,
    last_success_at: "2026-09-01T09:57:00Z",
    last_started_at: "2026-09-01T09:57:00Z",
    error_message: null,
  };
}

function healthPayload(manualSync) {
  return {
    local_time: "2026-09-01T04:00:00-06:00",
    checked_at: "2026-09-01T10:00:00Z",
    warehouse: {
      orders: 80,
      financial_transactions: 40,
      seller_listings: 12,
      inventory_snapshots: 20,
    },
    health_contract: {
      overall: { state: "healthy", active_condition_count: 0 },
      domains: [{ label: "Today", critical: true, state: "healthy" }],
    },
    catalog: { summary: {} },
    jobs: [{ ...baseJob(), ...(manualSync || {}) }],
  };
}

function lifecycle(
  status,
  { canRequest = false, cooldown = 900, error = null } = {},
) {
  return {
    manual_sync_request_id: 71,
    manual_sync_status: status,
    manual_sync_requested_at: "2026-09-01T10:00:00Z",
    manual_sync_started_at:
      status === "pending" ? null : "2026-09-01T10:00:02Z",
    manual_sync_finished_at: ["success", "error"].includes(status)
      ? "2026-09-01T10:00:08Z"
      : null,
    manual_sync_error_message: error,
    manual_sync_can_request: canRequest,
    manual_sync_cooldown_seconds: cooldown,
  };
}

async function syncState(page) {
  return page.evaluate(() => {
    const button = document.querySelector('[data-job="orders_v2026"]');
    const detail = button?.getAttribute("aria-describedby");
    return {
      button: button?.textContent?.trim(),
      disabled: button?.disabled,
      status: button?.dataset.syncStatus,
      detail: detail
        ? document.getElementById(detail)?.textContent?.trim()
        : "",
      announcement: document
        .getElementById("manualSyncStatus")
        ?.textContent?.trim(),
      expanded: document
        .getElementById("toggle")
        ?.getAttribute("aria-expanded"),
      overflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    };
  });
}

for (const [engineName, engine, viewport] of engines) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);
    const nativeSetInterval = window.setInterval.bind(window);
    let manualTimer = null;
    window.setTimeout = (callback, delay, ...args) => {
      if (delay === 2500 || delay === 5000) {
        manualTimer = () => {
          const pending = manualTimer;
          manualTimer = null;
          pending && callback(...args);
        };
        window.__dppManualSyncPoll = () => manualTimer?.();
        return 900001;
      }
      return nativeSetTimeout(callback, delay, ...args);
    };
    window.clearTimeout = (timer) => {
      if (timer === 900001) manualTimer = null;
      else nativeClearTimeout(timer);
    };
    window.setInterval = (callback, delay, ...args) => {
      if (delay === 60_000) {
        window.__dppDataHealthRefresh = () => callback(...args);
        return 60_000;
      }
      return nativeSetInterval(callback, delay, ...args);
    };
  });
  const page = await context.newPage();
  const browserErrors = [];
  const manualSyncStatuses = [];
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
    if (new URL(response.url()).pathname === "/api/manual-sync") {
      manualSyncStatuses.push(response.status());
    }
  });

  let manualSync = null;
  let postMode = "accept";
  let postCount = 0;
  await page.route("**/api/data-health*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(healthPayload(manualSync)),
    }),
  );
  await page.route("**/api/manual-sync", (route) => {
    postCount += 1;
    if (postMode === "error") {
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Fixture queue unavailable" }),
      });
      return;
    }
    if (postMode === "cooldown") {
      route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          accepted: false,
          reason: "in_progress",
          id: 71,
          status: "running",
          requested_at: "2026-09-01T10:00:00Z",
          started_at: "2026-09-01T10:00:02Z",
          retry_after_seconds: 780,
        }),
      });
      return;
    }
    manualSync = lifecycle("pending");
    route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({
        accepted: true,
        id: 71,
        status: "pending",
        requested_at: "2026-09-01T10:00:00Z",
        retry_after_seconds: 900,
      }),
    });
  });

  try {
    await page.goto(`${baseUrl}/data-health`, {
      waitUntil: "networkidle",
      timeout: 20_000,
    });
    await page.locator("#toggle").click();
    await page.locator('[data-job="orders_v2026"]').waitFor();
    let state = await syncState(page);
    assert(
      state.button === "Sync now" &&
        !state.disabled &&
        state.expanded === "true",
      `${engineName} initial manual-sync action is wrong: ${JSON.stringify(state)}`,
    );

    await page.locator('[data-job="orders_v2026"]').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-job="orders_v2026"]')
          ?.textContent?.trim() === "Queued",
    );
    state = await syncState(page);
    assert(
      postCount === 1 &&
        state.disabled &&
        state.status === "pending" &&
        state.detail.includes("waiting for the worker") &&
        state.announcement === "Orders sync queued.",
      `${engineName} 202 queued state is wrong: ${JSON.stringify({ postCount, state })}`,
    );
    await page.evaluate(() => {
      document
        .querySelector('[data-job="orders_v2026"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert(
      postCount === 1,
      `${engineName} disabled queued action submitted twice`,
    );

    manualSync = lifecycle("running", { cooldown: 895 });
    await page.evaluate(() => window.__dppManualSyncPoll());
    await page.waitForFunction(
      () =>
        document.querySelector('[data-job="orders_v2026"]')?.dataset
          .syncStatus === "running",
    );
    state = await syncState(page);
    assert(
      state.button === "Running…" &&
        state.disabled &&
        state.detail.startsWith("Started") &&
        state.announcement === "Orders sync is running.",
      `${engineName} running state is wrong: ${JSON.stringify(state)}`,
    );

    manualSync = lifecycle("success", { cooldown: 840 });
    await page.evaluate(() => window.__dppManualSyncPoll());
    await page.waitForFunction(
      () =>
        document.querySelector('[data-job="orders_v2026"]')?.dataset
          .syncStatus === "success",
    );
    state = await syncState(page);
    assert(
      state.button === "Completed" &&
        state.disabled &&
        state.detail.includes("available in 14m") &&
        state.announcement === "Orders sync completed.",
      `${engineName} completed cooldown state is wrong: ${JSON.stringify(state)}`,
    );

    manualSync = lifecycle("success", { canRequest: true, cooldown: 0 });
    await page.evaluate(() => {
      window.DPPDataCache.invalidate("/api/data-health");
      window.__dppDataHealthRefresh();
    });
    await page.waitForFunction(
      () => !document.querySelector('[data-job="orders_v2026"]')?.disabled,
    );
    state = await syncState(page);
    assert(
      state.button === "Sync now" && !state.disabled,
      `${engineName} action re-enabled before/after the API contract incorrectly: ${JSON.stringify(state)}`,
    );

    postMode = "error";
    await page.locator('[data-job="orders_v2026"]').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-job="orders_v2026"]')
          ?.textContent?.trim() === "Try again",
    );
    state = await syncState(page);
    assert(
      !state.disabled &&
        state.detail === "Request failed · Fixture queue unavailable" &&
        state.announcement ===
          "Orders sync request failed: Fixture queue unavailable",
      `${engineName} request-error state is wrong: ${JSON.stringify(state)}`,
    );

    postMode = "cooldown";
    manualSync = lifecycle("running", { cooldown: 780 });
    await page.locator('[data-job="orders_v2026"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-job="orders_v2026"]')?.dataset
          .syncStatus === "running",
    );
    state = await syncState(page);
    assert(
      state.button === "Running…" &&
        state.disabled &&
        state.announcement.includes("already requested"),
      `${engineName} cooldown state is wrong: ${JSON.stringify(state)}`,
    );

    manualSync = lifecycle("error", {
      cooldown: 600,
      error: "Collector failed; see ingestion run",
    });
    await page.evaluate(() => window.__dppManualSyncPoll());
    await page.waitForFunction(
      () =>
        document.querySelector('[data-job="orders_v2026"]')?.dataset
          .syncStatus === "error",
    );
    state = await syncState(page);
    assert(
      state.button === "Failed" &&
        state.disabled &&
        state.detail.includes("Collector failed") &&
        state.detail.includes("10m") &&
        state.announcement === "Orders sync failed.",
      `${engineName} lifecycle-error cooldown is wrong: ${JSON.stringify(state)}`,
    );

    manualSync = lifecycle("error", {
      canRequest: true,
      cooldown: 0,
      error: "Collector failed; see ingestion run",
    });
    await page.evaluate(() => {
      window.DPPDataCache.invalidate("/api/data-health");
      window.__dppDataHealthRefresh();
    });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-job="orders_v2026"]')
          ?.textContent?.trim() === "Retry sync",
    );
    state = await syncState(page);
    assert(
      !state.disabled &&
        state.detail.includes("retry available") &&
        state.expanded === "true" &&
        state.overflow === 0 &&
        JSON.stringify(manualSyncStatuses) ===
          JSON.stringify([202, 503, 409]) &&
        browserErrors.length === 0,
      `${engineName} retry-ready/accessibility state is wrong: ${JSON.stringify({ state, manualSyncStatuses, browserErrors })}`,
    );
    checks.push(
      `${engineName}: queued, duplicate guard, running, completed, cooldown, failed, retry-ready, live-region, responsive`,
    );
  } catch (error) {
    failures.push(error.message);
  } finally {
    await context.close();
    await browser.close();
  }
}

const summary = {
  status: failures.length ? "FAIL" : "PASS",
  checks,
  failures,
};
await fs.writeFile(
  path.join(outDir, "manual-sync-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 3;
