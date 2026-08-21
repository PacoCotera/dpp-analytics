import { byId, escapeHtml, fetchJson, integer } from './ui-utils.js';

const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function financeMoney(value) {
  if (value === null || value === undefined) return '—';
  const numeric = Number(value);
  const prefix = numeric < 0 ? '−$' : '$';
  return `${prefix}${number0.format(Math.abs(Math.round(numeric)))}`;
}

function valueClass(value) {
  const numeric = Number(value || 0);
  if (numeric < 0) return 'neg';
  if (numeric > 0) return 'pos';
  return '';
}

function percentage0(value) {
  return value === null || value === undefined ? '—' : `${Number(value).toFixed(0)}%`;
}

function monthLabel(value) {
  if (!value) return '—';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function normalizeState(value) {
  const state = String(value || 'OPEN').toUpperCase();
  if (state === 'FINALIZING') return 'AMAZON_CLOSING';
  if (state === 'AMAZON_CLOSED') return 'AMAZON_CLOSED_COGS_PENDING';
  if (state === 'READY_TO_CLOSE') return 'AMAZON_CLOSED_COGS_READY';
  return state;
}

function stateLabel(value) {
  return normalizeState(value).replaceAll('_', ' ');
}

function stateClass(value) {
  const state = normalizeState(value);
  if (state === 'CLOSED') return 'closed';
  if (state === 'RESTATED') return 'restated';
  if (state.includes('COGS_PENDING')) return 'pending';
  if (state.includes('CLOSING')) return 'closing';
  return '';
}

function financeLine(name, note, value, extra = '') {
  const stringValue = typeof value === 'string';
  return `<div class="finance-line ${extra}">
    <div>
      <div class="finance-line__name">${escapeHtml(name)}</div>
      <div class="finance-line__note">${escapeHtml(note)}</div>
    </div>
    <div class="finance-line__value ${stringValue ? 'pending-value' : valueClass(value)}">${stringValue ? escapeHtml(value) : financeMoney(value)}</div>
  </div>`;
}

function bridgeStep(label, value, kind = '') {
  const stringValue = typeof value === 'string';
  return `<div class="bridge-step ${kind}"><span>${escapeHtml(label)}</span><strong class="${stringValue ? '' : valueClass(value)}">${stringValue ? escapeHtml(value) : financeMoney(value)}</strong></div>`;
}

function renderProgressionChart(svg, rows) {
  const width = 900;
  const height = 260;
  const margin = { left: 62, right: 18, top: 20, bottom: 42 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const max = Math.max(
    1,
    ...rows.flatMap(row => [
      Number(row.net_sales_ex_vat || 0),
      Math.abs(Number(row.contribution_after_product_cogs || 0)),
    ]),
  );
  const top = Math.ceil(max / 5000) * 5000 || 5000;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(value => top * value);
  const bandwidth = innerWidth / Math.max(rows.length, 1);
  const barWidth = Math.min(24, Math.max(8, bandwidth * 0.24));
  const y = value => margin.top + innerHeight - (Number(value || 0) / top) * innerHeight;
  const baseline = margin.top + innerHeight;
  let output = '';

  ticks.forEach(tick => {
    const yy = y(tick);
    const label = tick >= 1000 ? `$${(tick / 1000).toFixed(tick % 1000 ? 1 : 0)}k` : `$${tick}`;
    output += `<line class="finance-chart-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${yy}" y2="${yy}"></line>`;
    output += `<text class="finance-chart-axis" x="${margin.left - 10}" y="${yy + 4}" text-anchor="end">${label}</text>`;
  });

  rows.forEach((row, index) => {
    const center = margin.left + bandwidth * (index + 0.5);
    const sales = Number(row.net_sales_ex_vat || 0);
    const contribution = Number(row.contribution_after_product_cogs || 0);
    const salesY = y(sales);
    const contributionY = y(Math.abs(contribution));
    const openClass = row._current ? ' is-open' : '';
    const contributionClass = contribution < 0 ? ' is-negative' : '';

    output += `<rect class="finance-chart-bar finance-chart-bar--sales${openClass}" x="${center - barWidth - 2}" y="${salesY}" width="${barWidth}" height="${Math.max(1, baseline - salesY)}" rx="3"></rect>`;
    output += `<rect class="finance-chart-bar finance-chart-bar--contribution${contributionClass}${openClass}" x="${center + 2}" y="${contributionY}" width="${barWidth}" height="${Math.max(1, baseline - contributionY)}" rx="3"></rect>`;
    output += `<text class="finance-chart-month" x="${center}" y="${height - 15}" text-anchor="middle">${monthLabel(row.month)}</text>`;
  });

  svg.innerHTML = output;
}

function renderCurrentMonth(current, closed) {
  const state = current.accounting_state || current.state || 'OPEN';
  byId('periodLabel').textContent = `${monthLabel(current.month)} so far`;

  const status = byId('status');
  status.className = `finance-status ${stateClass(state)}`;
  status.querySelector('span').textContent = stateLabel(state);

  byId('sales').textContent = financeMoney(current.net_sales_ex_vat);
  byId('iva').textContent = financeMoney(current.iva_on_sales);
  byId('gross').textContent = financeMoney(current.shopper_product_spend);
  byId('cash').textContent = financeMoney(current.cash_transferred);
  byId('cogsCoverage').textContent = percentage0(current.cogs_coverage_pct);

  const releaseCoverage = Number(current.core_orders || 0)
    ? (100 * Number(current.released_orders || 0)) / Number(current.core_orders)
    : 100;
  byId('releaseCoverage').textContent = percentage0(releaseCoverage);
  byId('closedCount').textContent = integer(closed.length);
  byId('restatedCount').textContent = integer(
    closed.filter(item => String(item.state || '').toUpperCase() === 'RESTATED').length,
  );
}

function renderCurrentBridge(current) {
  const estimate = current.estimated_contribution_before_current_ads;
  const other = estimate == null
    ? null
    : Number(estimate) - (
        Number(current.net_sales_ex_vat || 0) +
        Number(current.amazon_order_effect || 0) -
        Number(current.product_cogs || 0)
      );
  const ads = current.current_month_advertising;
  const contribution = ads == null
    ? estimate
    : Number(estimate || 0) - Math.abs(Number(ads || 0));

  byId('currentLines').innerHTML = [
    financeLine(
      'Amazon order economics released so far',
      'Released shipment/refund finance against orders from this month.',
      current.amazon_order_net,
    ),
    financeLine(
      'Other Amazon postings / timing',
      'Released service fees, adjustments and reimbursements posted this month.',
      other,
    ),
    financeLine(
      'Product COGS',
      'Editable standard/effective-dated direct cost for this OPEN month.',
      -Math.abs(Number(current.product_cogs || 0)),
    ),
    financeLine(
      'Current-month advertising',
      ads == null
        ? 'Advertising accrual is not yet available for this accounting month.'
        : 'Campaign spend accrued by advertising date.',
      ads == null ? 'Pending' : -Math.abs(Number(ads)),
    ),
    financeLine(
      ads == null ? 'Contribution before current-month advertising' : 'Estimated contribution so far',
      current.cogs_complete
        ? 'Useful live estimate, not a closed result.'
        : 'Incomplete until seller product-cost coverage is complete.',
      contribution,
      'total',
    ),
  ].join('');

  byId('currentBridge').innerHTML = [
    bridgeStep('Sales ex IVA', current.net_sales_ex_vat),
    bridgeStep('Amazon effect', current.amazon_order_effect),
    bridgeStep('Other postings', other),
    bridgeStep('Product COGS', -Math.abs(Number(current.product_cogs || 0))),
    bridgeStep(ads == null ? 'Contribution pre-ads' : 'Contribution', contribution, 'warn'),
  ].join('');

  return contribution;
}

function renderYtd(ytd) {
  if (!Number(ytd.months || 0)) {
    byId('ytdBridge').innerHTML = '<div class="bridge-step final"><span>Closed YTD</span><strong>Not available</strong></div>';
    return;
  }

  byId('ytdSub').textContent = `${ytd.months} closed months through ${monthLabel(ytd.through_month)}.`;
  byId('ytdBridge').innerHTML = [
    bridgeStep('Sales ex IVA', ytd.net_sales_ex_vat),
    bridgeStep('Amazon effect', ytd.amazon_order_effect),
    bridgeStep('Advertising', ytd.advertising),
    bridgeStep('Product COGS', -Math.abs(Number(ytd.product_cogs || 0))),
    bridgeStep('Contribution', ytd.contribution_after_product_cogs, 'final'),
  ].join('');
}

function renderPendingMonths(payload) {
  const pending = (payload.finalizing_months || [])
    .slice()
    .sort((a, b) => String(b.month).localeCompare(String(a.month)));
  const section = byId('pendingSection');

  if (!pending.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  byId('pendingCount').textContent = `${pending.length} month${pending.length === 1 ? '' : 's'}`;
  byId('pendingMonths').innerHTML = pending
    .map(item => {
      const normalizedState = normalizeState(item.accounting_state || item.state);
      const ready = normalizedState.includes('COGS_READY');
      const waits = (item.close_waits_for || []).join(' · ') || 'Ready for management-close snapshot';
      const missing = (item.missing_skus || []).map(value => value.sku).filter(Boolean);
      const cogsRead = missing.length
        ? `Missing COGS: ${missing.join(', ')}`
        : item.cogs_complete
          ? 'Seller COGS complete'
          : 'Seller COGS incomplete';

      return `<div class="pending-row">
        <div><strong>${monthLabel(item.month)}</strong><small>${financeMoney(item.net_sales_ex_vat)} sales ex IVA</small></div>
        <div><span class="pending-badge ${ready ? 'ready' : ''}">${escapeHtml(stateLabel(normalizedState))}</span><small>${item.amazon_state === 'CLOSED' ? 'Amazon-side final' : 'Amazon-side closing'}</small></div>
        <div><strong>${escapeHtml(waits)}</strong><small>${escapeHtml(cogsRead)}</small></div>
        <div class="pending-metric"><span>Order release</span><strong>${percentage0(item.release_coverage_pct)}</strong></div>
        <div class="pending-metric"><span>COGS coverage</span><strong>${percentage0(item.cogs_coverage_pct)}</strong></div>
      </div>`;
    })
    .join('');
}

function renderHistory(closed) {
  const rows = closed.slice().sort((a, b) => String(b.month).localeCompare(String(a.month)));
  const header = '<div class="history-row head"><div>Month</div><div>Sales</div><div>Amazon effect</div><div>Advertising</div><div>Product cost</div><div>Contribution</div><div>State</div></div>';

  byId('history').innerHTML = header + rows
    .map(item => `<div class="history-row">
      <div>${monthLabel(item.month)}</div>
      <div data-label="Sales"><strong>${financeMoney(item.net_sales_ex_vat)}</strong><small>ex IVA</small></div>
      <div data-label="Amazon effect"><strong class="${valueClass(item.amazon_order_effect)}">${financeMoney(item.amazon_order_effect)}</strong></div>
      <div data-label="Advertising"><strong class="${valueClass(item.advertising)}">${financeMoney(item.advertising)}</strong></div>
      <div data-label="Product cost"><strong class="neg">${financeMoney(-Math.abs(Number(item.product_cogs || 0)))}</strong></div>
      <div data-label="Contribution"><strong class="${valueClass(item.contribution_after_product_cogs)}">${financeMoney(item.contribution_after_product_cogs)}</strong><small>${item.contribution_margin_pct == null ? '—' : `${Number(item.contribution_margin_pct).toFixed(1)}%`}</small></div>
      <div data-label="State"><span class="history-state">${escapeHtml(stateLabel(item.state || 'CLOSED'))}</span><small>v${integer(item.version || 1)}</small></div>
    </div>`)
    .join('');
}

function renderEvents(events) {
  byId('events').innerHTML = (events || []).slice(0, 20).length
    ? (events || []).slice(0, 20)
        .map(item => `<div class="event-row">
          <div>
            <strong>${escapeHtml(item.transaction_type || 'Accounting event')}</strong>
            <small>${escapeHtml(item.local_time || '')} · ${escapeHtml(item.transaction_status || '—')} · ${escapeHtml(item.description || 'No description from Amazon')}</small>
          </div>
          <div class="amount ${valueClass(item.amount)}">${financeMoney(item.amount)}</div>
        </div>`)
        .join('')
    : '<p>No recent accounting events.</p>';
}

function render(payload) {
  const current = payload.current_month || {};
  const ytd = payload.ytd_closed_aggregate || {};
  const closed = (payload.closed_months || [])
    .slice()
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));

  byId('clock').textContent = payload.local_time || '--:--';
  byId('asof').textContent = `Finance through ${String(payload.finance_cutoff || '').slice(0, 10)}`;
  byId('throughLabel').textContent = `Sales through ${String(payload.sales_through || current.through_date || '').slice(0, 10)} · finance through ${String(payload.finance_cutoff || '').slice(0, 10)}`;

  renderCurrentMonth(current, closed);
  const currentContribution = renderCurrentBridge(current);
  renderYtd(ytd);
  renderProgressionChart(byId('progression'), [
    ...closed,
    {
      month: current.month,
      net_sales_ex_vat: current.net_sales_ex_vat,
      contribution_after_product_cogs: currentContribution,
      _current: true,
    },
  ]);
  renderPendingMonths(payload);
  renderHistory(closed);
  renderEvents(payload.recent);
}

function bindInteractions() {
  const history = byId('history');
  const toggle = byId('historyToggle');
  toggle.addEventListener('click', () => {
    const expanded = history.classList.toggle('expanded');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? 'Show recent closes only' : 'Show full closed history';
  });
}

async function start() {
  bindInteractions();

  try {
    render(await fetchJson('/api/finance'));
  } catch (error) {
    byId('periodLabel').textContent = 'Finance unavailable';
    byId('throughLabel').textContent = error.message;
    byId('asof').textContent = 'Feed unavailable';
  }
}

start();
