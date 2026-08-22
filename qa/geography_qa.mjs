import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });

try {
  const response = await page.goto(`${baseUrl}/sales`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (!response?.ok()) throw new Error(`Sales navigation returned ${response?.status() || 'no response'}`);

  const api = await page.evaluate(async () => {
    const r = await fetch('/api/sales', { cache: 'no-store' });
    return { status: r.status, body: await r.json() };
  });
  if (api.status !== 200) throw new Error(`Sales API ${api.status}`);
  const geo = api.body?.geography || {};
  const coverage = geo.coverage || {};
  if (!Array.isArray(geo.daily) || !geo.daily.length) throw new Error('Postal geography daily fact is empty');
  if (!Array.isArray(geo.sku_daily) || !geo.sku_daily.length) throw new Error('Postal SKU geography fact is empty');
  if (Number(coverage.orders_with_postal || 0) <= 0) throw new Error('No orders have postal geography');
  if (Number(coverage.postal_codes || 0) <= 0) throw new Error('No postal codes reported');
  if (Number(coverage.coverage_pct || 0) <= 0) throw new Error('Postal coverage is zero');

  const forbidden = ['recipient', 'buyername', 'buyer_name', 'addressline', 'address_line', 'phone', 'deliveryinstruction'];
  const keys = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      keys.push(String(key).toLowerCase());
      walk(child);
    }
  };
  walk(geo);
  const leaked = forbidden.filter(word => keys.some(key => key.includes(word)));
  if (leaked.length) throw new Error(`Geography payload exposes forbidden PII-shaped keys: ${leaked.join(', ')}`);

  await page.locator('button[data-view="geography"]').click();
  await page.locator('#geography.view.active').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#geoRankedRows tr').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#geoMap path.state-shape').first().waitFor({ state: 'visible', timeout: 15000 });

  const rendered = await page.evaluate(() => ({
    coverage: document.getElementById('geoCoverage')?.textContent?.trim() || '',
    rankedRows: document.querySelectorAll('#geoRankedRows tr').length,
    stateShapes: document.querySelectorAll('#geoMap path.state-shape').length,
    kpis: [...document.querySelectorAll('#geoKpis .geo-kpi strong')].map(x => x.textContent?.trim() || ''),
  }));
  if (!rendered.coverage.includes('orders geocoded')) throw new Error(`Coverage copy not rendered: ${rendered.coverage}`);
  if (rendered.rankedRows <= 0 || rendered.stateShapes < 30) throw new Error(`Geography rendering incomplete: ${JSON.stringify(rendered)}`);
  if (rendered.kpis.length !== 4) throw new Error(`Expected four geography KPIs, got ${rendered.kpis.length}`);
  if (errors.length) throw new Error(errors.join('; '));

  await page.screenshot({ path: path.join(outDir, 'sales-geography-desktop.png'), fullPage: true });
  await fs.writeFile(path.join(outDir, 'geography-summary.json'), JSON.stringify({ ok: true, coverage, rendered }, null, 2));
  console.log(JSON.stringify({ ok: true, coverage, rendered }));
} catch (err) {
  await page.screenshot({ path: path.join(outDir, 'sales-geography-error.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(outDir, 'geography-summary.json'), JSON.stringify({ ok: false, error: err.message, errors }, null, 2));
  console.error(err);
  await browser.close();
  process.exit(1);
}

await browser.close();
