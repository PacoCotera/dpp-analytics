import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const SEEDED_MAPPED_SKUS = new Set(['PNC-001', 'PNC-001B', 'PNC-004', 'PNC-004B', 'PNC-005', 'BLC-001']);

function validateProductRow(location, row, results) {
  if (!row || typeof row !== 'object' || !('product' in row)) return;
  const sku = String(row.sku || '');
  const source = String(row.label_source || '');
  if (!['mapping', 'data_stream', 'sku_fallback'].includes(source)) {
    throw new Error(`${location}: ${sku || 'unknown SKU'} bypassed the shared product-name resolver`);
  }
  if (source === 'data_stream' && row.product !== row.catalog_title) {
    throw new Error(`${location}: ${sku} altered the upstream product name`);
  }
  if (source === 'sku_fallback' && row.product !== sku) {
    throw new Error(`${location}: ${sku} has an invalid final SKU fallback`);
  }
  if (!String(row.product || '').trim()) {
    throw new Error(`${location}: ${sku || 'unknown SKU'} has a blank product name`);
  }
  results.rows += 1;
  results.sources[source] = (results.sources[source] || 0) + 1;
  results.skus.add(sku);
}

function validateRows(location, rows, results) {
  for (const [index, row] of (rows || []).entries()) validateProductRow(`${location}[${index}]`, row, results);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const summary = { ok: false, rows: 0, sources: {}, skus: new Set(), endpoints: [] };

try {
  await page.goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const payloads = await page.evaluate(async () => {
    const urls = ['/api/home', '/api/today', '/api/sales', '/api/catalog', '/api/inventory', '/api/ads'];
    const entries = await Promise.all(urls.map(async url => {
      const response = await fetch(url, { cache: 'no-store' });
      return [url, response.status, await response.json()];
    }));
    return Object.fromEntries(entries.map(([url, status, body]) => [url, { status, body }]));
  });

  for (const [url, response] of Object.entries(payloads)) {
    if (response.status !== 200) throw new Error(`${url} returned ${response.status}`);
    summary.endpoints.push(url);
  }

  const home = payloads['/api/home'].body;
  validateRows('home.inventory', home.inventory, summary);
  validateRows('home.movers', home.movers, summary);
  validateRows('home.weekly_products', home.weekly_products, summary);

  const today = payloads['/api/today'].body;
  validateRows('today.sku_today', today.sku_today, summary);
  validateRows('today.recent_orders', today.recent_orders, summary);
  for (const [index, order] of (today.recent_orders || []).entries()) validateRows(`today.recent_orders[${index}].items`, order.items, summary);
  for (const [index, order] of (today.open_orders || []).entries()) validateRows(`today.open_orders[${index}].items`, order.items, summary);

  const sales = payloads['/api/sales'].body;
  validateRows('sales.skus', sales.skus, summary);
  validateRows('sales.geography.products', sales.geography?.products, summary);
  for (const [index, order] of (sales.orders || []).entries()) validateRows(`sales.orders[${index}].order_items`, order.order_items, summary);

  const catalog = payloads['/api/catalog'].body;
  validateRows('catalog.products', catalog.products, summary);
  validateRows('catalog.deleted_products', catalog.deleted_products, summary);

  const inventory = payloads['/api/inventory'].body;
  validateRows('inventory.rows', inventory.rows, summary);

  const ads = payloads['/api/ads'].body;
  if (ads.status === 'ready') validateRows('ads.products', ads.products, summary);

  const mappedCatalog = new Map((catalog.products || []).map(row => [String(row.sku || ''), row]));
  for (const sku of SEEDED_MAPPED_SKUS) {
    const row = mappedCatalog.get(sku);
    if (!row) continue;
    if (row.label_source !== 'mapping') {
      throw new Error(`${sku}: expected the seller mapping, got “${row.product || ''}” from ${row.label_source || 'unknown source'}`);
    }
  }

  const productResponse = await page.evaluate(async () => {
    const response = await fetch('/api/product?sku=PNC-001', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  if (productResponse.status !== 200) throw new Error(`/api/product returned ${productResponse.status}`);
  summary.endpoints.push('/api/product');
  validateProductRow('product.profile', productResponse.body.profile, summary);
  validateProductRow('product.commercial', productResponse.body.commercial, summary);
  validateRows('product.family_variations', productResponse.body.family_variations, summary);

  await page.goto(`${baseUrl}/product?sku=PNC-001`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForFunction(
    expected => document.querySelector('.hero-name')?.textContent?.trim() === expected,
    productResponse.body.profile.product,
    { timeout: 15000 }
  );
  const heroName = (await page.locator('.hero-name').textContent() || '').trim();
  if (heroName !== productResponse.body.profile.product) {
    throw new Error(`Product hero did not render the mapped short name: ${heroName || 'blank'}`);
  }

  const auditedProductResponse = await page.evaluate(async () => {
    const response = await fetch('/api/product?sku=PNC-001L', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  if (auditedProductResponse.status !== 200)
    throw new Error(`/api/product?sku=PNC-001L returned ${auditedProductResponse.status}`);
  const auditedIdentity = auditedProductResponse.body.commercial?.identity || {};
  await page.goto(`${baseUrl}/product?sku=PNC-001L`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.locator('.product-health__facts').waitFor({ state: 'visible', timeout: 15000 });
  const renderedFamilyIdentity = await page.evaluate(() => {
    const facts = [...document.querySelectorAll('.product-health__fact')];
    const family = facts.find(fact => fact.querySelector('.label')?.textContent?.trim() === 'Family');
    return {
      label: family?.querySelector('strong')?.textContent?.trim() || '',
      role: family?.querySelector('small')?.textContent?.trim() || '',
    };
  });
  if (
    auditedIdentity.kind !== 'CHILD_VARIATION' ||
    renderedFamilyIdentity.label !== auditedIdentity.family_label ||
    renderedFamilyIdentity.role !== 'SELLABLE_VARIATION' ||
    /standalone/i.test(renderedFamilyIdentity.label)
  ) {
    throw new Error(
      `PNC-001L rendered contradictory family identity: ${JSON.stringify({ auditedIdentity, renderedFamilyIdentity })}`,
    );
  }
  summary.auditedProductIdentity = auditedIdentity;
  summary.renderedFamilyIdentity = renderedFamilyIdentity;

  await page.goto(`${baseUrl}/catalog`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.locator('.family').first().waitFor({ state: 'visible', timeout: 15000 });
  const renderedFamilyNames = await page.locator('.family-name').allTextContents();
  const expectedFamilyNames = (catalog.families || []).map(family => String(family.name || '')).filter(Boolean);
  if (JSON.stringify(renderedFamilyNames) !== JSON.stringify(expectedFamilyNames)) {
    throw new Error('Catalog altered one or more family names after the API resolved them');
  }

  const deletedPnc = (catalog.deleted_products || []).find(row => row.sku === 'PNC-CURRENT');
  if (!deletedPnc || deletedPnc.status !== 'Deleted' || deletedPnc.catalog_membership !== 'DELETED') {
    throw new Error(`PNC-CURRENT is not retained as explicit deleted history: ${JSON.stringify(deletedPnc)}`);
  }
  if ((catalog.products || []).some(row => row.sku === 'PNC-CURRENT')) {
    throw new Error('PNC-CURRENT leaked into the current Catalog product collection');
  }

  await page.getByRole('button', { name: 'Deleted', exact: true }).click();
  await page.getByText('PNC-CURRENT', { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 });
  const deletedMode = await page.evaluate(() => ({
    source: document.querySelector('#modeSource')?.textContent?.trim() || '',
    currentPncLinks: [...document.querySelectorAll('#portfolio a')].filter(link =>
      (link.textContent || '').includes('PNC-CURRENT'),
    ).length,
    deletedLabels: [...document.querySelectorAll('#portfolio .state-DELETED strong')].map(node =>
      node.textContent?.trim(),
    ),
  }));
  if (
    !deletedMode.source.startsWith('Deleted =') ||
    deletedMode.currentPncLinks !== 1 ||
    !deletedMode.deletedLabels.every(label => label === 'Deleted')
  ) {
    throw new Error(`Deleted Catalog mode is not explicit: ${JSON.stringify(deletedMode)}`);
  }

  const deletedProductResponse = await page.evaluate(async () => {
    const response = await fetch('/api/product?sku=PNC-CURRENT', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  if (
    deletedProductResponse.status !== 200 ||
    deletedProductResponse.body.profile?.listing_status !== 'Deleted' ||
    deletedProductResponse.body.commercial?.catalog_membership !== 'DELETED' ||
    deletedProductResponse.body.commercial?.listing_sellable !== false
  ) {
    throw new Error(`Deleted Product contract failed: ${JSON.stringify(deletedProductResponse)}`);
  }
  await page.goto(`${baseUrl}/product?sku=PNC-CURRENT`, {
    waitUntil: 'networkidle',
    timeout: 20000,
  });
  await page.locator('#healthHeadline').waitFor({ state: 'visible', timeout: 10000 });
  const deletedProductUi = await page.evaluate(() => {
    const fact = [...document.querySelectorAll('.product-health__fact')].find(
      item => item.querySelector('.label')?.textContent?.trim() === 'Listing',
    );
    const parentFact = [...document.querySelectorAll('.product-health__fact')].find(
      item => item.querySelector('.label')?.textContent?.trim() === 'Parent ASIN',
    );
    return {
      headline: document.querySelector('#healthHeadline')?.childNodes?.[0]?.textContent?.trim() || '',
      explanation: document.querySelector('#healthRead')?.textContent?.trim() || '',
      listing: {
        value: fact?.querySelector('strong')?.textContent?.trim() || '',
        note: fact?.querySelector('small')?.textContent?.trim() || '',
      },
      parentNote: parentFact?.querySelector('small')?.textContent?.trim() || '',
      variationNote: document.querySelector('#variationNote')?.textContent?.trim() || '',
      inventoryDecision: document.querySelector('#invDecision')?.textContent?.trim() || '',
      economicsDecision: document.querySelector('#econDecision')?.textContent?.trim() || '',
      adsDecision: document.querySelector('#adsDecision')?.textContent?.trim() || '',
    };
  });
  if (
    deletedProductUi.headline !== 'Deleted' ||
    deletedProductUi.explanation !== 'Absent from the latest Amazon seller-catalog snapshot' ||
    deletedProductUi.listing.value !== 'Deleted' ||
    !deletedProductUi.listing.note.startsWith('Last Amazon status ') ||
    deletedProductUi.parentNote !== 'historical relationship unavailable' ||
    deletedProductUi.variationNote !== 'not a current offer' ||
    deletedProductUi.inventoryDecision !== 'No current inventory decision.' ||
    deletedProductUi.economicsDecision !== 'Historical record' ||
    deletedProductUi.adsDecision !== 'No current Ads decision'
  ) {
    throw new Error(`Deleted Product UI is ambiguous: ${JSON.stringify(deletedProductUi)}`);
  }
  summary.deletedCatalog = {
    sku: deletedPnc.sku,
    sourceStatus: deletedPnc.source_listing_status,
    deletedProductUi,
  };

  summary.ok = true;
  summary.skus = [...summary.skus].filter(Boolean).sort();
  await fs.writeFile(path.join(outDir, 'product-naming-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`PRODUCT_NAMING rows=${summary.rows} mapped=${summary.sources.mapping || 0} upstream=${summary.sources.data_stream || 0} sku_fallback=${summary.sources.sku_fallback || 0}`);
} catch (error) {
  summary.error = error.message;
  summary.skus = [...summary.skus].filter(Boolean).sort();
  await fs.writeFile(path.join(outDir, 'product-naming-summary.json'), JSON.stringify(summary, null, 2));
  console.error(error);
  await browser.close();
  process.exit(1);
}

await browser.close();
