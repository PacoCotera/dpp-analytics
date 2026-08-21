import { byId, escapeHtml, fetchJson, integer, money, percent } from './ui-utils.js';

function toneClass(value) {
  const numeric = Number(value);
  if (numeric > 0) return 'good';
  if (numeric < 0) return 'bad';
  return '';
}

function share(value) {
  return value === null || value === undefined ? '—' : `${Number(value).toFixed(1)}%`;
}

function renderStory(horizons) {
  const values = Object.fromEntries(
    horizons.map(item => [item.label, Number(item.delta_pct || 0)]),
  );
  const short = values['7D'];
  const main = values['28D'];
  const persistent = values['56D'];
  const long = values['90D'];
  let title;
  let copy;

  if (main > 5 && persistent > 2 && long > 2) {
    title = 'Momentum is structurally stronger.';
    copy = short < 0
      ? 'The latest week softened, but 28D, 56D and 90D remain positive. Treat the dip as noise unless it persists.'
      : 'The main and longer horizons are positive, with the latest week reinforcing the trend.';
  } else if (main < -5 && persistent < -2 && long < -2) {
    title = 'The slowdown looks structural.';
    copy = short > 0
      ? 'The latest week improved, but the 28D, 56D and 90D base remains weaker. The bounce is early, not yet a reversal.'
      : 'Main and longer horizons are weaker, and the latest week is not contradicting that signal.';
  } else if (short > 5 && main < 2) {
    title = 'Short-term acceleration, not yet structural.';
    copy = 'The latest week improved before the 28D and longer windows clearly turned. Watch for persistence.';
  } else if (short < -5 && main > 2) {
    title = 'Recent softness inside a stronger base.';
    copy = 'The latest week is down while the four-week business remains ahead. Watch whether softness reaches the longer horizons.';
  } else if (Math.abs(main) < 2) {
    title = 'The structural signal is flat.';
    copy = 'The 28-day business has not made a meaningful step up or down. Weekly movement is mostly context until the longer windows move.';
  } else if (main > 0) {
    title = 'The business is strengthening, but not uniformly.';
    copy = 'The 28-day horizon is ahead; 56D and 90D determine whether that improvement has become durable.';
  } else {
    title = 'The business has softened, but the signal is mixed.';
    copy = 'The 28-day horizon is behind; longer windows determine whether this is structural or still ordinary volatility.';
  }

  byId('storyTitle').textContent = title;
  byId('storyCopy').textContent = copy;
}

function renderHorizons(rows) {
  const maxDelta = Math.max(...rows.map(item => Math.abs(Number(item.delta_pct || 0))), 10);
  byId('horizons').innerHTML = rows
    .map(item => {
      const delta = Number(item.delta_pct || 0);
      const width = Math.max(4, Math.min(100, (Math.abs(delta) / maxDelta) * 100));
      const tone = toneClass(delta);
      return `<div class="trajectory-horizon">
        <div class="trajectory-horizon__label">${escapeHtml(item.label)}</div>
        <div>
          <div class="trajectory-horizon__track"><div class="trajectory-horizon__bar ${tone}" style="width:${width}%"></div></div>
          <div class="trajectory-horizon__copy">${money(item.sales)} · ${money(item.daily_avg)}/day · ${integer(item.orders)} orders</div>
        </div>
        <div class="trajectory-horizon__delta ${tone}">${percent(item.delta_pct)}</div>
      </div>`;
    })
    .join('');
}

function renderPortfolio(portfolio = {}) {
  const active = Number(portfolio.active_skus || 0);
  const productive = Number(portfolio.productive_skus || 0);
  const productiveShare = active ? (100 * productive) / active : null;
  const cards = [
    [
      'Productive SKUs',
      `${productive}${active ? ` / ${active}` : ''}`,
      productiveShare == null ? 'No active offers' : `Selling in T28 · ${productiveShare.toFixed(0)}% of active`,
    ],
    ['Revenue / SKU', money(portfolio.revenue_per_active_sku), 'T28 average across active sellable offers'],
    ['Median SKU', money(portfolio.median_revenue_per_sku), 'Less distorted by the largest products'],
    ['Top SKU share', share(portfolio.top_sku_share_pct), 'Lower concentration means broader portfolio support'],
    ['Top 3 share', share(portfolio.top3_share_pct), 'How dependent T28 revenue is on the leaders'],
    ['New SKU share', share(portfolio.new_sku_share_pct), 'T28 revenue from offers opened in the last 90 days'],
  ];

  byId('portfolio').innerHTML = cards
    .map(([label, value, copy]) => `<div class="structure-card">
      <div class="structure-label">${escapeHtml(label)}</div>
      <div class="structure-value">${escapeHtml(value)}</div>
      <div class="structure-copy">${escapeHtml(copy)}</div>
    </div>`)
    .join('');

  const definition = portfolio.definition || {};
  byId('portfolioNote').innerHTML = definition.identity
    ? `<strong>Portfolio identity:</strong> ${escapeHtml(definition.identity)} ${definition.productive_sku ? escapeHtml(definition.productive_sku) : ''}`
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
    : 'Recent weekly evidence';

  byId('weeks').innerHTML = rows.length
    ? rows
        .map((item, index) => {
          const current = Boolean(item.current_week);
          const delta = item.delta_vs_prior_week_pct;
          const comparison = current
            ? `<div class="week-partial">Partial week · ${integer(item.days_loaded)} reconciled day${Number(item.days_loaded || 0) === 1 ? '' : 's'} so far. We do not compare this partial total with a full previous week.</div>`
            : `<div class="week-delta"><strong class="${toneClass(delta)}">${percent(delta)}</strong><span>vs previous week</span></div>`;

          return `<div class="week-row">
            <div class="week-when">
              <div class="week-kicker ${current ? 'current' : ''}">${weekLabel(item, index)} · Week ${escapeHtml(item.iso_week || '—')}</div>
              <strong>${escapeHtml(item.date_range || '')}</strong>
              <span>${current ? 'Latest reconciled data' : 'Monday through Sunday'}</span>
            </div>
            <div class="week-value"><strong>${money(item.sales)}</strong><span>${money(item.daily_avg)}/day · ${integer(item.days_loaded)} days</span></div>
            ${current ? '<div></div>' : comparison}
            ${current ? comparison : ''}
          </div>`;
        })
        .join('')
    : '<div class="empty"><strong>No weekly history yet.</strong></div>';
}

function render(payload) {
  const headline = payload.headline || {};
  const horizons = payload.horizons || [];

  byId('clock').textContent = payload.local_time || '--:--';
  byId('asof').textContent = `Reconciled through ${String(headline.business_date || '').slice(5)}`;

  const headlineElement = byId('headline');
  headlineElement.textContent = percent(headline.delta28_pct);
  headlineElement.className = `story-number ${toneClass(headline.delta28_pct)}`;

  renderStory(horizons);
  renderHorizons(horizons);
  if (window.DPPCharts) window.DPPCharts.trajectory('#chart', payload.series || []);
  renderPortfolio(payload.portfolio);
  renderWeeks(payload.weekly);
}

function bindInteractions() {
  byId('helpBtn').addEventListener('click', () => {
    byId('help').classList.toggle('show');
  });
}

async function start() {
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
