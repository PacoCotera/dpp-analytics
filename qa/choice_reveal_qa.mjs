import { chromium, webkit } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

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
const errors = [];
const checks = [];

function record(condition, message) {
  checks.push({ message, ok: Boolean(condition) });
  if (!condition) errors.push(message);
}

async function waitForChoice(page, groupSelector, valueSelector) {
  await page.waitForFunction(
    ([group, value]) => {
      const active = document.querySelector(`${group} ${value}`);
      return (
        active?.getAttribute("aria-pressed") === "true" ||
        active?.getAttribute("aria-selected") === "true"
      );
    },
    [groupSelector, valueSelector],
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}

async function waitForAdsAvailability(page, groupSelector, demandSelector) {
  await page.waitForFunction(
    ([group, demand]) => {
      const tablist = document.querySelector(group);
      const demandTab = tablist?.querySelector(demand);
      const impactTab = tablist?.querySelector('[data-ads-view="impact"]');
      return (
        demandTab?.getAttribute("aria-selected") === "true" ||
        (demandTab?.disabled &&
          demandTab?.getAttribute("aria-disabled") === "true" &&
          impactTab?.getAttribute("aria-selected") === "true")
      );
    },
    [groupSelector, demandSelector],
  );
  return page.evaluate(
    ([group, demand]) => {
      const tablist = document.querySelector(group);
      const demandTab = tablist?.querySelector(demand);
      return {
        ready: demandTab?.getAttribute("aria-selected") === "true",
        demandDisabled:
          Boolean(demandTab?.disabled) &&
          demandTab?.getAttribute("aria-disabled") === "true",
        availability:
          document.getElementById("adsViewAvailability")?.textContent?.trim() || "",
      };
    },
    [groupSelector, demandSelector],
  );
}

async function choiceState(page, groupSelector, valueSelector) {
  return page.evaluate(
    ([groupQuery, valueQuery]) => {
      const group = document.querySelector(groupQuery);
      const active = group?.querySelector(valueQuery);
      const groupRect = group?.getBoundingClientRect();
      const activeRect = active?.getBoundingClientRect();
      return {
        profile: window.dppPresentation?.getProfileId(),
        selected:
          active?.getAttribute("aria-pressed") ||
          active?.getAttribute("aria-selected"),
        group: groupRect && {
          left: groupRect.left,
          right: groupRect.right,
          width: groupRect.width,
          scrollLeft: group.scrollLeft,
          clientWidth: group.clientWidth,
          scrollWidth: group.scrollWidth,
        },
        active: activeRect && {
          left: activeRect.left,
          right: activeRect.right,
          width: activeRect.width,
        },
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    },
    [groupSelector, valueSelector],
  );
}

function fullyVisible(state) {
  return Boolean(
    state.active &&
      state.group &&
      state.active.left >= state.group.left - 1 &&
      state.active.right <= state.group.right + 1,
  );
}

async function assertProfiles(
  page,
  label,
  groupSelector,
  valueSelector,
  screenshotPrefix,
) {
  for (const profile of profiles) {
    await page.evaluate(
      (id) => window.dppPresentation.setProfile(id, { persist: false }),
      profile,
    );
    await waitForChoice(page, groupSelector, valueSelector);
    const state = await choiceState(page, groupSelector, valueSelector);
    record(
      state.selected === "true",
      `${label}/${profile}: selected state is exposed`,
    );
    record(
      fullyVisible(state),
      `${label}/${profile}: active choice is fully visible (${JSON.stringify(state)})`,
    );
    record(
      state.documentOverflow === 0,
      `${label}/${profile}: document overflow is zero`,
    );

    if (screenshotPrefix && ["warm-studio", "weyland"].includes(profile)) {
      await page.locator(groupSelector).screenshot({
        path: path.join(outDir, `${screenshotPrefix}-${profile}.png`),
      });
    }
  }
}

for (const [engineName, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
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

    await page.goto(`${baseUrl}/catalog?mode=deleted`, {
      waitUntil: "networkidle",
    });
    await waitForChoice(page, "#analysisModes", '[data-mode="deleted"]');
    await assertProfiles(
      page,
      `${prefix}/catalog-deleted-direct`,
      "#analysisModes",
      '[data-mode="deleted"]',
      viewport.width === 360 ? `${prefix}-catalog-deleted` : "",
    );
    await page.reload({ waitUntil: "networkidle" });
    await waitForChoice(page, "#analysisModes", '[data-mode="deleted"]');
    const deletedRefresh = await choiceState(
      page,
      "#analysisModes",
      '[data-mode="deleted"]',
    );
    record(
      fullyVisible(deletedRefresh),
      `${prefix}/catalog-deleted-refresh: active choice is visible`,
    );

    await page.goto(`${baseUrl}/catalog?filter=inactive`, {
      waitUntil: "networkidle",
    });
    await waitForChoice(page, "#filters", '[data-filter="inactive"]');
    await assertProfiles(
      page,
      `${prefix}/catalog-inactive-direct`,
      "#filters",
      '[data-filter="inactive"]',
      viewport.width === 360 ? `${prefix}-catalog-inactive` : "",
    );
    await page.locator('[data-filter="dormant"]').click();
    await waitForChoice(page, "#filters", '[data-filter="dormant"]');
    const dormantSelection = await choiceState(
      page,
      "#filters",
      '[data-filter="dormant"]',
    );
    record(
      fullyVisible(dormantSelection),
      `${prefix}/catalog-filter-selection: active choice is visible`,
    );
    await page.goBack({ waitUntil: "networkidle" });
    await waitForChoice(page, "#filters", '[data-filter="inactive"]');
    const inactiveHistory = await choiceState(
      page,
      "#filters",
      '[data-filter="inactive"]',
    );
    record(
      fullyVisible(inactiveHistory),
      `${prefix}/catalog-filter-history: restored choice is visible`,
    );

    await page.goto(`${baseUrl}/inventory?scope=all`, {
      waitUntil: "networkidle",
    });
    const inventoryGroup = ".inventory-filter-field .filters";
    await waitForChoice(page, inventoryGroup, '[data-filter="all"]');
    await assertProfiles(
      page,
      `${prefix}/inventory-all-direct`,
      inventoryGroup,
      '[data-filter="all"]',
      viewport.width === 360 ? `${prefix}-inventory-all` : "",
    );
    await page.reload({ waitUntil: "networkidle" });
    await waitForChoice(page, inventoryGroup, '[data-filter="all"]');
    const inventoryRefresh = await choiceState(
      page,
      inventoryGroup,
      '[data-filter="all"]',
    );
    record(
      fullyVisible(inventoryRefresh),
      `${prefix}/inventory-all-refresh: active choice is visible`,
    );
    await page.locator('[data-filter="archived"]').click();
    await waitForChoice(page, inventoryGroup, '[data-filter="archived"]');
    const inventorySelection = await choiceState(
      page,
      inventoryGroup,
      '[data-filter="archived"]',
    );
    record(
      fullyVisible(inventorySelection),
      `${prefix}/inventory-selection: active choice is visible`,
    );
    await page.goBack({ waitUntil: "networkidle" });
    await waitForChoice(page, inventoryGroup, '[data-filter="all"]');
    const inventoryHistory = await choiceState(
      page,
      inventoryGroup,
      '[data-filter="all"]',
    );
    record(
      fullyVisible(inventoryHistory),
      `${prefix}/inventory-history: restored choice is visible`,
    );

    await page.goto(`${baseUrl}/ads?view=demand`, {
      waitUntil: "networkidle",
    });
    const adsGroup = '[aria-label="Advertising views"]';
    const adsDemand = '[data-ads-view="demand"]';
    const adsAvailability = await waitForAdsAvailability(
      page,
      adsGroup,
      adsDemand,
    );
    if (adsAvailability.ready) {
      await assertProfiles(
        page,
        `${prefix}/ads-demand-direct`,
        adsGroup,
        adsDemand,
        viewport.width === 360 ? `${prefix}-ads-demand` : "",
      );
      await page.reload({ waitUntil: "networkidle" });
      await waitForChoice(page, adsGroup, adsDemand);
      const adsRefresh = await choiceState(page, adsGroup, adsDemand);
      record(
        fullyVisible(adsRefresh),
        `${prefix}/ads-demand-refresh: active choice is visible`,
      );
      await page.locator('[data-ads-view="products"]').click();
      await waitForChoice(page, adsGroup, '[data-ads-view="products"]');
      await page.goBack({ waitUntil: "networkidle" });
      await waitForChoice(page, adsGroup, adsDemand);
      const adsHistory = await choiceState(page, adsGroup, adsDemand);
      record(
        fullyVisible(adsHistory),
        `${prefix}/ads-demand-history: restored choice is visible`,
      );
    } else {
      const adsImpact = '[data-ads-view="impact"]';
      record(
        adsAvailability.demandDisabled && Boolean(adsAvailability.availability),
        `${prefix}/ads-unavailable: disabled Demand has an explicit availability explanation`,
      );
      await assertProfiles(
        page,
        `${prefix}/ads-impact-unavailable`,
        adsGroup,
        adsImpact,
        viewport.width === 360 ? `${prefix}-ads-impact-unavailable` : "",
      );
      await page.reload({ waitUntil: "networkidle" });
      const refreshedAvailability = await waitForAdsAvailability(
        page,
        adsGroup,
        adsDemand,
      );
      const refreshedChoice = refreshedAvailability.ready ? adsDemand : adsImpact;
      const adsRefresh = await choiceState(page, adsGroup, refreshedChoice);
      record(
        fullyVisible(adsRefresh),
        `${prefix}/ads-refresh: resolved Advertising choice remains visible`,
      );
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
  path.join(outDir, "choice-reveal-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify({ choiceRevealQA: summary }, null, 2));
if (errors.length) process.exitCode = 13;
