import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); });

const zoomState = () => page.evaluate(() => {
  const svg = document.getElementById('geoMap');
  const transform = svg?.__zoom;
  const layer = svg?.querySelector(':scope > g.geo-map-zoom-layer');
  return {
    k: Number(transform?.k || 1),
    x: Number(transform?.x || 0),
    y: Number(transform?.y || 0),
    layerTransform: layer?.getAttribute('transform') || '',
    mode: svg?.dataset.zoomMode || '',
    ready: svg?.dataset.zoomReady || '',
    touchAction: svg ? getComputedStyle(svg).touchAction : '',
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
  };
});

try {
  const response = await page.goto(`${baseUrl}/sales`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (!response?.ok()) throw new Error(`Sales navigation returned ${response?.status() || 'no response'}`);

  await page.locator('button[data-view="geography"]').click();
  await page.locator('#geography.view.active').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#geoMap path.state-shape').first().waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('#geoMap > g.geo-map-zoom-layer').waitFor({ state: 'attached', timeout: 5000 });

  for (const id of ['geoZoomOut', 'geoZoomReset', 'geoZoomIn']) {
    if (await page.locator(`#${id}`).count() !== 1) throw new Error(`Missing map zoom control #${id}`);
  }

  const initial = await zoomState();
  if (initial.ready !== '1' || initial.mode !== 'national') throw new Error(`National zoom layer not initialized: ${JSON.stringify(initial)}`);
  if (Math.abs(initial.k - 1) > 0.01) throw new Error(`National map did not start fitted at 1x: ${JSON.stringify(initial)}`);
  if (initial.touchAction !== 'none') throw new Error(`Map touch gestures are not locally owned: ${initial.touchAction}`);
  if (initial.pageOverflow > 1) throw new Error(`Geography page overflows before zoom by ${initial.pageOverflow}px`);

  await page.locator('#geoZoomIn').click();
  await page.waitForFunction(() => Number(document.getElementById('geoMap')?.__zoom?.k || 1) > 1.2, null, { timeout: 3000 });
  const buttonZoom = await zoomState();
  if (buttonZoom.k <= 1.2 || !/scale\(/.test(buttonZoom.layerTransform)) throw new Error(`Zoom-in button did not transform map layer: ${JSON.stringify(buttonZoom)}`);

  const box = await page.locator('#geoMap').boundingBox();
  if (!box) throw new Error('Map bounding box unavailable for pan test');
  const cx = box.x + box.width * 0.52;
  const cy = box.y + box.height * 0.54;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 55, cy + 30, { steps: 8 });
  await page.mouse.up();
  const panned = await zoomState();
  if (Math.abs(panned.x - buttonZoom.x) < 2 && Math.abs(panned.y - buttonZoom.y) < 2) throw new Error(`Drag pan did not move the zoom transform: ${JSON.stringify({ before: buttonZoom, after: panned })}`);
  if (!(await page.locator('#geoBack').isHidden())) throw new Error('Dragging the national map accidentally triggered state drill-down');

  await page.locator('#geoZoomReset').click();
  await page.waitForFunction(() => Math.abs(Number(document.getElementById('geoMap')?.__zoom?.k || 1) - 1) < 0.01, null, { timeout: 3000 });
  const reset = await zoomState();
  if (Math.abs(reset.x) > 1 || Math.abs(reset.y) > 1) throw new Error(`Reset did not return map to fitted origin: ${JSON.stringify(reset)}`);

  await page.locator('#geoMap').hover();
  await page.mouse.wheel(0, -420);
  await page.waitForFunction(() => Number(document.getElementById('geoMap')?.__zoom?.k || 1) > 1.05, null, { timeout: 3000 });
  const wheelZoom = await zoomState();
  if (wheelZoom.k <= 1.05) throw new Error(`Wheel/trackpad zoom did not change scale: ${JSON.stringify(wheelZoom)}`);
  await page.locator('#geoZoomReset').click();
  await page.waitForFunction(() => Math.abs(Number(document.getElementById('geoMap')?.__zoom?.k || 1) - 1) < 0.01, null, { timeout: 3000 });

  await page.locator('#geoStateSelect').selectOption('15');
  await page.locator('#geoMap path.postal-shape').first().waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('#geoMap > g.geo-map-zoom-layer').waitFor({ state: 'attached', timeout: 5000 });
  await page.waitForFunction(() => document.getElementById('geoMap')?.dataset.zoomMode === 'postal', null, { timeout: 5000 });
  const postalInitial = await zoomState();
  if (postalInitial.mode !== 'postal' || Math.abs(postalInitial.k - 1) > 0.01) throw new Error(`Postal drill-down did not reset/fitted zoom: ${JSON.stringify(postalInitial)}`);

  await page.locator('#geoZoomIn').click();
  await page.waitForFunction(() => Number(document.getElementById('geoMap')?.__zoom?.k || 1) > 1.2, null, { timeout: 3000 });
  const postalZoom = await zoomState();
  if (postalZoom.k <= 1.2) throw new Error(`Postal zoom-in failed: ${JSON.stringify(postalZoom)}`);
  if (postalZoom.pageOverflow > 1) throw new Error(`Postal zoom caused page overflow by ${postalZoom.pageOverflow}px`);

  await page.locator('#geoZoomReset').click();
  await page.waitForFunction(() => Math.abs(Number(document.getElementById('geoMap')?.__zoom?.k || 1) - 1) < 0.01, null, { timeout: 3000 });
  if (errors.length) throw new Error(errors.join('; '));

  const summary = { ok: true, initial, buttonZoom, panned, reset, wheelZoom, postalInitial, postalZoom };
  await page.screenshot({ path: path.join(outDir, 'sales-geography-zoom.png'), fullPage: true });
  await fs.writeFile(path.join(outDir, 'geography-zoom-summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
} catch (err) {
  await page.screenshot({ path: path.join(outDir, 'sales-geography-zoom-error.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(outDir, 'geography-zoom-summary.json'), JSON.stringify({ ok: false, error: err.message, errors }, null, 2));
  console.error(err);
  await browser.close();
  process.exit(1);
}

await browser.close();
