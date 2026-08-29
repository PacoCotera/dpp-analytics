import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const viewport = { width: 1440, height: 900 };
const PAGES = [
  { key: 'today', url: '/', neutral: '/business' },
  { key: 'business', url: '/business', neutral: '/' },
  { key: 'sales', url: '/sales', neutral: '/' },
  { key: 'catalog', url: '/catalog', neutral: '/' },
  { key: 'inventory', url: '/inventory', neutral: '/' },
  { key: 'finance', url: '/finance', neutral: '/' },
  { key: 'ads', url: '/ads', neutral: '/' },
  { key: 'product', url: '/product?sku=PNC-001', neutral: '/' },
  { key: 'trajectory', url: '/trajectory', neutral: '/' },
  { key: 'data_health', url: '/data-health', neutral: '/' },
];

function readyExpression(key) {
  return `(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() || '';
    const exists = (selector) => Boolean(document.querySelector(selector));
    switch (${JSON.stringify(key)}) {
      case 'business':
        return text('#stateHeadline') && !/loading|reading/i.test(text('#stateHeadline'));
      case 'today':
        return exists('#rhythm .dpp-bar') && text('#clock') !== '--:--';
      case 'sales':
        return exists('#monthChart .dpp-bar') && text('#clock') !== '--:--';
      case 'catalog':
        return Boolean(document.querySelector('#portfolio > *')) && !/loading|feed unavailable/i.test(text('#asof'));
      case 'inventory':
        return text('#available') !== '—' && !/loading/i.test(text('#asof'));
      case 'finance':
        return text('#sales') !== '—' && !/loading/i.test(text('#throughLabel'));
      case 'ads': {
        const empty = document.querySelector('#emptyState');
        const ready = document.querySelector('#readyState');
        return Boolean((empty && !empty.hidden) || (ready && !ready.hidden && text('#spend') !== '—'));
      }
      case 'product':
        return !/loading product/i.test(text('.hero-sku')) && !/one moment/i.test(text('.hero-name'));
      case 'trajectory':
        return text('#headline') !== '—' && !/reading momentum/i.test(text('#storyTitle'));
      case 'data_health':
        return text('#summaryCount') !== '—' && !/checking source/i.test(text('#healthTitle'));
      default:
        return document.readyState === 'complete';
    }
  })()`;
}

function canonicalApiUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.origin !== new URL(baseUrl).origin || !url.pathname.startsWith('/api/')) return null;
    url.searchParams.delete('refresh');
    url.searchParams.sort();
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

async function measureNavigation(page, definition, phase) {
  const apiRequests = [];
  const failedResponses = [];
  const onRequest = (request) => {
    const url = canonicalApiUrl(request.url());
    if (url) apiRequests.push(url);
  };
  const onResponse = (response) => {
    const url = canonicalApiUrl(response.url());
    if (url && response.status() >= 400) failedResponses.push(`${url} ${response.status()}`);
  };
  page.on('request', onRequest);
  page.on('response', onResponse);

  const started = performance.now();
  let response;
  try {
    response = await page.goto(`${baseUrl}${definition.url}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });
    if (!response?.ok()) throw new Error(`${definition.url} navigation returned ${response?.status()}`);
    await page.waitForFunction(readyExpression(definition.key), null, { timeout: 12_000 });
    const dataReadyMs = Math.round(performance.now() - started);
    await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});
    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource');
      const sameOrigin = resources.filter((entry) => {
        try {
          return new URL(entry.name).origin === window.location.origin;
        } catch {
          return false;
        }
      });
      return {
        dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        load_event_ms: nav?.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
        html_transfer_bytes: nav?.transferSize || 0,
        resource_transfer_bytes: Math.round(
          sameOrigin.reduce((sum, entry) => sum + Number(entry.transferSize || 0), 0),
        ),
        resource_count: sameOrigin.length,
      };
    });
    return {
      phase,
      data_ready_ms: dataReadyMs,
      ...timing,
      api_request_count: apiRequests.length,
      api_requests: apiRequests,
      failed_responses: failedResponses,
    };
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

const browser = await chromium.launch({ headless: true });
const results = [];
const failures = [];

try {
  for (const definition of PAGES) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    try {
      const cold = await measureNavigation(page, definition, 'cold');
      await page.goto(`${baseUrl}${definition.neutral}`, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      });
      const revisit = await measureNavigation(page, definition, 'revisit');
      const result = {
        key: definition.key,
        url: definition.url,
        cold,
        revisit,
        page_errors: pageErrors,
      };
      results.push(result);
      if (pageErrors.length || cold.failed_responses.length || revisit.failed_responses.length) {
        failures.push(`${definition.key}: browser/API errors during timing probe`);
      }
    } catch (error) {
      failures.push(`${definition.key}: ${error.message}`);
      results.push({ key: definition.key, url: definition.url, error: error.message, page_errors: pageErrors });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const successful = results.filter((item) => item.cold && item.revisit);
const summary = {
  ok: failures.length === 0 && successful.length === PAGES.length,
  status: failures.length ? 'FAIL' : 'PASS',
  measured_at: new Date().toISOString(),
  viewport,
  results,
  rankings: {
    cold_data_ready: [...successful].sort((a, b) => b.cold.data_ready_ms - a.cold.data_ready_ms).map((item) => ({
      key: item.key,
      ms: item.cold.data_ready_ms,
    })),
    revisit_data_ready: [...successful]
      .sort((a, b) => b.revisit.data_ready_ms - a.revisit.data_ready_ms)
      .map((item) => ({ key: item.key, ms: item.revisit.data_ready_ms })),
    revisit_api_requests: [...successful]
      .sort((a, b) => b.revisit.api_request_count - a.revisit.api_request_count)
      .map((item) => ({ key: item.key, count: item.revisit.api_request_count })),
  },
  failures,
};

await fs.writeFile(path.join(outDir, 'load-time-summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (!summary.ok) process.exitCode = 1;
