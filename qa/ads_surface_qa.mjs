import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const baseUrl = (process.argv[2] || "http://127.0.0.1:8088").replace(/\/$/, "");
const outDir = process.argv[3] || "/out";
const failures = [];
const checks = [];
const deterministicReady = process.env.DPP_ADS_QA_FIXTURE === "ready";

function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ""}`);
}

async function api(page, endpoint) {
  return page.evaluate(async (url) => {
    const response = await fetch(url, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok)
      throw new Error(
        `${url} HTTP ${response.status}: ${body.error || "error"}`,
      );
    return body;
  }, endpoint);
}

async function chartAssetState(page) {
  return page.evaluate(() => ({
    paths: performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name).pathname)
      .filter((resourcePath) =>
        [
          "/assets/chart-system.css",
          "/assets/vendor/d3.v7.min.js",
          "/assets/chart-system.js",
        ].includes(resourcePath),
      ),
    revisions: performance
      .getEntriesByType("resource")
      .map((entry) => new URL(entry.name))
      .filter((url) =>
        [
          "/assets/chart-system.css",
          "/assets/vendor/d3.v7.min.js",
          "/assets/chart-system.js",
        ].includes(url.pathname),
      )
      .map((url) => url.searchParams.get("v")),
    pageRevision:
      document.querySelector('meta[name="dpp-asset-revision"]')?.content || "",
    runtime: Boolean(window.DPPCharts),
    dependencyNodes: document.querySelectorAll("[data-ads-chart-dependency]")
      .length,
  }));
}

const RULES = {
  ADS_PRODUCT_CONVERSION_REVIEW: {
    key: "ADS_PRODUCT_CONVERSION_REVIEW",
    version: 1,
    eligibility: "Reconciled and mature.",
    thresholds: { minimum_clicks: 8 },
    observation_window: { kind: "rolling", days: 28 },
    attribution_maturity: "21 mature days.",
    economic_claims_allowed: false,
  },
  ADS_PRODUCT_DEMAND_REVIEW: {
    key: "ADS_PRODUCT_DEMAND_REVIEW",
    version: 1,
    eligibility: "Reconciled and mature.",
    thresholds: { minimum_attributed_purchases: 2 },
    observation_window: { kind: "rolling", days: 28 },
    attribution_maturity: "21 mature days.",
    economic_claims_allowed: false,
  },
  ADS_DEMAND_TEST: {
    key: "ADS_DEMAND_TEST",
    version: 1,
    eligibility: "Reconciled and mature.",
    thresholds: { minimum_attributed_purchases: 2 },
    observation_window: { kind: "rolling", days: 28 },
    attribution_maturity: "21 mature days.",
    economic_claims_allowed: false,
  },
  ADS_SIGNAL_RELEVANCE_REVIEW: {
    key: "ADS_SIGNAL_RELEVANCE_REVIEW",
    version: 1,
    eligibility: "Reconciled and mature.",
    thresholds: { minimum_clicks: 8 },
    observation_window: { kind: "rolling", days: 28 },
    attribution_maturity: "21 mature days.",
    economic_claims_allowed: false,
  },
  ADS_SUPPORTED_MONITOR: {
    key: "ADS_SUPPORTED_MONITOR",
    version: 1,
    eligibility: "Reported spend.",
    thresholds: { minimum_spend: 0 },
    observation_window: { kind: "rolling", days: 28 },
    attribution_maturity: "Reported with the evidence.",
    economic_claims_allowed: false,
  },
};

const economics = {
  state: "UNAVAILABLE",
  authoritative: false,
  basis:
    "Product economics are not yet reconciled for Advertising decisions. Review contribution in Finance before changing paid support.",
  prohibited_claims: ["profitable", "scale", "winner", "reduce spend"],
};

const product = {
  sku: "SKU-ONE",
  asin: "B012345678",
  product: "Daily planning notebook",
  image_url: null,
  total_business_sales: 300,
  total_business_orders: 12,
  total_business_units: 13,
  spend: 30,
  attributed_sales: 90,
  impressions: 1500,
  clicks: 30,
  purchases: 3,
  units: 4,
  ctr: 0.02,
  cpc: 1,
  conversion_rate: 0.1,
  roas: 3,
  acos: 1 / 3,
  tacos: 0.1,
  attributed_sales_share: 0.3,
  observed_ads_days: 28,
  mature_ads_days: 21,
  period_start: "2026-08-01",
  through_date: "2026-08-28",
  recommendation: {
    state: "OPPORTUNITY_TEST",
    label: "Opportunity to test",
    title: "Review converting demand",
    explanation:
      "Amazon reports 3 attributed purchases. Identify which demand signals are contributing, then verify product economics before changing support.",
    rule_key: "ADS_PRODUCT_DEMAND_REVIEW",
    rule_version: 1,
    eligible: true,
    suppression_reason: null,
    evidence: {
      spend: 30,
      clicks: 30,
      attributed_purchases: 3,
      attributed_sales: 90,
      total_business_sales: 300,
      tacos: 0.1,
      observed_days: 28,
      mature_days: 21,
    },
  },
};

const signal = {
  signal_id: "ads-signal-one",
  source_grain: "search_term",
  signal_type: "SHOPPER_QUERY",
  signal_type_label: "Shopper query",
  signal: "daily planner",
  match_label: "Exact match",
  campaign_id: "campaign-one",
  campaign_name: "Notebook discovery",
  product_context: "Daily planning notebook",
  product_refs: [
    {
      sku: product.sku,
      asin: product.asin,
      product: product.product,
      image_url: null,
      url: "/product?sku=SKU-ONE",
    },
  ],
  technical: {
    campaign_id: "campaign-one",
    ad_group_id: "ad-group-one",
    target_id: "target-one",
    raw_value: "daily planner",
    raw_match_type: "EXACT",
  },
  spend: 10,
  attributed_sales: 36,
  impressions: 500,
  clicks: 10,
  purchases: 2,
  units: 2,
  ctr: 0.02,
  cpc: 1,
  conversion_rate: 0.2,
  roas: 3.6,
  acos: 10 / 36,
  recommendation: {
    state: "OPPORTUNITY_TEST",
    label: "Opportunity to test",
    title: "Review a dedicated test for “daily planner”",
    explanation:
      "Amazon reports 2 attributed purchases for this shopper query. Confirm product relevance and economics before changing targeting.",
    rule_key: "ADS_DEMAND_TEST",
    rule_version: 1,
    eligible: true,
  },
};

const productAction = {
  id: "ads-action-product",
  action_type: "PRODUCT_REVIEW",
  lane: "PRODUCT",
  rule_key: "ADS_PRODUCT_DEMAND_REVIEW",
  rule_version: 1,
  state: "OPPORTUNITY_TEST",
  label: "Opportunity to test",
  product: product.product,
  sku: product.sku,
  title: product.recommendation.title,
  rationale: product.recommendation.explanation,
  metrics: product.recommendation.evidence,
  maturity: { observed_days: 28, mature_days: 21, ready: true },
  review_steps: [
    "Review the product's traffic and attributed conversion.",
    "Inspect the demand signals and campaign intent supporting this SKU.",
    "Confirm product economics in Finance before changing paid support.",
  ],
  destination: {
    view: "products",
    sku: product.sku,
    action: "ads-action-product",
    filter: "opportunity_test",
  },
  qualification: economics.basis,
};

const demandAction = {
  id: "ads-action-demand",
  action_type: "DEMAND_TEST",
  lane: "DEMAND_OPPORTUNITY",
  rule_key: "ADS_DEMAND_TEST",
  rule_version: 1,
  state: "OPPORTUNITY_TEST",
  label: "Opportunity to test",
  product: product.product,
  sku: product.sku,
  title: signal.recommendation.title,
  rationale: signal.recommendation.explanation,
  metrics: { spend: 10, clicks: 10, purchases: 2, attributed_sales: 36 },
  maturity: { ready: true },
  destination: {
    view: "demand",
    sku: product.sku,
    campaign: signal.campaign_id,
    signal: signal.signal_id,
    action: "ads-action-demand",
    filter: "opportunity_test",
  },
  qualification: economics.basis,
};

const readyPayload = {
  status: "ready",
  local_time: "2026-08-28T08:00:00-06:00",
  connection: {
    state: "READY",
    badge: "Ads ready",
    headline: "Advertising data is ready.",
    detail: "Reporting is available.",
  },
  readiness: {
    state: "READY",
    label: "Ready for review",
    summary: "28/28 days observed · 21 mature · 0 quality issues",
  },
  freshness: {
    through_date: "2026-08-28",
    period_observed_days: 28,
    period_expected_days: 28,
    mature_days: 21,
  },
  quality: {
    state: "HEALTHY",
    trusted_for_operating_decisions: true,
    issue_days: 0,
    issues: [],
  },
  summary: {
    spend: 30,
    attributed_sales: 90,
    total_business_sales: 300,
    impressions: 1500,
    clicks: 30,
    purchases: 3,
    units: 4,
    acos: 1 / 3,
    tacos: 0.1,
    roas: 3,
    ctr: 0.02,
    cpc: 1,
    conversion_rate: 0.1,
    period_start: "2026-08-01",
    period_end: "2026-08-28",
    basis:
      "Latest 28 Ads dates aligned to independently reconciled seller sales. Amazon-attributed conversions can revise; attribution is not incrementality.",
  },
  daily: Array.from({ length: 28 }, (_, index) => ({
    business_date: new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10),
    spend: 30 / 28,
    attributed_sales: 90 / 28,
    total_business_sales: 300 / 28,
  })),
  campaigns: [
    {
      campaign_id: "campaign-one",
      campaign_name: "Notebook discovery",
      spend: 10,
      attributed_sales: 36,
      impressions: 500,
      clicks: 10,
      purchases: 2,
      units: 2,
      roas: 3.6,
      acos: 10 / 36,
      product_refs: signal.product_refs,
    },
    {
      campaign_id: "campaign-two",
      campaign_name: "Notebook support",
      spend: 20,
      attributed_sales: 54,
      impressions: 1000,
      clicks: 20,
      purchases: 1,
      units: 2,
      roas: 2.7,
      acos: 20 / 54,
      product_refs: signal.product_refs,
    },
  ],
  products: [product],
  demand: { items: [signal], total: 1, page: 1, page_size: 20, page_count: 1 },
  demand_totals: { targets: 0, search_terms: 1 },
  actions: [productAction, demandAction],
  action_groups: [
    {
      key: "PRODUCT",
      label: "Products requiring review",
      total: 1,
      shown: 1,
      actions: [productAction],
    },
    {
      key: "DEMAND_OPPORTUNITY",
      label: "Demand opportunities to test",
      total: 1,
      shown: 1,
      actions: [demandAction],
    },
  ],
  interpretation_rules: RULES,
  economics,
};

const degradedPayload = structuredClone(readyPayload);
degradedPayload.connection = {
  state: "READY",
  badge: "Ads refresh delayed",
  headline: "Latest Amazon Ads refresh needs attention.",
  detail:
    "Previously ingested reporting remains available. The latest refresh failed; Data Health has the technical error and the worker will retry.",
  note: "stored reporting available; refresh delayed",
  detail_code: "REPORT_REFRESH_FAILED",
  degraded: true,
  refreshing: false,
};
degradedPayload.readiness = {
  ...readyPayload.readiness,
  state: "DEGRADED",
  label: "Ads refresh delayed",
  summary:
    "Stored data through 2026-08-28 · 28/28 days observed · 21 mature · 0 quality issues",
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.on("pageerror", (error) => failures.push(`pageerror: ${error.message}`));

try {
  if (deterministicReady) {
    await page.route("**/api/ads*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(readyPayload),
      }),
    );
  }
  await page.goto(`${baseUrl}/ads`, {
    waitUntil: "domcontentloaded",
    timeout: 20000,
  });
  const payload = await api(page, "/api/ads");
  const connection = payload.connection || {};
  await page.waitForFunction(
    (ready) =>
      ready
        ? !document.getElementById("readyState").hidden &&
          Boolean(window.DPPCharts)
        : !document.getElementById("emptyState").hidden,
    connection.state === "READY" && payload.status === "ready",
    { timeout: 20_000 },
  );
  const chartState = await chartAssetState(page);
  const tabs = await page.locator("[data-ads-view]").evaluateAll((items) =>
    items.map((item) => ({
      view: item.dataset.adsView,
      disabled: item.disabled,
      ariaDisabled: item.getAttribute("aria-disabled"),
    })),
  );
  if (connection.state === "READY" && payload.status === "ready") {
    const ruleValues = Object.values(payload.interpretation_rules || {});
    const actions = payload.actions || [];
    const text = await page.locator("main").innerText();
    const semanticText = await page.locator("main").textContent();
    const prohibitedClaim =
      /\b(profitable|scale winners?|reduce spend)\b/i.test(text);
    check(
      "Production Ads exposes the four business-oriented views",
      JSON.stringify(tabs.map((tab) => tab.view)) ===
        JSON.stringify(["impact", "products", "demand", "detail"]) &&
        tabs.every((tab) => !tab.disabled && tab.ariaDisabled === "false"),
      JSON.stringify(tabs),
    );
    check(
      "Production API exposes named versioned interpretation rules",
      ruleValues.length >= 5 &&
        ruleValues.every(
          (rule) =>
            rule.key &&
            Number.isInteger(rule.version) &&
            rule.attribution_maturity,
        ),
      JSON.stringify(ruleValues.map((rule) => [rule.key, rule.version])),
    );
    check(
      "Production product contract integrates the business operands",
      (payload.products || []).every((row) =>
        [
          "sku",
          "total_business_sales",
          "spend",
          "impressions",
          "clicks",
          "purchases",
          "attributed_sales",
          "tacos",
          "mature_ads_days",
          "recommendation",
        ].every((key) => key in row),
      ),
      `${(payload.products || []).length} products`,
    );
    check(
      "Production demand is server-bounded and normalized",
      Number(payload.demand?.page_size) === 20 &&
        (payload.demand?.items || []).length <= 20 &&
        (payload.demand?.items || []).every(
          (row) =>
            ["SHOPPER_QUERY", "MATCHED_PRODUCT", "TARGET"].includes(
              row.signal_type,
            ) &&
            !(
              row.signal_type === "TARGET" &&
              row.signal === row.technical?.target_id
            ),
        ),
      JSON.stringify({
        pageSize: payload.demand?.page_size,
        rows: payload.demand?.items?.length,
      }),
    );
    check(
      "Production actions remain server-traceable and product work is preserved",
      actions.every(
        (action) =>
          action.id &&
          action.rule_key &&
          action.rule_version &&
          action.destination,
      ) && actions.some((action) => action.action_type === "PRODUCT_REVIEW"),
      JSON.stringify(
        actions.map((action) => [action.action_type, action.rule_key]),
      ),
    );
    check(
      "Production declares economics unavailable",
      payload.economics?.state === "UNAVAILABLE" &&
        payload.economics?.authoritative === false,
      JSON.stringify(payload.economics),
    );
    check(
      "Production UI avoids economic prescriptions",
      !prohibitedClaim,
      prohibitedClaim ? text : "",
    );
    check(
      "Production UI rejects attribution-as-incrementality",
      semanticText.includes("not incrementality") ||
        semanticText.includes("attribution is not incrementality"),
    );
    check(
      "Production ready state loads one revision of every chart dependency",
      new Set(chartState.paths).size === 3 &&
        chartState.revisions.every(
          (revision) => revision === chartState.pageRevision,
        ),
      JSON.stringify(chartState),
    );
    check(
      "Production campaign chart has no prescriptive quadrant labels",
      !/Scale winners|Efficient support|Low-risk tests|Review spend/.test(text),
    );
  } else {
    check(
      "Production unavailable state keeps only Business impact enabled",
      tabs[0]?.view === "impact" &&
        !tabs[0].disabled &&
        tabs
          .slice(1)
          .every((tab) => tab.disabled && tab.ariaDisabled === "true"),
      JSON.stringify(tabs),
    );
    check(
      "Production unavailable state skips chart dependencies",
      chartState.paths.length === 0,
    );
  }
  await fs.mkdir(outDir, { recursive: true });
  await page.screenshot({
    path: path.join(outDir, "ads-business-impact-desktop.png"),
    fullPage: true,
  });

  const readyContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const readyPage = await readyContext.newPage();
  try {
    await readyPage.route("**/api/ads*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(readyPayload),
      }),
    );
    await readyPage.goto(`${baseUrl}/ads`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await readyPage.waitForFunction(
      () =>
        Boolean(window.DPPCharts) &&
        document.querySelectorAll("#portfolioChart .ads-portfolio-mark").length,
      null,
      { timeout: 10000 },
    );
    const renderedProductActions = await readyPage
      .locator(".ads-action-body > h3")
      .allTextContents();
    check(
      "Ready overview keeps the API-owned product decisions concise",
      JSON.stringify(renderedProductActions) ===
        JSON.stringify(
          readyPayload.actions
            .filter((action) => action.action_type === "PRODUCT_REVIEW")
            .map((action) => action.title),
        ),
      JSON.stringify(renderedProductActions),
    );
    check(
      "Ready overview names the product and its seller-sales basis",
      (await readyPage.locator("#portfolioChart").textContent()).includes(product.product) &&
        (await readyPage.locator("#portfolioChart").getAttribute("aria-label"))
          .toLowerCase()
          .includes("seller sales"),
    );
    check(
      "Ready chart marks expose keyboard-accessible names",
      await readyPage
        .locator(".ads-portfolio-mark")
        .evaluateAll((marks) =>
          marks.every(
            (mark) =>
              mark.getAttribute("role") === "img" &&
              mark.getAttribute("tabindex") === "0" &&
              Boolean(mark.getAttribute("aria-label")),
          ),
        ),
    );
    const decisionArchitecture = await readyPage.evaluate(() => ({
      legacyQualityBanner: Boolean(document.getElementById("qualityBand")),
      duplicatePortfolioList: Boolean(document.getElementById("portfolioList")),
      portfolioBars: document.querySelectorAll("#portfolioChart rect.ads-portfolio-mark").length,
      portfolioValues: document.querySelectorAll("#portfolioChart .ads-portfolio-value").length,
      weeklyBars: document.querySelectorAll("#chart .ads-week-mark").length,
      weeklyValues: document.querySelectorAll("#chart .ads-week-value").length,
      demandPulse: document.getElementById("demandPulse")?.textContent || "",
    }));
    check(
      "Ready overview uses the compact decision architecture",
      !decisionArchitecture.legacyQualityBanner &&
        !decisionArchitecture.duplicatePortfolioList &&
        decisionArchitecture.portfolioBars === readyPayload.products.length &&
        decisionArchitecture.portfolioValues === decisionArchitecture.portfolioBars &&
        decisionArchitecture.weeklyBars === 4 &&
        decisionArchitecture.weeklyValues === 4 &&
        decisionArchitecture.demandPulse.includes("signals worth testing"),
      JSON.stringify(decisionArchitecture),
    );
    const visualContract = await readyPage.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const mark = document.querySelector(".ads-portfolio-mark");
      return {
        summaries: [...document.querySelectorAll("main summary")]
          .filter((node) => node.getClientRects().length)
          .map((node) => node.getBoundingClientRect().height),
        markStroke: mark?.getAttribute("stroke") || "",
        dataStroke: root.getPropertyValue("--dpp-data2").trim(),
      };
    });
    check(
      "Ready disclosures and portfolio marks retain control and contrast floors",
      visualContract.summaries.every((height) => height >= 40) &&
        visualContract.markStroke === "var(--dpp-data4)" &&
        Boolean(visualContract.dataStroke),
      JSON.stringify(visualContract),
    );
    await readyPage
      .locator('[data-review-action="ads-action-product"]')
      .click();
    await readyPage.waitForURL(/view=products/);
    await readyPage.waitForFunction(
      () =>
        !document.getElementById("products").hidden &&
        document
          .querySelector('[data-sku="SKU-ONE"]')
          ?.classList.contains("is-highlighted"),
    );
    const productState = await readyPage.evaluate(() => ({
      url: location.search,
      visible: !document.getElementById("products").hidden,
      highlighted: document
        .querySelector('[data-sku="SKU-ONE"]')
        ?.classList.contains("is-highlighted"),
      focused: document.activeElement?.getAttribute("data-sku"),
    }));
    check(
      "Product action opens the exact URL-restored SKU evidence",
      productState.visible &&
        productState.url.includes("sku=SKU-ONE") &&
        productState.url.includes("action=ads-action-product") &&
        productState.highlighted &&
        productState.focused === "SKU-ONE",
      JSON.stringify(productState),
    );
    await readyPage.locator('[data-ads-view="detail"]').click();
    await readyPage.waitForFunction(
      () => !document.getElementById("detail").hidden,
    );
    const detailText = await readyPage.locator("#detail").innerText();
    check(
      "Campaign comparison is explicitly neutral",
      detailText.includes("This is not profitability") &&
        !/Scale winners|Efficient support|Low-risk tests/.test(detailText),
      detailText,
    );
    check(
      "Technical campaign identifiers are secondary disclosures",
      (await readyPage.locator("#campaignRows details.ads-technical").count()) >
        0 &&
        (await readyPage
          .locator("#campaignRows details.ads-technical[open]")
          .count()) === 0,
    );
  } finally {
    await readyContext.close();
  }

  const degradedContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const degradedPage = await degradedContext.newPage();
  try {
    await degradedPage.route("**/api/ads*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(degradedPayload),
      }),
    );
    await degradedPage.goto(`${baseUrl}/ads?view=products`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await degradedPage.waitForFunction(
      () =>
        !document.getElementById("readyState").hidden &&
        !document.getElementById("products").hidden &&
        Boolean(window.DPPCharts),
    );
    const degraded = await degradedPage.evaluate(() => ({
      emptyHidden: document.getElementById("emptyState").hidden,
      tabsEnabled: [...document.querySelectorAll("[data-ads-view]")].every(
        (tab) => !tab.disabled && tab.getAttribute("aria-disabled") === "false",
      ),
      status: document.getElementById("readinessLabel").textContent.trim(),
      topbar: document.getElementById("asof").textContent.trim(),
      readiness: document.getElementById("readinessLine").textContent.trim(),
      products: document.querySelectorAll("#productRows tr").length,
      actionsVisible: !document.getElementById("actionSection").hidden,
    }));
    check(
      "Failed incremental refresh keeps healthy stored reporting available",
      degraded.emptyHidden &&
        degraded.tabsEnabled &&
        degraded.products > 0 &&
        degraded.actionsVisible,
      JSON.stringify(degraded),
    );
    check(
      "Failed incremental refresh is disclosed without claiming a data outage",
      degraded.status === "Stored data ready" &&
        degraded.topbar.includes("Ads refresh delayed") &&
        degraded.readiness.includes("Through 2026-08-28"),
      JSON.stringify(degraded),
    );
  } finally {
    await degradedContext.close();
  }

  const mobileContext = await browser.newContext({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobileContext.newPage();
  try {
    await mobilePage.route("**/api/ads*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(readyPayload),
      }),
    );
    await mobilePage.goto(`${baseUrl}/ads?view=demand`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await mobilePage.waitForFunction(
      () => !document.getElementById("demand").hidden,
    );
    const mobile = await mobilePage.evaluate(() => ({
      viewportContained:
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth + 2,
      rows: document.querySelectorAll("#demandRows tr").length,
      tableScrollable:
        document.querySelector(".ads-demand-table .data-table-scroll")
          .scrollWidth >
        document.querySelector(".ads-demand-table .data-table-scroll")
          .clientWidth,
      tableFits:
        document
          .querySelector(".ads-demand-table .data-table")
          .getBoundingClientRect().width <=
        document.querySelector(".ads-demand-table .data-table-scroll")
          .clientWidth +
          1,
      tableBounded:
        document
          .querySelector(".ads-demand-table .data-table-scroll")
          .getBoundingClientRect().height <=
        window.innerHeight * 0.69,
    }));
    check(
      "Mobile demand keeps contained bounded semantic records",
      mobile.viewportContained &&
        mobile.rows <= 20 &&
        !mobile.tableScrollable &&
        mobile.tableFits &&
        mobile.tableBounded,
      JSON.stringify(mobile),
    );
    await mobilePage.screenshot({
      path: path.join(outDir, "ads-demand-mobile.png"),
      fullPage: true,
    });
  } finally {
    await mobileContext.close();
  }

  const disconnectedContext = await browser.newContext({
    viewport: { width: 412, height: 915 },
    isMobile: true,
    hasTouch: true,
  });
  const disconnectedPage = await disconnectedContext.newPage();
  try {
    const disconnected = {
      status: "not_initialized",
      local_time: "2026-08-28T08:00:00-06:00",
      connection: {
        state: "NOT_CONNECTED",
        badge: "Ads not connected",
        headline: "Amazon Ads is not connected.",
        detail: "Connect Amazon Ads before paid-support reporting can start.",
      },
      freshness: null,
      quality: {
        state: "NO_DATA",
        trusted_for_operating_decisions: false,
        issues: [],
      },
      summary: {},
      daily: [],
      campaigns: [],
      products: [],
      demand: { items: [], total: 0, page: 1, page_size: 20, page_count: 1 },
      actions: [],
      action_groups: [],
      interpretation_rules: RULES,
      economics,
    };
    await disconnectedPage.route("**/api/ads*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(disconnected),
      }),
    );
    await disconnectedPage.goto(`${baseUrl}/ads?view=demand&sku=SKU-ONE`, {
      waitUntil: "networkidle",
      timeout: 20000,
    });
    const tabs = await disconnectedPage
      .locator("[data-ads-view]")
      .evaluateAll((items) =>
        items.map((item) => ({
          view: item.dataset.adsView,
          disabled: item.disabled,
          ariaDisabled: item.getAttribute("aria-disabled"),
        })),
      );
    const chartState = await chartAssetState(disconnectedPage);
    const availability = (
      (await disconnectedPage.locator("#adsViewAvailability").textContent()) ||
      ""
    ).trim();
    check(
      "Disconnected Ads keeps only Business impact enabled",
      tabs[0]?.view === "impact" &&
        !tabs[0].disabled &&
        tabs[0].ariaDisabled === "false" &&
        tabs
          .slice(1)
          .every((tab) => tab.disabled && tab.ariaDisabled === "true"),
      JSON.stringify(tabs),
    );
    check(
      "Disconnected Ads explains view availability once",
      availability ===
        "Only Business impact is available in the current Advertising connection state.",
      availability,
    );
    check(
      "Disconnected Ads is contained and chart-free",
      chartState.paths.length === 0 &&
        chartState.dependencyNodes === 0 &&
        (await disconnectedPage.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth + 2,
        )),
      JSON.stringify(chartState),
    );
  } finally {
    await disconnectedContext.close();
  }
} catch (error) {
  failures.push(`Ads surface QA: ${error.message}`);
} finally {
  await context.close();
  await browser.close();
}

const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  status: failures.length ? "FAIL" : "PASS",
  checks,
  failures,
};
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(
  path.join(outDir, "ads-surface-summary.json"),
  JSON.stringify(summary, null, 2),
);
console.log(
  JSON.stringify(
    { status: summary.status, checks: checks.length, failures },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 3;
