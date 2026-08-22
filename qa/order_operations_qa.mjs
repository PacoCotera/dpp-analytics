import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';
await fs.mkdir(outDir, { recursive: true });

const PENDING = new Set(['PENDING', 'PENDING_AVAILABILITY', 'INVOICE_UNCONFIRMED']);
const OPEN = new Set([...PENDING, 'UNSHIPPED', 'PARTIALLY_SHIPPED']);
const upper = value => String(value || '').toUpperCase();
const COUNT_KEYS = [
  'open_orders',
  'pending_orders',
  'unshipped_orders',
  'partially_shipped_orders',
  'fba_open_orders',
  'fbm_open_orders',
  'unknown_fulfillment_open_orders',
  'problem_orders',
  'shipped_today',
];

function sameCounts(label, actual, expected) {
  for (const key of COUNT_KEYS) {
    if (Number(actual?.[key] || 0) !== Number(expected?.[key] || 0)) {
      throw new Error(`${label} ${key} mismatch: ${actual?.[key]} vs ${expected?.[key]}`);
    }
  }
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
page.on('console', message => { if (message.type() === 'error') errors.push(`console: ${message.text()}`); });

try {
  const nav = await page.goto(`${baseUrl}/today`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  if (!nav?.ok()) throw new Error(`Today navigation returned ${nav?.status() || 'no response'}`);

  const payloads = await page.evaluate(async () => {
    const [todayResponse, salesResponse] = await Promise.all([
      fetch('/api/today', { cache: 'no-store' }),
      fetch('/api/sales', { cache: 'no-store' }),
    ]);
    return {
      todayStatus: todayResponse.status,
      today: await todayResponse.json(),
      salesStatus: salesResponse.status,
      sales: await salesResponse.json(),
    };
  });
  if (payloads.todayStatus !== 200) throw new Error(`Today API ${payloads.todayStatus}`);
  if (payloads.salesStatus !== 200) throw new Error(`Sales API ${payloads.salesStatus}`);

  // Fulfillment state is a required Orders dataset, not optional decoration. The
  // recent Sales evidence catches ingestion regressions even when the current
  // open queue happens to be empty and could otherwise falsely pass as zero.
  const recentOrders = Array.isArray(payloads.sales?.orders) ? payloads.sales.orders : [];
  const statusCovered = recentOrders.filter(order => upper(order.status)).length;
  const statusCoverage = recentOrders.length ? statusCovered / recentOrders.length : 1;
  if (recentOrders.length && statusCoverage < 0.9) {
    throw new Error(`Recent order fulfillment-status coverage too low: ${statusCovered}/${recentOrders.length}`);
  }

  // The renderer consumes the top-level queue. Validate that source directly,
  // then require the nested mart-backed copy and Sales to agree with it.
  const flow = payloads.today?.order_flow;
  const openOrders = payloads.today?.open_orders;
  if (!flow || flow.basis !== 'CURRENT_FULFILLMENT_STATE') {
    throw new Error(`Today renderer source does not expose current fulfillment-state basis: ${JSON.stringify(flow)}`);
  }
  if (!Array.isArray(openOrders)) throw new Error('Today renderer current open-order detail is not an array');

  const nestedFlow = payloads.today?.today?.order_flow;
  const nestedOpenOrders = payloads.today?.today?.open_orders;
  if (!nestedFlow || nestedFlow.basis !== 'CURRENT_FULFILLMENT_STATE') {
    throw new Error('Today mart-backed current order-state queue is missing');
  }
  if (!Array.isArray(nestedOpenOrders)) throw new Error('Today mart-backed open-order detail is not an array');
  sameCounts('Today top-level/mart', flow, nestedFlow);

  const derivedOpen = openOrders.filter(order => OPEN.has(upper(order.status)));
  const derivedPending = openOrders.filter(order => PENDING.has(upper(order.status)));
  const derivedUnshipped = openOrders.filter(order => upper(order.status) === 'UNSHIPPED');
  const derivedPartial = openOrders.filter(order => upper(order.status) === 'PARTIALLY_SHIPPED');
  const derivedFba = openOrders.filter(order => OPEN.has(upper(order.status)) && upper(order.fulfilled_by) === 'AMAZON');
  const derivedFbm = openOrders.filter(order => OPEN.has(upper(order.status)) && upper(order.fulfilled_by) === 'MERCHANT');
  const derivedUnknown = openOrders.filter(order => OPEN.has(upper(order.status)) && !['AMAZON', 'MERCHANT'].includes(upper(order.fulfilled_by)));

  const checks = [
    ['open', Number(flow.open_orders || 0), derivedOpen.length],
    ['pending', Number(flow.pending_orders || 0), derivedPending.length],
    ['unshipped', Number(flow.unshipped_orders || 0), derivedUnshipped.length],
    ['partial', Number(flow.partially_shipped_orders || 0), derivedPartial.length],
    ['fba_open', Number(flow.fba_open_orders || 0), derivedFba.length],
    ['fbm_open', Number(flow.fbm_open_orders || 0), derivedFbm.length],
    ['unknown_open', Number(flow.unknown_fulfillment_open_orders || 0), derivedUnknown.length],
  ];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) throw new Error(`${label} current-state count mismatch: API=${actual} detail=${expected}`);
  }

  if (Number(flow.open_orders || 0) !== Number(flow.pending_orders || 0) + Number(flow.unshipped_orders || 0) + Number(flow.partially_shipped_orders || 0)) {
    throw new Error(`Open roll-up does not equal pending + unshipped + partial: ${JSON.stringify(flow)}`);
  }

  for (const order of openOrders) {
    if (!OPEN.has(upper(order.status))) throw new Error(`Closed/problem status leaked into open queue: ${order.status}`);
    if (!order.order_id) throw new Error('Open order missing Amazon order ID');
    if (!Array.isArray(order.items)) throw new Error(`Open order ${order.order_id} missing item detail array`);
  }

  const salesFlow = payloads.sales?.today?.order_flow;
  if (!salesFlow || salesFlow.basis !== 'CURRENT_FULFILLMENT_STATE') {
    throw new Error('Sales does not share the canonical current order-state queue');
  }
  sameCounts('Sales/Today', salesFlow, flow);

  await page.waitForFunction(
    expected => document.getElementById('pendingOrdersKpi')?.textContent?.trim() === String(expected),
    Number(flow.pending_orders || 0),
    { timeout: 10000 },
  );
  const rendered = await page.evaluate(() => ({
    pendingKpi: document.getElementById('pendingOrdersKpi')?.textContent?.trim() || '',
    pendingNote: document.getElementById('pendingOrdersKpiNote')?.textContent?.trim() || '',
    flow: document.getElementById('orderFlowGrid')?.textContent?.replace(/\s+/g, ' ').trim() || '',
    foot: document.getElementById('orderFlowFoot')?.textContent?.trim() || '',
    openSummary: document.getElementById('openOrderSummary')?.textContent?.trim() || '',
    openCards: document.querySelectorAll('#openOrderGrid .operational-order').length,
    rollupCount: document.querySelector('.order-flow-rollup strong')?.textContent?.trim() || '',
    childCount: document.querySelectorAll('.order-flow-children .order-flow-stat').length,
  }));
  if (rendered.pendingKpi !== String(Number(flow.pending_orders || 0))) {
    throw new Error(`Rendered Pending hero KPI mismatch: ${JSON.stringify(rendered)}`);
  }
  if (rendered.rollupCount !== String(Number(flow.open_orders || 0))) {
    throw new Error(`Rendered Open roll-up mismatch: ${JSON.stringify(rendered)}`);
  }
  if (rendered.childCount !== 3) {
    throw new Error(`Order queue must show exactly Pending/Unshipped/Partial children: ${JSON.stringify(rendered)}`);
  }
  if (!rendered.flow.includes('Open now') || !rendered.flow.includes(`${Number(flow.pending_orders || 0)} Pending`)) {
    throw new Error(`Rendered order hierarchy is incomplete: ${JSON.stringify(rendered)}`);
  }
  if (Number(flow.open_orders || 0) > 0 && rendered.openCards !== Number(flow.open_orders || 0)) {
    throw new Error(`Rendered open-order detail mismatch: expected ${flow.open_orders}, got ${rendered.openCards}`);
  }
  if (errors.length) throw new Error(errors.join('; '));

  const localToday = String(payloads.today?.local_today || '');
  const olderPending = derivedPending.filter(order => String(order.created_date || '') && String(order.created_date) < localToday).length;
  const summary = {
    ok: true,
    localToday,
    fulfillmentStatusCoverage: {
      covered: statusCovered,
      total: recentOrders.length,
      pct: Number((statusCoverage * 100).toFixed(1)),
    },
    flow,
    openOrderDetailCount: openOrders.length,
    olderPendingIncluded: olderPending,
    rendered,
  };
  await fs.writeFile(path.join(outDir, 'order-operations-summary.json'), JSON.stringify(summary, null, 2));
  await page.screenshot({ path: path.join(outDir, 'today-order-operations.png'), fullPage: true });
  console.log(`ORDER_OPERATIONS current pending=${Number(flow.pending_orders || 0)} open=${Number(flow.open_orders || 0)} older_pending=${olderPending} status_coverage=${statusCovered}/${recentOrders.length}`);
  console.log(JSON.stringify(summary));
} catch (error) {
  await page.screenshot({ path: path.join(outDir, 'today-order-operations-error.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(outDir, 'order-operations-summary.json'), JSON.stringify({ ok: false, error: error.message, errors }, null, 2));
  console.error(error);
  await browser.close();
  process.exit(1);
}

await browser.close();
