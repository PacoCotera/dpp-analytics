import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';

const viewports = {
  mobile: { width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  tablet: { width: 1024, height: 768, isMobile: false, hasTouch: true, deviceScaleFactor: 1 },
  desktop: { width: 1600, height: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
};

const scenarios = [
  { name: 'home', url: '/', views: ['mobile', 'tablet', 'desktop'] },
  { name: 'sales-overview', url: '/sales', views: ['mobile', 'tablet', 'desktop'] },
  { name: 'sales-sku-performance', url: '/sales', views: ['mobile', 'desktop'], action: async page => page.locator('button[data-view="skus"]').click() },
  { name: 'sales-orders', url: '/sales', views: ['mobile', 'desktop'], action: async page => page.locator('button[data-view="orders"]').click() },
  { name: 'catalog', url: '/catalog', views: ['mobile', 'desktop'] },
  { name: 'inventory', url: '/inventory', views: ['mobile', 'tablet', 'desktop'] },
  { name: 'trajectory', url: '/trajectory', views: ['mobile', 'desktop'] },
  { name: 'data-health', url: '/data-health', views: ['mobile', 'desktop'] },
];

await fs.rm(outDir, { recursive: true, force: true });
await fs.mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const results = [];

function safeName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

for (const scenario of scenarios) {
  for (const viewportName of scenario.views) {
    const viewport = viewports[viewportName];
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
      hasTouch: viewport.hasTouch,
      deviceScaleFactor: viewport.deviceScaleFactor,
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    const errors = [];
    const warnings = [];
    const failedResponses = [];

    page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
      if (msg.type() === 'warning') warnings.push(`console: ${msg.text()}`);
    });
    page.on('response', response => {
      if (response.status() >= 400 && response.url().startsWith(baseUrl)) {
        failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}`);
      }
    });

    const result = {
      scenario: scenario.name,
      viewport: viewportName,
      width: viewport.width,
      height: viewport.height,
      url: `${baseUrl}${scenario.url}`,
      screenshot: null,
      metrics: null,
      errors,
      warnings,
      failedResponses,
      ok: false,
    };

    try {
      const response = await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      if (!response || !response.ok()) {
        throw new Error(`navigation returned ${response ? response.status() : 'no response'}`);
      }
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(1000);
      if (scenario.action) {
        await scenario.action(page);
        await page.waitForTimeout(500);
      }

      result.metrics = await page.evaluate(({ viewportName }) => {
        const visible = el => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0;
        };
        const textEls = [...document.querySelectorAll('body *')].filter(el => {
          if (!visible(el)) return false;
          if (el.children.length) return false;
          return (el.textContent || '').trim().length > 0;
        });
        const minFont = viewportName === 'mobile' ? 11.5 : viewportName === 'tablet' ? 10.5 : 9.5;
        const smallText = textEls
          .map(el => ({
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
            size: Number.parseFloat(getComputedStyle(el).fontSize || '0'),
            color: getComputedStyle(el).color,
          }))
          .filter(x => x.size > 0 && x.size < minFont)
          .slice(0, 40);
        const clickables = [...document.querySelectorAll('a,button,[role="button"],input,select,textarea')].filter(visible);
        const smallTargets = clickables
          .map(el => {
            const r = el.getBoundingClientRect();
            return {
              label: ((el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName) + '').trim().replace(/\s+/g, ' ').slice(0, 70),
              width: Math.round(r.width),
              height: Math.round(r.height),
            };
          })
          .filter(x => x.width < 36 || x.height < 36)
          .slice(0, 40);
        const doc = document.documentElement;
        const body = document.body;
        const scrollWidth = Math.max(doc.scrollWidth, body.scrollWidth);
        const overflowPx = Math.max(0, scrollWidth - doc.clientWidth);
        return {
          title: document.title,
          bodyTextLength: (body.innerText || '').length,
          scrollWidth,
          scrollHeight: Math.max(doc.scrollHeight, body.scrollHeight),
          horizontalOverflowPx: overflowPx,
          smallTextCount: smallText.length,
          smallTextExamples: smallText,
          smallTapTargetCount: smallTargets.length,
          smallTapTargetExamples: smallTargets,
        };
      }, { viewportName });

      const fileName = `${safeName(scenario.name)}-${viewportName}.png`;
      const filePath = path.join(outDir, fileName);
      await page.screenshot({ path: filePath, fullPage: true });
      result.screenshot = fileName;
      result.ok = true;
    } catch (err) {
      errors.push(`qa: ${err.message}`);
      try {
        const fileName = `${safeName(scenario.name)}-${viewportName}-error.png`;
        await page.screenshot({ path: path.join(outDir, fileName), fullPage: true });
        result.screenshot = fileName;
      } catch {}
    }

    results.push(result);
    await context.close();
  }
}

await browser.close();

const summary = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  captures: results.length,
  successfulCaptures: results.filter(x => x.ok).length,
  navigationFailures: results.filter(x => !x.ok).length,
  consoleErrorCount: results.reduce((n, x) => n + x.errors.length, 0),
  failedResponseCount: results.reduce((n, x) => n + x.failedResponses.length, 0),
  horizontalOverflowCaptures: results.filter(x => (x.metrics?.horizontalOverflowPx || 0) > 2).length,
  smallTextSignals: results.reduce((n, x) => n + (x.metrics?.smallTextCount || 0), 0),
  smallTapTargetSignals: results.reduce((n, x) => n + (x.metrics?.smallTapTargetCount || 0), 0),
  results,
};

await fs.writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

const lines = [
  '# DPP Visual QA',
  '',
  `Generated: ${summary.generatedAt}`,
  `Base URL: ${baseUrl}`,
  '',
  `**${summary.successfulCaptures}/${summary.captures} captures succeeded.**`,
  '',
  '| Screen | Viewport | Overflow | Small text | Small tap targets | Browser errors |',
  '|---|---:|---:|---:|---:|---:|',
];
for (const r of results) {
  lines.push(`| ${r.scenario} | ${r.viewport} ${r.width}×${r.height} | ${r.metrics?.horizontalOverflowPx ?? '—'}px | ${r.metrics?.smallTextCount ?? '—'} | ${r.metrics?.smallTapTargetCount ?? '—'} | ${r.errors.length} |`);
}
lines.push('', '## Signals', '');
lines.push(`- Horizontal overflow: ${summary.horizontalOverflowCaptures} capture(s)`);
lines.push(`- Small-text signals: ${summary.smallTextSignals}`);
lines.push(`- Small tap-target signals: ${summary.smallTapTargetSignals}`);
lines.push(`- Failed local HTTP responses: ${summary.failedResponseCount}`);
lines.push(`- Browser/page errors: ${summary.consoleErrorCount}`);
lines.push('', '_These are review signals, not automatic design failures. Screenshots remain the source of truth for visual judgment._', '');
await fs.writeFile(path.join(outDir, 'report.md'), lines.join('\n'));

console.log(JSON.stringify({
  captures: summary.captures,
  successful: summary.successfulCaptures,
  navigationFailures: summary.navigationFailures,
  overflowCaptures: summary.horizontalOverflowCaptures,
  smallTextSignals: summary.smallTextSignals,
  smallTapTargetSignals: summary.smallTapTargetSignals,
  browserErrors: summary.consoleErrorCount,
}, null, 2));

if (summary.navigationFailures > 0) process.exitCode = 2;
