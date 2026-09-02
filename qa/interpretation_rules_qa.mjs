import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const surfaces = [
  {
    route: '/business',
    api: '/api/home?refresh=1',
    rules: ['BUSINESS_MOMENTUM_V1'],
    minimumButtons: 1,
  },
  {
    route: '/',
    api: '/api/today?refresh=1',
    rules: ['TODAY_PACE_V1', 'TODAY_BUSINESS_CONTEXT_V1'],
    minimumButtons: 2,
  },
  {
    route: '/sales',
    api: '/api/sales?refresh=1',
    rules: ['TODAY_PACE_V1', 'SALES_PRODUCT_CHANGE_V1', 'SALES_CONCENTRATION_V1', 'SALES_BREADTH_V1'],
    minimumButtons: 4,
    activateSelector: '#salesProductsTab',
  },
  {
    route: '/catalog',
    api: '/api/catalog?refresh=1',
    rules: ['CATALOG_COMMERCIAL_STATE_V1', 'CATALOG_FAMILY_STATE_V1', 'CATALOG_DIMENSION_CONVERSION_V1'],
    minimumButtons: 1,
    ruleDisclosure: 'details.family',
    visibleRuleSelector: 'details.family[open] .rule-trigger',
  },
  {
    route: '/product?sku=PNC-001L',
    api: '/api/product?sku=PNC-001L&refresh=1',
    rules: ['CATALOG_COMMERCIAL_STATE_V1'],
    minimumButtons: 1,
  },
  {
    route: '/trajectory',
    api: '/api/trajectory?refresh=1',
    rules: ['TRAJECTORY_STRUCTURE_V1'],
    minimumButtons: 1,
  },
];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const failures = [];
const summary = { ok: false, surfaces: [], catalogNewListing: null };
page.on('console', (message) => {
  if (message.type() === 'error') failures.push(`console: ${message.text()}`);
});
page.on('pageerror', (error) => failures.push(`page: ${error.message}`));

function validateRule(ruleId, rule) {
  if (!rule || rule.id !== ruleId || Number(rule.version) < 1) {
    throw new Error(`${ruleId} is not named and versioned`);
  }
  if (!rule.window || !rule.eligibility || !Array.isArray(rule.inputs) || !rule.inputs.length) {
    throw new Error(`${ruleId} is missing its window, inputs, or eligibility`);
  }
  if (!rule.input_labels || rule.inputs.some((input) => !rule.input_labels[input])) {
    throw new Error(`${ruleId} is missing a business-facing input label`);
  }
  if (!Array.isArray(rule.thresholds) || !rule.thresholds.length) {
    throw new Error(`${ruleId} has no thresholds`);
  }
}

function assertBusinessDialogCopy(route, dialog) {
  if (!/Measures used/i.test(dialog) || !/How the result is assigned/i.test(dialog) || !/Eligibility/i.test(dialog)) {
    throw new Error(`${route} rule detail is incomplete`);
  }
  const internalCopy = [/_[A-Z0-9_]+_V\d/i, /\b(?:delta\d*|t\d+|pct|open_date)\b/i, /\b(?:PLAN|OK|STOCKOUT|PRODUCE)\b/, />=|<=|\bmax\s*\(|\d(?:\.\d+)?\s*x\s/i];
  if (internalCopy.some((pattern) => pattern.test(dialog))) {
    throw new Error(`${route} exposes internal rule copy: ${dialog}`);
  }
}

try {
  for (const surface of surfaces) {
    const response = await fetch(`${baseUrl}${surface.api}`, {
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`${surface.api} returned ${response.status}`);
    for (const ruleId of surface.rules) validateRule(ruleId, payload.interpretation_rules?.[ruleId]);

    if (surface.route === '/catalog') {
      const newListing = (payload.products || []).find((item) => item.sku === 'PNC-001L');
      const evaluation = newListing?.commercial_evaluation || {};
      if (
        newListing?.commercial_state !== 'LEARNING' ||
        evaluation.rule_id !== 'CATALOG_COMMERCIAL_STATE_V1' ||
        evaluation.eligible !== false ||
        !Number.isFinite(Number(evaluation.inputs?.eligible_exposure_days)) ||
        Number(evaluation.inputs.eligible_exposure_days) >= 28
      ) {
        throw new Error(`New offer exposure is not protected from a Dormant label: ${JSON.stringify(newListing)}`);
      }
      summary.catalogNewListing = {
        sku: newListing.sku,
        state: newListing.commercial_state,
        eligibleExposureDays: evaluation.inputs.eligible_exposure_days,
        requiredExposureDays: 28,
      };
    }

    await page.goto(`${baseUrl}${surface.route}`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    const ruleButtons = page.locator('.rule-trigger');
    await ruleButtons.first().waitFor({ state: 'attached', timeout: 15000 });
    const buttons = await ruleButtons.count();
    if (buttons < surface.minimumButtons) {
      throw new Error(`${surface.route} rendered ${buttons} rule buttons, expected at least ${surface.minimumButtons}`);
    }
    if (surface.activateSelector) {
      await page.locator(surface.activateSelector).click();
    }
    if (surface.ruleDisclosure) {
      const disclosure = page.locator(surface.ruleDisclosure).first();
      await disclosure.waitFor({ state: 'attached', timeout: 15000 });
      if (!(await disclosure.evaluate((element) => element.open))) {
        await disclosure.locator('summary').click();
      }
    }
    const visibleRules = page.locator(`${surface.visibleRuleSelector || '.rule-trigger'}:visible`);
    const visibleCount = await visibleRules.count();
    if (!visibleCount) {
      throw new Error(`${surface.route} has no visible rule definitions`);
    }
    for (let index = 0; index < visibleCount; index += 1) {
      const visibleRule = visibleRules.nth(index);
      await visibleRule.scrollIntoViewIfNeeded();
      await visibleRule.click();
      await page.locator('#interpretationRuleDialog[open]').waitFor({ state: 'visible', timeout: 5000 });
      assertBusinessDialogCopy(surface.route, await page.locator('#interpretationRuleDialog').innerText());
      await page.getByRole('button', { name: 'Close rule detail' }).click();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) throw new Error(`${surface.route} has ${overflow}px horizontal overflow`);
    summary.surfaces.push({
      route: surface.route,
      rules: surface.rules,
      renderedRuleButtons: buttons,
      inspectedDialogs: visibleCount,
    });
  }

  if (failures.length) throw new Error(failures.join(' | '));
  summary.ok = true;
  await fs.writeFile(path.join(outDir, 'interpretation-rules-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  summary.error = error.message;
  await fs.writeFile(path.join(outDir, 'interpretation-rules-summary.json'), JSON.stringify(summary, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
