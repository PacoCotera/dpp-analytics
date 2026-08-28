import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });

try {
  await page.goto(`${baseUrl}/inventory`, { waitUntil: 'networkidle', timeout: 20000 });
  const payloads = await page.evaluate(async () => {
    const [inventory, catalog] = await Promise.all([fetch('/api/inventory'), fetch('/api/catalog')]);
    return { inventory: await inventory.json(), catalog: await catalog.json() };
  });
  const rows = payloads.inventory.rows || [];
  const current = rows.filter(row => row.inventory_lifecycle === 'CURRENT_OFFER');
  const defaults = rows.filter(row => row.is_default_inventory);
  const catalogSkus = (payloads.catalog.products || []).filter(row => row.is_offer_owner && ['SELLABLE_VARIATION', 'SELLABLE_STANDALONE'].includes(row.product_role) && row.catalog_membership === 'CURRENT_OFFER').map(row => row.sku).sort();
  if (JSON.stringify(current.map(row => row.sku).sort()) !== JSON.stringify(catalogSkus)) throw new Error('Inventory current offers differ from Catalog');
  if (new Set(defaults.map(row => row.canonical_sku)).size !== defaults.length) throw new Error('Default inventory duplicates a canonical SKU');
  const available = current.reduce((sum, row) => sum + Number(row.available || 0), 0);
  if (available !== Number(payloads.inventory.summary?.available || 0)) throw new Error(`Current available stock does not reconcile: ${available}`);
  const defaultRendered = await page.locator('#rows tr').evaluateAll(items => items.map(row => row.querySelector('.product-sku')?.textContent?.trim()).filter(Boolean));
  if (JSON.stringify(defaultRendered.sort()) !== JSON.stringify(defaults.map(row => row.sku).sort())) throw new Error(`Default table is not current stock-bearing scope: ${JSON.stringify(defaultRendered)}`);

  const filters = { alias: 'ALIAS', retired: 'RETIRED', archived: 'ARCHIVED', no_velocity: null };
  const filterResults = {};
  for (const [filter, lifecycle] of Object.entries(filters)) {
    await page.locator(`[data-filter="${filter}"]`).click();
    const visible = await page.locator('#rows tr').count();
    const expected = lifecycle ? rows.filter(row => row.inventory_lifecycle === lifecycle).length : rows.filter(row => !row.has_velocity).length;
    if (visible !== expected) throw new Error(`${filter} filter rendered ${visible}, expected ${expected}`);
    filterResults[filter] = visible;
  }
  const state = await page.evaluate(() => ({
    scope: document.getElementById('inventoryRecordScope')?.textContent?.trim() || '',
    headers: [...document.querySelectorAll('.inventory-table th')].map(node => node.textContent?.trim()),
    overflow: document.documentElement.scrollWidth - innerWidth,
  }));
  if (!state.headers.includes('Lifecycle') || !state.headers.includes('Canonical SKU')) throw new Error('Inventory identity columns are missing');
  if (!state.scope.includes('current stock-bearing offers shown by default')) throw new Error(`Inventory scope is not disclosed: ${state.scope}`);
  if (state.overflow > 1 || errors.length) throw new Error(`Inventory browser errors: ${JSON.stringify({ state, errors })}`);
  const summary = { ok: true, currentOffers: current.length, defaultRows: defaults.length, recordScope: payloads.inventory.record_scope, filterResults, state };
  await fs.writeFile(path.join(outDir, 'inventory-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (error) {
  await fs.writeFile(path.join(outDir, 'inventory-summary.json'), JSON.stringify({ ok: false, error: error.message, errors }, null, 2));
  console.error(error);
  await browser.close();
  process.exit(1);
}
await browser.close();
