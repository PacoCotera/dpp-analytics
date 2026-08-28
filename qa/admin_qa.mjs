import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
const password = process.env.DPP_ADMIN_PASSWORD || '';
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
page.on('console', message => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});

try {
  if (password.length < 16) throw new Error('DPP_ADMIN_PASSWORD was not provided to Admin browser QA');
  const response = await page.goto(`${baseUrl}/admin`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (!response?.ok()) throw new Error(`Admin navigation returned ${response?.status() || 'no response'}`);
  await page.locator('#loginPanel').waitFor({ state: 'visible', timeout: 5000 });

  const unauthenticated = await page.evaluate(async () => {
    const session = await fetch('/api/admin/session', { cache: 'no-store' });
    const protectedResponse = await fetch('/api/admin/catalog', { cache: 'no-store' });
    return {
      sessionStatus: session.status,
      session: await session.json(),
      protectedStatus: protectedResponse.status,
    };
  });
  if (
    unauthenticated.sessionStatus !== 200 ||
    unauthenticated.session.authenticated !== false ||
    unauthenticated.session.configured !== true ||
    unauthenticated.protectedStatus !== 401
  ) {
    throw new Error(`Unauthenticated Admin contract failed: ${JSON.stringify(unauthenticated)}`);
  }

  await page.locator('#password').fill(password);
  await page.locator('#loginForm button[type="submit"]').click();
  await page.locator('.product-editor').first().waitFor({ state: 'visible', timeout: 30000 });

  const loaded = await page.evaluate(async () => {
    const response = await fetch('/api/admin/catalog', { cache: 'no-store' });
    return { status: response.status, payload: await response.json() };
  });
  if (loaded.status !== 200 || !loaded.payload.current_products?.length) {
    throw new Error(`Authenticated Admin catalog did not load: ${loaded.status}`);
  }
  const product = loaded.payload.current_products[0];
  if (!product.sku || !product.asin || !product.source_title || product.lifecycle !== 'CURRENT') {
    throw new Error(`Current catalog evidence is incomplete: ${JSON.stringify({ sku: product.sku, asin: product.asin, lifecycle: product.lifecycle })}`);
  }
  if (!Array.isArray(loaded.payload.deleted_products)) throw new Error('Deleted SKU history is not explicit');

  const editor = page.locator('.product-editor').first();
  await editor.locator('.admin-save').click();
  await page.waitForFunction(() => {
    const value = document.querySelector('.product-editor .product-save-status')?.textContent?.trim();
    return value === 'No changes' || value === 'Saved';
  }, null, { timeout: 30000 });
  const saveStatus = await page.locator('.product-editor .product-save-status').first().textContent();
  if (saveStatus?.trim() !== 'No changes') {
    throw new Error(`Non-destructive Admin save unexpectedly changed configuration: ${saveStatus}`);
  }

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.locator('.product-editor').first().waitFor({ state: 'visible', timeout: 30000 });
  const consumption = await page.evaluate(async sku => {
    const [adminResponse, catalogResponse] = await Promise.all([
      fetch('/api/admin/catalog', { cache: 'no-store' }),
      fetch('/api/catalog?refresh=1', { cache: 'no-store' }),
    ]);
    const admin = await adminResponse.json();
    const catalog = await catalogResponse.json();
    return {
      adminStatus: adminResponse.status,
      catalogStatus: catalogResponse.status,
      configured: admin.current_products.find(row => row.sku === sku),
      consumed: catalog.products.find(row => row.sku === sku),
    };
  }, product.sku);
  const configured = consumption.configured;
  const consumed = consumption.consumed;
  if (consumption.adminStatus !== 200 || consumption.catalogStatus !== 200 || !configured || !consumed) {
    throw new Error(`Saved configuration was not reloadable: ${JSON.stringify({ adminStatus: consumption.adminStatus, catalogStatus: consumption.catalogStatus })}`);
  }
  const expectedName = configured.config.label.name || configured.source_title;
  if (consumed.product !== expectedName) {
    throw new Error(`Catalog short-name consumption mismatch for ${product.sku}`);
  }
  if ((consumed.unit_cogs ?? null) !== (configured.config.cogs.unit_cogs ?? null)) {
    throw new Error(`Catalog COGS consumption mismatch for ${product.sku}`);
  }
  if ((consumed.family_name ?? null) !== (configured.config.taxonomy.family_name ?? null)) {
    throw new Error(`Catalog family-name consumption mismatch for ${product.sku}`);
  }
  for (const [dimension, value] of Object.entries(configured.config.taxonomy.attributes || {})) {
    if (consumed.variation_attributes?.[dimension] !== value) {
      throw new Error(`Catalog taxonomy consumption mismatch for ${product.sku}/${dimension}`);
    }
  }

  await page.locator('#logout').click();
  await page.locator('#loginPanel').waitFor({ state: 'visible', timeout: 5000 });
  const deniedAfterLogout = await page.evaluate(async () =>
    (await fetch('/api/admin/catalog', { cache: 'no-store' })).status
  );
  if (deniedAfterLogout !== 401) throw new Error(`Admin session survived logout: ${deniedAfterLogout}`);
  if (errors.length) throw new Error(errors.join('; '));

  const summary = {
    ok: true,
    build: (await page.locator('.footer-build').textContent())?.trim(),
    unauthenticatedDenial: unauthenticated.protectedStatus,
    currentProducts: loaded.payload.summary.current,
    needsConfiguration: loaded.payload.summary.needs_configuration,
    deletedHistory: loaded.payload.summary.deleted_history,
    sourceEvidencePresent: true,
    noOpSave: saveStatus.trim(),
    reloadAndCatalogConsumption: true,
    logoutDenial: deniedAfterLogout,
  };
  await fs.writeFile(path.join(outDir, 'admin-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (error) {
  const summary = { ok: false, error: error.message, errors };
  await fs.writeFile(path.join(outDir, 'admin-summary.json'), JSON.stringify(summary, null, 2));
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
