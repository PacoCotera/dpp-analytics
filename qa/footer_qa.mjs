import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const routes = [
  '/',
  '/today',
  '/sales',
  '/catalog',
  '/inventory',
  '/finance',
  '/trajectory',
  '/ads',
  '/data-health',
  '/admin',
  '/product?sku=PNC-001',
];

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const results = [];

for (const route of routes) {
  const errors = [];
  try {
    const response = await page.goto(baseUrl + route, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (!response?.ok()) throw new Error(`navigation ${response?.status() || 'failed'}`);
    await page.locator('footer.footer').waitFor({ state: 'visible', timeout: 5000 });
    const footerCount = await page.locator('footer.footer').count();
    if (footerCount !== 1) errors.push(`expected one shared footer, found ${footerCount}`);
    const stampCount = await page.locator('footer.footer .footer-build').count();
    if (stampCount !== 1) errors.push(`expected one footer build stamp, found ${stampCount}`);
    const stamp = ((await page.locator('footer.footer .footer-build').textContent()) || '').trim();
    if (!/^main [0-9a-f]{8}$/i.test(stamp)) errors.push(`invalid build stamp: ${JSON.stringify(stamp)}`);
  } catch (error) {
    errors.push(error.message);
  }
  results.push({ route, ok: errors.length === 0, errors });
}

await browser.close();
await fs.writeFile(path.join(outDir, 'footer-summary.json'), JSON.stringify({ baseUrl, results }, null, 2));
console.log(JSON.stringify({ footerQA: results }, null, 2));
if (results.some((result) => !result.ok)) process.exitCode = 4;
