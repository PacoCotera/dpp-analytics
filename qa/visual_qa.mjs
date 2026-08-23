import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
const viewports = {
  mobile: { width: 412, height: 915, isMobile: true, hasTouch: true },
  tablet: { width: 1024, height: 768, isMobile: false, hasTouch: true },
  desktop: { width: 1600, height: 1000, isMobile: false, hasTouch: false },
};
const wait = (page, selector) => page.locator(selector).first().waitFor({ state: 'visible', timeout: 5000 });

async function verifyAds(page, view = 'overview') {
  const status = await page.evaluate(async () => (await (await fetch('/api/ads', { cache: 'no-store' })).json()).status);
  if (status !== 'ready') return wait(page, '#emptyState');
  if (view === 'campaigns') {
    await page.locator('button[data-view="campaigns"]').click();
    return wait(page, '#campaignQuadrant .dpp-bubble');
  }
  return wait(page, '#chart .dpp-bar');
}

async function verifySalesOverview(page) {
  await wait(page, '#monthChart .dpp-bar');
  for (const [range, selector] of [['90d', '.sales-week'], ['28d', '.sales-day'], ['full', '.sales-month']]) {
    await page.locator(`button[data-range="${range}"]`).click();
    await wait(page, `#monthChart ${selector}`);
  }
  await page.locator('button[data-range="12m"]').click();
}

async function catalogSemantic(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/catalog', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) return { errors: [`catalog API ${response.status}`] };
    const errors = [];
    const close = (a, b, tolerance = 0.02) => Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;
    if (!data.summary?.taxonomy_override_configured) errors.push('seller taxonomy is not configured');
    const unmappedSkus = data.summary?.taxonomy_unmapped_skus || [];
    if (unmappedSkus.length) errors.push(`sellable SKUs missing seller taxonomy: ${unmappedSkus.join(', ')}`);
    for (const family of data.families || []) {
      // Amazon lifecycle markers are operational metadata, never commercial family names.
      if (/\b(actual|archivo)\b/i.test(String(family.name || ''))) errors.push(`${family.family_asin}: raw Amazon lifecycle label leaked into family name`);
      const members = (family.members || []).filter(x => ['SELLABLE_VARIATION', 'SELLABLE_STANDALONE'].includes(x.product_role));
      if (!members.length) continue;
      const sum = key => members.reduce((n, x) => n + Number(x[key] || 0), 0);
      const sales = sum('sales_t28'), units = sum('units_t28'), sessions = sum('sessions_t28');
      if (!close(family.sales_t28, sales)) errors.push(`${family.family_asin}: family sales != child rollup`);
      if (Number(family.units_t28 || 0) !== units) errors.push(`${family.family_asin}: family units != child rollup`);
      if (Number(family.sessions_t28 || 0) !== sessions) errors.push(`${family.family_asin}: family sessions != child rollup`);
      if (Number(family.available || 0) !== sum('available') || Number(family.inbound || 0) !== sum('inbound')) errors.push(`${family.family_asin}: family inventory != child rollup`);
      const expectedCvr = sessions > 0 ? Math.round(10000 * units / sessions) / 100 : null;
      if (expectedCvr === null ? family.conversion_t28_pct != null : !close(family.conversion_t28_pct, expectedCvr)) errors.push(`${family.family_asin}: family CVR not recomputed`);
      if (family.parent && family.primary_state === 'STRUCTURAL_PARENT') errors.push(`${family.family_asin}: structural parent used as diagnosis`);
      if ((family.members || []).some(x => x.product_role === 'STRUCTURAL_PARENT')) errors.push(`${family.family_asin}: structural parent leaked into members`);
    }
    const dimensionNames = Object.keys(data.dimensions || {});
    if ((data.summary?.amazon_dimension_coverage || 0) > 0 && !dimensionNames.length) errors.push('variation metadata exists but dimensional rollups are empty');
    for (const [dimension, rows] of Object.entries(data.dimensions || {})) for (const row of rows || []) {
      const sessions = Number(row.sessions_t28 || 0), units = Number(row.units_t28 || 0);
      const expected = sessions > 0 ? Math.round(10000 * units / sessions) / 100 : null;
      if (expected === null ? row.conversion_t28_pct != null : !close(row.conversion_t28_pct, expected)) errors.push(`${dimension}/${row.value}: dimensional CVR not recomputed`);
    }
    return { errors, dimensionNames, pairCount: (data.dimension_pairs || []).length };
  });
}

async function verifyCatalog(page) {
  await wait(page, '.family');
  const semantic = await catalogSemantic(page);
  if (semantic.errors?.length) throw new Error(`Catalog semantic QA: ${semantic.errors.join('; ')}`);
  const openCount = await page.locator('.family[open]').count();
  if (openCount) throw new Error(`Catalog default comparison view has ${openCount} family expansions open`);
}

async function verifyCatalogMode(page, mode) {
  await verifyCatalog(page);
  const semantic = await catalogSemantic(page);
  if (mode.startsWith('dimension:') && !semantic.dimensionNames?.includes(mode.split(':')[1])) throw new Error(`Catalog dimension ${mode.split(':')[1]} unavailable`);
  if (mode === 'pair' && !semantic.pairCount) throw new Error('Catalog variation-combination rollups unavailable');
  const button = page.locator(`button[data-mode="${mode}"]`);
  await button.waitFor({ state: 'visible', timeout: 5000 });
  await button.click();
  await wait(page, '.analysis-row');
}

async function verifyProductWorkspace(page) {
  await wait(page, '.hero-name');
  const payload = await page.evaluate(async () =>
    (await (await fetch('/api/product?sku=PNC-001', { cache: 'no-store' })).json()),
  );
  const expected = payload.profile?.product;
  if (payload.profile?.label_source !== 'mapping' || !expected)
    throw new Error(`Product mapped-name contract mismatch: ${payload.profile?.product || 'blank'} / ${payload.profile?.label_source || 'unknown source'}`);
  const renderedName = (await page.locator('.hero-name').textContent() || '').trim();
  if (renderedName !== expected)
    throw new Error(`Product hero canonical name mismatch: ${renderedName || 'blank'}`);
  if (await page.locator('script[src*="product-ads-context"]').count())
    throw new Error('Product loaded the superseded Ads post-render module');
  if (await page.locator('#ordersPanel[open]').count())
    throw new Error('Product order evidence is open by default');
  if (!payload.ads?.through_date || !Number(payload.ads?.observed_ads_days || 0)) {
    const adsState = (await page.locator('#adsState').textContent() || '').trim();
    const adsDecision = (await page.locator('#adsDecision').textContent() || '').trim();
    if (adsState !== 'Ads access pending' || adsDecision !== 'Ads integration ready')
      throw new Error(`Product Ads pending language mismatch: ${adsState} / ${adsDecision}`);
  }
}

async function assertFinanceChartMarks(page, label) {
  await wait(page, '#progression');
  const marks = await page.locator('#progression rect, #progression path, #progression line').count();
  if (!marks) throw new Error(`Finance ${label} rendered without chart marks`);
}

async function chooseClosedFinanceMonth(page) {
  const monthButton = page.locator('button[data-finance-window="month"]');
  await monthButton.click();
  await page.locator('button[data-finance-window="month"][aria-selected="true"]').waitFor({ state: 'visible', timeout: 5000 });
  await wait(page, '#monthPicker');
  const options = await page.locator('#monthPicker option').evaluateAll(items => items.map(item => ({ value: item.value, text: item.textContent || '' })));
  if (!options.length) throw new Error('Finance Month view has no accounting-month options');
  const closedOption = options.find(option => !option.text.includes('OPEN'));
  if (!closedOption) throw new Error('Finance Month view has no closed month available for immutable drill-down QA');
  await page.locator('#monthPicker').selectOption(closedOption.value);
  await assertFinanceChartMarks(page, 'closed month');
  const closedState = (await page.locator('#progressionState').textContent() || '').trim();
  if (!closedState || closedState.includes('OPEN')) throw new Error(`Finance closed-month drill-down has invalid state: ${closedState || 'blank'}`);
}

async function verifyFinanceWindows(page) {
  const buttons = ['3m', 'ytd', '12m', 'lastYear', 'all'];
  for (const windowKey of buttons) {
    const button = page.locator(`button[data-finance-window="${windowKey}"]`);
    await button.waitFor({ state: 'visible', timeout: 5000 });
    await button.click();
    await page.locator(`button[data-finance-window="${windowKey}"][aria-selected="true"]`).waitFor({ state: 'visible', timeout: 5000 });
    await assertFinanceChartMarks(page, windowKey);
  }

  await chooseClosedFinanceMonth(page);

  await page.locator('button[data-finance-window="ytd"]').click();
  await page.locator('button[data-finance-window="ytd"][aria-selected="true"]').waitFor({ state: 'visible', timeout: 5000 });
  const monthBar = page.locator('#progression [data-month]').first();
  await monthBar.waitFor({ state: 'visible', timeout: 5000 });
  await monthBar.click();
  await page.locator('button[data-finance-window="month"][aria-selected="true"]').waitFor({ state: 'visible', timeout: 5000 });
  await wait(page, '#monthPicker');
  await assertFinanceChartMarks(page, 'bar drill-down');

  // Return screenshots and downstream checks to the canonical default state.
  await page.locator('button[data-finance-window="ytd"]').click();
  await page.locator('button[data-finance-window="ytd"][aria-selected="true"]').waitFor({ state: 'visible', timeout: 5000 });
  await assertFinanceChartMarks(page, 'YTD restore');
}

async function verifyFinanceReport(page) {
  await wait(page, '#currentLines .finance-line');
  await wait(page, '#currentBridge .bridge-step');
  await wait(page, '#ytdBridge .bridge-step');
  await assertFinanceChartMarks(page, 'progression');
  await verifyFinanceWindows(page);
  // Desktop/tablet expose a table header, while mobile intentionally hides it
  // and presents the data rows as cards. Wait for canonical history data, not
  // the responsive header implementation.
  await wait(page, '#history .history-row:not(.head)');
}

async function verifyFinanceClosed(page) {
  await verifyFinanceReport(page);
  await chooseClosedFinanceMonth(page);
}

async function verifyFinanceEvidence(page) {
  await verifyFinanceReport(page);
  const evidence = page.locator('.finance-evidence details').first();
  await evidence.waitFor({ state: 'visible', timeout: 5000 });
  await evidence.locator('summary').click();
  await wait(page, '#events .event-row');
}

const scenarios = [
  ['today', '/today', ['mobile', 'desktop'], async p => { await wait(p, '#rhythm .dpp-bar'); await wait(p, '#dayPicker .day-choice'); }],
  ['today-wall', '/today?wall=1', ['desktop']],
  ['home', '/', ['mobile', 'tablet', 'desktop']],
  ['sales-overview', '/sales', ['mobile', 'tablet', 'desktop'], verifySalesOverview],
  ['sales-products', '/sales', ['mobile', 'desktop'], async p => { await p.locator('button[data-view="products"]').click(); await wait(p, '#skuRows tr'); }],
  ['sales-orders', '/sales', ['mobile', 'desktop'], async p => { await p.locator('button[data-view="orders"]').click(); await wait(p, '#orderRows tr'); }],
  ['catalog', '/catalog', ['mobile', 'tablet', 'desktop'], verifyCatalog],
  ['catalog-design', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'dimension:design')],
  ['catalog-ruling', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'dimension:ruling')],
  ['catalog-combinations', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'pair')],
  ['catalog-sku', '/catalog', ['mobile', 'desktop'], p => verifyCatalogMode(p, 'sku')],
  ['product-pnc-001', '/product?sku=PNC-001', ['mobile', 'desktop'], verifyProductWorkspace],
  ['inventory', '/inventory', ['mobile', 'tablet', 'desktop']],
  ['ads-overview', '/ads', ['mobile', 'tablet', 'desktop'], p => verifyAds(p)],
  ['ads-campaigns', '/ads', ['mobile', 'desktop'], p => verifyAds(p, 'campaigns')],
  ['finance-overview', '/finance', ['mobile', 'desktop'], verifyFinanceReport],
  ['finance-closed', '/finance', ['mobile', 'tablet', 'desktop'], verifyFinanceClosed],
  ['finance-ledger', '/finance', ['mobile', 'desktop'], verifyFinanceEvidence],
  ['trajectory', '/trajectory', ['mobile', 'desktop']],
  ['data-health', '/data-health', ['mobile', 'desktop']],
].map(([name, url, views, action]) => ({ name, url, views, action }));

await fs.mkdir(outDir, { recursive: true });
for (const entry of await fs.readdir(outDir)) await fs.rm(path.join(outDir, entry), { recursive: true, force: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const safeName = value => value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

for (const scenario of scenarios) for (const viewportName of scenario.views) {
  const viewport = viewports[viewportName];
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [], warnings = [], failedResponses = [];
  page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
  page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); if (msg.type() === 'warning') warnings.push(`console: ${msg.text()}`); });
  page.on('response', async response => { if (response.status() >= 400 && response.url().startsWith(baseUrl)) failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`); });
  const result = { scenario: scenario.name, viewport: viewportName, width: viewport.width, height: viewport.height, url: `${baseUrl}${scenario.url}`, screenshot: null, metrics: null, errors, warnings, failedResponses, ok: false };
  try {
    const response = await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!response?.ok()) throw new Error(`navigation returned ${response?.status() || 'no response'}`);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1000);
    if (scenario.action) { await scenario.action(page); await page.waitForTimeout(500); }
    result.metrics = await page.evaluate(({ viewportName }) => {
      const visible = el => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0; };
      const minFont = viewportName === 'mobile' ? 11.5 : viewportName === 'tablet' ? 10.5 : 9.5;
      const textEls = [...document.querySelectorAll('body *')].filter(el => visible(el) && !el.children.length && (el.textContent || '').trim());
      const smallText = textEls.filter(el => Number.parseFloat(getComputedStyle(el).fontSize || '0') < minFont).slice(0, 40);
      const clickables = [...document.querySelectorAll('a,button,[role="button"],input,select,textarea')].filter(visible);
      const smallTargets = clickables.filter(el => { const r = el.getBoundingClientRect(); return r.width < 36 || r.height < 36; }).slice(0, 40);
      const doc = document.documentElement, body = document.body, scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
      return { title: document.title, bodyTextLength: (body.innerText || '').length, activeTab: document.querySelector('.tabs button.active,.view-tabs button.active,.analysis-modes button.active')?.textContent?.trim() || null, scrollWidth, scrollHeight: Math.max(doc.scrollHeight, body.scrollHeight), horizontalOverflowPx: Math.max(0, scrollWidth - doc.clientWidth), smallTextCount: smallText.length, smallTapTargetCount: smallTargets.length };
    }, { viewportName });
    const fileName = `${safeName(scenario.name)}-${viewportName}.png`;
    await page.screenshot({ path: path.join(outDir, fileName), fullPage: true });
    result.screenshot = fileName;
    result.ok = !errors.length && !failedResponses.length;
  } catch (err) {
    errors.push(`qa: ${err.message}`);
    const fileName = `${safeName(scenario.name)}-${viewportName}-error.png`;
    await page.screenshot({ path: path.join(outDir, fileName), fullPage: true }).catch(() => {});
    result.screenshot = fileName;
  }
  results.push(result);
  await context.close();
}
await browser.close();

const summary = { generatedAt: new Date().toISOString(), baseUrl, captures: results.length, successfulCaptures: results.filter(x => x.ok).length, navigationFailures: results.filter(x => !x.ok).length, consoleErrorCount: results.reduce((n, x) => n + x.errors.length, 0), failedResponseCount: results.reduce((n, x) => n + x.failedResponses.length, 0), horizontalOverflowCaptures: results.filter(x => (x.metrics?.horizontalOverflowPx || 0) > 2).length, smallTextSignals: results.reduce((n, x) => n + (x.metrics?.smallTextCount || 0), 0), smallTapTargetSignals: results.reduce((n, x) => n + (x.metrics?.smallTapTargetCount || 0), 0), results };
await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
const lines = ['# DPP Visual QA', '', `Generated: ${summary.generatedAt}`, `Base URL: ${baseUrl}`, '', `**${summary.successfulCaptures}/${summary.captures} captures succeeded.**`, '', '| Screen | Viewport | Active tab | Overflow | Small text | Small tap targets | Browser errors |', '|---|---:|---|---:|---:|---:|---:|'];
for (const r of results) lines.push(`| ${r.scenario} | ${r.viewport} ${r.width}×${r.height} | ${r.metrics?.activeTab ?? '—'} | ${r.metrics?.horizontalOverflowPx ?? '—'}px | ${r.metrics?.smallTextCount ?? '—'} | ${r.metrics?.smallTapTargetCount ?? '—'} | ${r.errors.length} |`);
lines.push('', '## Signals', '', `- Horizontal overflow: ${summary.horizontalOverflowCaptures} capture(s)`, `- Small-text signals: ${summary.smallTextSignals}`, `- Small tap-target signals: ${summary.smallTapTargetSignals}`, `- Failed local HTTP responses: ${summary.failedResponseCount}`, `- Browser/page errors: ${summary.consoleErrorCount}`, '', '_Screenshots remain the source of truth for visual judgment._', '');
await fs.writeFile(path.join(outDir, 'report.md'), lines.join('\n'));
console.log(JSON.stringify({ captures: summary.captures, successful: summary.successfulCaptures, navigationFailures: summary.navigationFailures, overflowCaptures: summary.horizontalOverflowCaptures, smallTextSignals: summary.smallTextSignals, smallTapTargetSignals: summary.smallTapTargetSignals, failedResponses: summary.failedResponseCount, browserErrors: summary.consoleErrorCount }, null, 2));
if (summary.navigationFailures || summary.consoleErrorCount || summary.failedResponseCount) process.exitCode = 2;
