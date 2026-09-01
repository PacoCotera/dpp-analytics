import {
  byId,
  escapeHtml,
  fetchJson,
  formatBusinessClock,
  formatCount,
  formatMetricWindow,
  money,
  mountRuleTrigger,
  percent,
} from './ui-utils.js';

let trajectoryPayload = null;
let trajectoryWindow = '180d';
let trajectoryResizeFrame = 0;
const TRAJECTORY_WINDOWS = new Set(['90d', '180d', 'ytd']);

function readTrajectoryUrlState() {
  const params = new URLSearchParams(window.location.search);
  const requestedWindow = params.get('window') || '180d';
  trajectoryWindow = TRAJECTORY_WINDOWS.has(requestedWindow) ? requestedWindow : '180d';
}

function writeTrajectoryUrlState(method = 'pushState') {
  const url = new URL(window.location.href);
  if (trajectoryWindow === '180d') url.searchParams.delete('window');
  else url.searchParams.set('window', trajectoryWindow);
  window.history[method]({}, '', url);
}

function syncTrajectoryWindowControl() {
  document.querySelectorAll('[data-trajectory-window]').forEach((button) => {
    const active = button.dataset.trajectoryWindow === trajectoryWindow;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function restoreTrajectoryUrlState({ normalize = false } = {}) {
  readTrajectoryUrlState();
  syncTrajectoryWindowControl();
  if (normalize) writeTrajectoryUrlState('replaceState');
  renderTrajectoryChart();
}

function toneClass(value) {
  const n = Number(value);
  if (n > 0) return 'good';
  if (n < 0) return 'bad';
  return '';
}
function share(value) {
  return percent(value, { sign: false });
}
function renderStory(read = {}, rules = {}, ads = {}) {
  const title = read.label || 'Trajectory unavailable';
  let copy = read.explanation || 'Not enough reconciled history is available to interpret trajectory.';
  if (ads.status === 'ready' && Number(ads.spend || 0) > 0) {
    const efficiency = ads.tacos == null ? '' : ` TACOS is ${percent(ads.tacos, { sign: false })}.`;
    copy += ` Paid media supported the latest 28-day period with ${money(ads.spend)} of spend.${efficiency} Read this as context, not proof that advertising caused the sales movement.`;
  }
  byId('storyTitle').textContent = title;
  byId('storyCopy').textContent = copy;
  mountRuleTrigger(byId('storyTitle'), read, rules);
}
function renderAds(ads = {}) {
  const ready = ads.status === 'ready' && Number(ads.spend || 0) > 0;
  byId('paidContext').classList.toggle('paid-context--empty', !ready);
  byId('paidTitle').textContent = ready
    ? 'Paid support is part of the current trajectory'
    : 'Waiting for Amazon Ads access';
  byId('paidCopy').textContent = ready
    ? `Through ${String(ads.through_date || '').slice(5)} · ${ads.attribution_maturity === 'MATURE' ? 'mature attribution window' : 'provisional attribution window'}. Amazon-attributed sales are attribution, not incremental sales.`
    : 'Trajectory remains seller-sales led. Paid support will appear here when advertising coverage is available.';
  byId('paidMetrics').innerHTML = ready
    ? [
        [money(ads.spend), '28D spend'],
        [ads.roas == null ? '—' : `${Number(ads.roas).toFixed(2)}×`, 'ROAS'],
        [share(ads.acos), 'ACOS'],
        [share(ads.tacos), 'TACOS'],
      ]
        .map(([v, l]) => `<div><strong>${escapeHtml(v)}</strong><span>${escapeHtml(l)}</span></div>`)
        .join('')
    : '';
}
function renderHorizons(rows) {
  byId('horizons').innerHTML = rows
    .map((item) => {
      const delta = Number(item.delta_pct || 0),
        tone = toneClass(delta);
      return `<div class="trajectory-horizon">
        <div class="trajectory-horizon__head"><span class="trajectory-horizon__label">${escapeHtml(item.label)}</span><strong class="trajectory-horizon__delta ${tone}">${percent(item.delta_pct)}</strong></div>
        <strong class="trajectory-horizon__value">${money(item.sales)}</strong>
        <div class="trajectory-horizon__copy"><span>${money(item.daily_avg)}/day</span><span>${formatCount(item.orders, 'order')}</span><span>vs prior ${escapeHtml(item.label)}</span></div>
      </div>`;
    })
    .join('');
}

function trajectoryRows() {
  const rows = trajectoryPayload?.series || [];
  if (trajectoryWindow === '90d') return rows.slice(-90);
  if (trajectoryWindow === 'ytd') {
    const year = String(rows.at(-1)?.business_date || '').slice(0, 4);
    return rows.filter((row) => String(row.business_date || '').startsWith(year));
  }
  return rows.slice(-180);
}

function renderTrajectoryChart() {
  if (!trajectoryPayload || !window.DPPCharts) return;
  const rows = trajectoryRows();
  const days = rows.length;
  const label =
    trajectoryWindow === '90d' ? '90 days' : trajectoryWindow === 'ytd' ? 'Year to date' : '180 days';
  const weekly = days > 120;
  byId('trajectoryChartDescription').textContent =
    `${label} · ${weekly ? 'weekly average daily' : 'daily'} shopper spend incl. IVA · 28-day moving average · reconciled Sales & Traffic`;
  window.DPPCharts.trajectory('#chart', rows, { aggregate: weekly ? 'weekly' : 'daily' });
}
function renderPortfolio(p = {}) {
  const active = Number(p.active_skus || 0),
    productive = Number(p.productive_skus || 0),
    productiveShare = active ? (100 * productive) / active : null;
  const cards = [
    [
      'Productive SKUs',
      `${productive}${active ? ` / ${active}` : ''}`,
      productiveShare == null
        ? 'No active offers'
        : `Selling in T28 · ${percent(productiveShare, { digits: 0, sign: false })} of active`,
    ],
    ['Revenue / SKU', money(p.revenue_per_active_sku), 'T28 average across active sellable offers'],
    ['Median SKU', money(p.median_revenue_per_sku), 'Less distorted by the largest products'],
    ['Top SKU share', share(p.top_sku_share_pct), 'Lower concentration means broader portfolio support'],
    ['Top 3 share', share(p.top3_share_pct), 'How dependent T28 revenue is on the leaders'],
    ['New SKU share', share(p.new_sku_share_pct), 'T28 revenue from offers opened in the last 90 days'],
  ];
  const card = ([l, v, c]) =>
    `<div class="structure-card"><div class="structure-label">${escapeHtml(l)}</div><div class="structure-value">${escapeHtml(v)}</div><div class="structure-copy">${escapeHtml(c)}</div></div>`;
  const priority = [cards[0], cards[4], cards[5]];
  const secondary = [cards[1], cards[2], cards[3]];
  byId('portfolio').innerHTML = `
    <div class="structure-priority">${priority.map(card).join('')}</div>
    <details class="structure-reference" id="portfolioReference">
      <summary><span><strong>Additional portfolio benchmarks</strong><small>Per-SKU and leader context</small></span></summary>
      <div class="structure-secondary">${secondary.map(card).join('')}</div>
    </details>`;
  const d = p.definition || {};
  byId('portfolioNote').innerHTML = d.identity
    ? `<strong>Portfolio identity:</strong> ${escapeHtml(d.identity)} ${d.productive_sku ? escapeHtml(d.productive_sku) : ''}`
    : '';
}

function weekLabel(item, index) {
  if (item.current_week) return 'Current week';
  if (index === 1) return 'Previous week';
  return `${index} weeks ago`;
}
function renderWeeks(rows = []) {
  byId('weekSummary').textContent = rows.length
    ? `${rows.length} recent weeks · newest first`
    : 'Recent weekly history';
  byId('weeks').innerHTML = rows.length
    ? rows
        .map((item, index) => {
          const current = Boolean(item.current_week),
            delta = item.delta_vs_prior_week_pct,
            comparison = current
              ? `<div class="week-partial">Partial week · ${formatCount(item.days_loaded, 'reconciled day')} so far. We do not compare this partial total with a full previous week.</div>`
              : `<div class="week-delta"><strong class="${toneClass(delta)}">${percent(delta)}</strong><span>vs previous week</span></div>`;
          return `<div class="week-row"><div class="week-when"><div class="week-kicker ${current ? 'current' : ''}">${weekLabel(item, index)} · Week ${escapeHtml(item.iso_week || '—')}</div><strong>${escapeHtml(item.date_range || '')}</strong><span>${current ? 'Latest reconciled data' : 'Monday through Sunday'}</span></div><div class="week-value"><strong>${money(item.sales)}</strong><span>${money(item.daily_avg)}/day · ${formatCount(item.days_loaded, 'day')}</span></div>${current ? '<div></div>' : comparison}${current ? comparison : ''}</div>`;
        })
        .join('')
    : '<div class="empty"><strong>No weekly history yet.</strong></div>';
}
function render(payload) {
  trajectoryPayload = payload;
  const headline = payload.headline || {},
    horizons = payload.horizons || [],
    ads = payload.ads || {};
  byId('clock').textContent = formatBusinessClock(payload.local_time);
  byId('asof').textContent = `Reconciled through ${String(headline.business_date || '').slice(5)}`;
  byId('trajectoryBusinessWindow').textContent = formatMetricWindow(
    payload.metric_windows?.RECONCILED_BUSINESS_T28,
  );
  const h = byId('headline');
  h.textContent = percent(headline.delta28_pct);
  h.className = `story-number ${toneClass(headline.delta28_pct)}`;
  renderStory(payload.trajectory_read, payload.interpretation_rules, ads);
  renderAds(ads);
  renderHorizons(horizons);
  renderTrajectoryChart();
  renderPortfolio(payload.portfolio);
  renderWeeks(payload.weekly);
}
function bindInteractions() {
  document.querySelectorAll('[data-trajectory-window]').forEach((button) => {
    button.addEventListener('click', () => {
      const requestedWindow = button.dataset.trajectoryWindow;
      if (!TRAJECTORY_WINDOWS.has(requestedWindow) || requestedWindow === trajectoryWindow) return;
      trajectoryWindow = requestedWindow;
      syncTrajectoryWindowControl();
      writeTrajectoryUrlState();
      renderTrajectoryChart();
    });
  });
  window.addEventListener('popstate', () => restoreTrajectoryUrlState({ normalize: true }));
  byId('helpBtn').addEventListener('click', () => {
    const button = byId('helpBtn');
    const help = byId('help');
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded));
    help.hidden = !expanded;
    help.classList.toggle('show', expanded);
  });
  const host = document.querySelector('.trajectory-chart-host');
  if (window.ResizeObserver && host) {
    new ResizeObserver(() => {
      if (trajectoryResizeFrame) return;
      trajectoryResizeFrame = window.requestAnimationFrame(() => {
        trajectoryResizeFrame = 0;
        renderTrajectoryChart();
      });
    }).observe(host);
  }
}
async function start() {
  restoreTrajectoryUrlState({ normalize: true });
  bindInteractions();
  try {
    render(await fetchJson('/api/trajectory'));
  } catch (error) {
    byId('storyTitle').textContent = 'Trajectory unavailable';
    byId('storyCopy').textContent = error.message;
    byId('asof').textContent = 'Feed unavailable';
  }
}
start();
