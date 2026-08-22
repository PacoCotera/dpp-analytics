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

  const references = Array.isArray(geo.postal_reference) ? geo.postal_reference : [];
  if (!references.length) throw new Error('SEPOMEX postal reference dictionary is empty');
  const namedReferences = references.filter(ref =>
    String(ref?.municipality_name || ref?.city_name || '').trim() ||
    (Array.isArray(ref?.settlements) && ref.settlements.some(value => String(value || '').trim()))
  );
  if (!namedReferences.length) throw new Error('Postal reference dictionary has no human-readable place names');

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

  const national = await page.evaluate(() => {
    const scroll = document.querySelector('.geo-ranked-panel .data-table-scroll');
    return {
      coverage: document.getElementById('geoCoverage')?.textContent?.trim() || '',
      rankedRows: document.querySelectorAll('#geoRankedRows tr').length,
      stateShapes: document.querySelectorAll('#geoMap path.state-shape').length,
      kpis: [...document.querySelectorAll('#geoKpis .geo-kpi strong')].map(x => x.textContent?.trim() || ''),
      headerColumns: document.querySelectorAll('.geo-table thead th').length,
      tableOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 999,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  if (!national.coverage.includes('orders geocoded')) throw new Error(`Coverage copy not rendered: ${national.coverage}`);
  if (national.rankedRows <= 0 || national.stateShapes < 30) throw new Error(`Geography rendering incomplete: ${JSON.stringify(national)}`);
  if (national.kpis.length !== 4) throw new Error(`Expected four geography KPIs, got ${national.kpis.length}`);
  if (national.headerColumns !== 5) throw new Error(`Expected five compact geography columns, got ${national.headerColumns}`);
  if (national.tableOverflow > 1) throw new Error(`Geography ranked table horizontally overflows by ${national.tableOverflow}px`);
  if (national.pageOverflow > 1) throw new Error(`Geography page horizontally overflows by ${national.pageOverflow}px`);

  await page.screenshot({ path: path.join(outDir, 'sales-geography-desktop.png'), fullPage: true });

  const firstState = page.locator('#geoRankedRows tr[data-state]').first();
  if (!(await firstState.count())) throw new Error('No mapped state is available for postal drill-down');
  await firstState.click();
  await page.locator('#geoMap path.postal-shape').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForFunction(() => /active postal polygons mapped/.test(document.getElementById('geoMapStatus')?.textContent || ''), null, { timeout: 60000 });
  await page.locator('#geoRankedRows .geo-area-cell small').first().waitFor({ state: 'visible', timeout: 8000 });

  const postal = await page.evaluate(() => {
    const scroll = document.querySelector('.geo-ranked-panel .data-table-scroll');
    const label = document.querySelector('#geoRankedRows .geo-area-cell small')?.textContent?.trim() || '';
    const status = document.getElementById('geoMapStatus')?.textContent?.trim() || '';
    const match = status.match(/(\d+)\/(\d+) active postal polygons mapped/);
    return {
      status,
      matched: match ? Number(match[1]) : 0,
      requested: match ? Number(match[2]) : 0,
      postalShapes: document.querySelectorAll('#geoMap path.postal-shape').length,
      contextShapes: document.querySelectorAll('#geoMap path.geo-state-context').length,
      placeLabel: label,
      tableOverflow: scroll ? scroll.scrollWidth - scroll.clientWidth : 999,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  if (postal.matched <= 0 || postal.postalShapes <= 0) throw new Error(`Postal polygons did not map: ${JSON.stringify(postal)}`);
  if (!postal.placeLabel || /^CP\s*\d+$/i.test(postal.placeLabel)) throw new Error(`Postal place dictionary did not render a useful label: ${JSON.stringify(postal.placeLabel)}`);
  if (postal.tableOverflow > 1) throw new Error(`Postal ranked table horizontally overflows by ${postal.tableOverflow}px`);
  if (postal.pageOverflow > 1) throw new Error(`Postal drill-down page horizontally overflows by ${postal.pageOverflow}px`);
  if (errors.length) throw new Error(errors.join('; '));

  await page.screenshot({ path: path.join(outDir, 'sales-geography-postal-desktop.png'), fullPage: true });
  await fs.writeFile(path.join(outDir, 'geography-summary.json'), JSON.stringify({ ok: true, coverage, referenceCount: references.length, national, postal }, null, 2));
  console.log(JSON.stringify({ ok: true, coverage, referenceCount: references.length, national, postal }));
} catch (err) {
  await page.screenshot({ path: path.join(outDir, 'sales-geography-error.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(outDir, 'geography-summary.json'), JSON.stringify({ ok: false, error: err.message, errors }, null, 2));
  console.error(err);
  await browser.close();
  process.exit(1);
}

await browser.close();
