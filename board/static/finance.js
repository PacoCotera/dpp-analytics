import { byId, escapeHtml, fetchJson, integer } from './ui-utils.js';

const number0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const viewState = {
  payload: null,
  window: 'ytd',
  selectedMonth: null,
  includeCogs: true,
};

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

function monthDate(value) {
  return new Date(`${String(value).slice(0, 10)}T12:00:00`);
}

function monthKey(value) {
  return String(value || '').slice(0, 7);
}

function monthLabel(value) {
  if (!value) return '—';
  return monthDate(value).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function monthLongLabel(value) {
  if (!value) return '—';
  return monthDate(value).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
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

function chartMonthParts(value) {
  const date = monthDate(value);
  return {
    month: date.toLocaleDateString('en-US', { month: 'short' }),
    year: String(date.getFullYear()),
  };
}

function compactSignedMoney(value) {
  const numeric = Number(value || 0);
  const sign = numeric < 0 ? '−' : numeric > 0 ? '+' : '';
  const absolute = Math.abs(numeric);
  if (absolute >= 1000) {
    const decimals = absolute >= 10000 ? 0 : 1;
    const formatted = (absolute / 1000).toFixed(decimals).replace(/\.0$/, '');
    return `${sign}$${formatted}k`;
  }
  return `${sign}$${number0.format(Math.round(absolute))}`;
}

function chartAxisMoney(value) {
  const numeric = Number(value || 0);
  if (numeric === 0) return '$0';
  const sign = numeric < 0 ? '−' : '';
  const absolute = Math.abs(numeric);
  if (absolute >= 1000) {
    const formatted = (absolute / 1000).toFixed(absolute % 1000 ? 1 : 0).replace(/\.0$/, '');
    return `${sign}$${formatted}k`;
  }
  return `${sign}$${number0.format(Math.round(absolute))}`;
}

function niceChartStep(range, targetTicks = 5) {
  const raw = Math.max(1, Number(range || 0)) / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * magnitude;
}

function setChartGeometry(svg, width, height = 300) {
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.style.minWidth = width > 900 ? `${width}px` : '';
}

function currentContributionRow(current) {
  const estimate = current.estimated_contribution_before_current_ads;
  const sales = Number(current.net_sales_ex_vat || 0);
  const amazonEffect = Number(current.amazon_order_effect || 0);
  const productCogs = Math.abs(Number(current.product_cogs || 0));
  const other = estimate == null ? null : Number(estimate) - (sales + amazonEffect - productCogs);
  const adsRaw = current.current_month_advertising;
  const adsPending = adsRaw === null || adsRaw === undefined;
  const advertising = adsPending ? null : -Math.abs(Number(adsRaw || 0));
  const contribution =
    estimate == null ? null : adsPending ? Number(estimate) : Number(estimate) + advertising;

  return {
    month: current.month,
    net_sales_ex_vat: sales,
    amazon_order_effect: amazonEffect,
    other_finance_effect: other,
    advertising,
    product_cogs: productCogs,
    contribution_after_product_cogs: contribution,
    state: current.accounting_state || current.state || 'OPEN',
    _current: true,
    _adsPending: adsPending,
  };
}

function closedContributionRow(item) {
  const sales = Number(item.net_sales_ex_vat || 0);
  const amazonEffect = Number(item.amazon_order_effect || 0);
  const advertising = Number(item.advertising || 0);
  const productCogs = Math.abs(Number(item.product_cogs || 0));
  const contribution = Number(item.contribution_after_product_cogs || 0);
  const explained = sales + amazonEffect + advertising - productCogs;

  return {
    ...item,
    net_sales_ex_vat: sales,
    amazon_order_effect: amazonEffect,
    other_finance_effect: contribution - explained,
    advertising,
    product_cogs: productCogs,
    contribution_after_product_cogs: contribution,
    _current: false,
    _adsPending: false,
  };
}

function accountingRows(payload) {
  const closed = (payload.closed_months || [])
    .map(closedContributionRow)
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));
  const current = currentContributionRow(payload.current_month || {});
  return current.month ? [...closed, current] : closed;
}

function monthOrdinal(value) {
  const date = monthDate(value);
  return date.getFullYear() * 12 + date.getMonth();
}

function rowsForWindow(rows, windowKey, currentMonth) {
  const current = monthDate(currentMonth);
  const currentOrdinal = monthOrdinal(currentMonth);

  if (windowKey === '3m') {
    return rows.filter((row) => {
      const ordinal = monthOrdinal(row.month);
      return ordinal >= currentOrdinal - 2 && ordinal <= currentOrdinal;
    });
  }

  if (windowKey === 'ytd') {
    return rows.filter((row) => monthDate(row.month).getFullYear() === current.getFullYear());
  }

  if (windowKey === '12m') {
    return rows.filter((row) => {
      const ordinal = monthOrdinal(row.month);
      return ordinal >= currentOrdinal - 11 && ordinal <= currentOrdinal;
    });
  }

  if (windowKey === 'lastYear') {
    const year = current.getFullYear() - 1;
    return rows.filter((row) => monthDate(row.month).getFullYear() === year);
  }

  return rows;
}

function trajectoryContribution(row, includeCogs) {
  if (row.contribution_after_product_cogs === null || row.contribution_after_product_cogs === undefined)
    return null;
  const contribution = Number(row.contribution_after_product_cogs || 0);
  return includeCogs ? contribution : contribution + Math.abs(Number(row.product_cogs || 0));
}

function renderProgressionChart(svg, rows, includeCogs = true) {
  const height = 300;
  const margin = { left: 72, right: 20, top: 26, bottom: 62 };
  const usableRows = rows.filter((row) => row.month && trajectoryContribution(row, includeCogs) !== null);
  const width = Math.max(900, margin.left + margin.right + (usableRows.length + 1) * 72);
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  setChartGeometry(svg, width, height);

  let cumulative = 0;
  const points = usableRows.map((row) => {
    const delta = trajectoryContribution(row, includeCogs);
    const start = cumulative;
    const end = cumulative + delta;
    cumulative = end;
    return { ...row, delta, start, end };
  });

  if (!points.length) {
    svg.innerHTML = `<text class="finance-chart-axis" x="${width / 2}" y="150" text-anchor="middle">No contribution history available for this window.</text>`;
    return;
  }

  const values = [0, ...points.flatMap((point) => [point.start, point.end])];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const rawRange = Math.max(1, rawMax - rawMin);
  const step = niceChartStep(rawRange, 5);
  const domainMin = Math.floor((rawMin - rawRange * 0.08) / step) * step;
  const domainMax = Math.ceil((rawMax + rawRange * 0.08) / step) * step;
  const domainRange = Math.max(step, domainMax - domainMin);
  const y = (value) => margin.top + ((domainMax - Number(value || 0)) / domainRange) * innerHeight;
  const slotCount = points.length + 1;
  const slotWidth = innerWidth / slotCount;
  const barWidth = Math.min(44, Math.max(24, slotWidth * 0.55));
  const hasOpen = points.some((point) => point._current);
  const hasAdsPending = points.some((point) => point._current && point._adsPending);
  let output = '';

  for (let tick = domainMin; tick <= domainMax + step * 0.25; tick += step) {
    const yy = y(tick);
    const zero = Math.abs(tick) < step * 0.001;
    output += `<line class="${zero ? 'dpp-zero' : 'finance-chart-grid'}" x1="${margin.left}" x2="${width - margin.right}" y1="${yy}" y2="${yy}"></line>`;
    output += `<text class="finance-chart-axis" x="${margin.left - 10}" y="${yy + 4}" text-anchor="end">${chartAxisMoney(tick)}</text>`;
  }

  points.forEach((point, index) => {
    const center = margin.left + slotWidth * (index + 0.5);
    const startY = y(point.start);
    const endY = y(point.end);
    const topY = Math.min(startY, endY);
    const barHeight = Math.max(2, Math.abs(endY - startY));
    const positive = point.delta >= 0;
    const openClass = point._current ? ' is-open' : '';
    const directionClass = positive ? '' : ' is-negative';
    const month = chartMonthParts(point.month);
    const titleSuffix = `${point._current && point._adsPending ? '; advertising pending' : ''}${includeCogs ? '' : '; product COGS excluded'}`;

    output += `<g class="finance-chart-month-hit" data-month="${escapeHtml(point.month)}" tabindex="0" role="button" aria-label="Inspect ${escapeHtml(monthLongLabel(point.month))}">
      <rect class="finance-chart-bar dpp-bar finance-chart-bar--contribution${directionClass}${openClass}" x="${center - barWidth / 2}" y="${topY}" width="${barWidth}" height="${barHeight}" rx="4"></rect>
      <title>${escapeHtml(monthLabel(point.month))}: ${escapeHtml(compactSignedMoney(point.delta))}; running ${escapeHtml(financeMoney(point.end))}${escapeHtml(titleSuffix)}</title>
      <rect class="finance-chart-hit-area" x="${center - slotWidth / 2}" y="${margin.top}" width="${slotWidth}" height="${innerHeight + 50}" fill="transparent"></rect>
    </g>`;

    const rawDeltaY = positive ? topY - 7 : topY + barHeight + 13;
    const deltaY = Math.max(margin.top + 10, Math.min(height - 66, rawDeltaY));
    output += `<text class="finance-chart-month" x="${center}" y="${deltaY}" text-anchor="middle">${compactSignedMoney(point.delta)}</text>`;

    const nextCenter =
      index < points.length - 1
        ? margin.left + slotWidth * (index + 1.5)
        : margin.left + slotWidth * (points.length + 0.5);
    output += `<line class="dpp-connector" x1="${center + barWidth / 2}" x2="${nextCenter - barWidth / 2}" y1="${endY}" y2="${endY}"></line>`;

    if (point._current) {
      output += `<text class="dpp-muted" x="${center}" y="${height - 48}" text-anchor="middle">OPEN</text>`;
    }
    output += `<text class="finance-chart-month" x="${center}" y="${height - 29}" text-anchor="middle"><tspan x="${center}">${escapeHtml(month.month)}</tspan><tspan class="dpp-muted" x="${center}" dy="13">${escapeHtml(month.year)}</tspan></text>`;
  });

  const totalCenter = margin.left + slotWidth * (points.length + 0.5);
  const zeroY = y(0);
  const cumulativeY = y(cumulative);
  const totalTop = Math.min(zeroY, cumulativeY);
  const totalHeight = Math.max(2, Math.abs(cumulativeY - zeroY));
  output += `<g><rect class="finance-chart-bar finance-chart-bar--sales" x="${totalCenter - barWidth / 2}" y="${totalTop}" width="${barWidth}" height="${totalHeight}" rx="4"></rect><title>${includeCogs ? 'Window contribution' : 'Window contribution before product COGS'}: ${escapeHtml(financeMoney(cumulative))}${hasOpen ? ' including provisional open month' : ''}${hasAdsPending ? '; advertising pending' : ''}</title></g>`;
  const rawTotalValueY = cumulative < 0 ? cumulativeY - 8 : cumulativeY + 14;
  const totalValueY = Math.max(margin.top + 11, Math.min(height - 66, rawTotalValueY));
  output += `<text class="finance-chart-month" x="${totalCenter}" y="${totalValueY}" text-anchor="middle">${compactSignedMoney(cumulative)}</text>`;
  if (hasOpen) {
    output += `<text class="dpp-muted" x="${totalCenter}" y="${height - 48}" text-anchor="middle">PROVISIONAL</text>`;
  }
  output += `<text class="finance-chart-month" x="${totalCenter}" y="${height - 29}" text-anchor="middle"><tspan x="${totalCenter}">Window</tspan><tspan class="dpp-muted" x="${totalCenter}" dy="13">total</tspan></text>`;

  svg.innerHTML = output;
}

function renderMonthWaterfall(svg, row) {
  const width = 900;
  const height = 300;
  const margin = { left: 72, right: 20, top: 26, bottom: 62 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  setChartGeometry(svg, width, height);

  if (
    !row ||
    row.contribution_after_product_cogs === null ||
    row.contribution_after_product_cogs === undefined
  ) {
    svg.innerHTML =
      '<text class="finance-chart-axis" x="450" y="150" text-anchor="middle">No contribution detail is available for this month.</text>';
    return;
  }

  const open = Boolean(row._current);
  const steps = [
    { label: 'Sales', detail: 'Sales ex IVA', delta: Number(row.net_sales_ex_vat || 0), kind: 'sales' },
    { label: 'Amazon', detail: 'Amazon effect', delta: Number(row.amazon_order_effect || 0) },
    {
      label: 'Other',
      detail: open ? 'Other postings / timing' : 'Other finance postings',
      delta: Number(row.other_finance_effect || 0),
    },
    {
      label: 'Ads',
      detail: row._adsPending ? 'Advertising pending' : 'Advertising',
      delta: row._adsPending ? 0 : Number(row.advertising || 0),
      pending: row._adsPending,
    },
    { label: 'COGS', detail: 'Product COGS', delta: -Math.abs(Number(row.product_cogs || 0)) },
  ];

  let running = 0;
  const points = steps.map((stepItem) => {
    const start = running;
    const end = stepItem.pending ? running : running + stepItem.delta;
    running = end;
    return { ...stepItem, start, end };
  });
  const contribution = Number(row.contribution_after_product_cogs || 0);
  const values = [0, contribution, ...points.flatMap((point) => [point.start, point.end])];
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const rawRange = Math.max(1, rawMax - rawMin);
  const step = niceChartStep(rawRange, 5);
  const domainMin = Math.floor((rawMin - rawRange * 0.08) / step) * step;
  const domainMax = Math.ceil((rawMax + rawRange * 0.08) / step) * step;
  const domainRange = Math.max(step, domainMax - domainMin);
  const y = (value) => margin.top + ((domainMax - Number(value || 0)) / domainRange) * innerHeight;
  const slotCount = points.length + 1;
  const slotWidth = innerWidth / slotCount;
  const barWidth = Math.min(54, Math.max(34, slotWidth * 0.5));
  let output = '';

  for (let tick = domainMin; tick <= domainMax + step * 0.25; tick += step) {
    const yy = y(tick);
    const zero = Math.abs(tick) < step * 0.001;
    output += `<line class="${zero ? 'dpp-zero' : 'finance-chart-grid'}" x1="${margin.left}" x2="${width - margin.right}" y1="${yy}" y2="${yy}"></line>`;
    output += `<text class="finance-chart-axis" x="${margin.left - 10}" y="${yy + 4}" text-anchor="end">${chartAxisMoney(tick)}</text>`;
  }

  points.forEach((point, index) => {
    const center = margin.left + slotWidth * (index + 0.5);
    const startY = y(point.start);
    const endY = y(point.end);
    const topY = Math.min(startY, endY);
    const barHeight = Math.max(2, Math.abs(endY - startY));
    const positive = point.delta >= 0;
    const directionClass = positive ? '' : ' is-negative';
    const salesClass = point.kind === 'sales' ? ' finance-chart-bar--sales' : '';
    const barClass = salesClass || ` finance-chart-bar--contribution${directionClass}`;

    if (point.pending) {
      output += `<line class="dpp-connector" x1="${center - barWidth / 2}" x2="${center + barWidth / 2}" y1="${startY}" y2="${startY}"></line>`;
      output += `<text class="dpp-muted" x="${center}" y="${Math.max(margin.top + 11, startY - 8)}" text-anchor="middle">PENDING</text>`;
    } else {
      output += `<g><rect class="finance-chart-bar dpp-bar${barClass}" x="${center - barWidth / 2}" y="${topY}" width="${barWidth}" height="${barHeight}" rx="4"></rect><title>${escapeHtml(point.detail)}: ${escapeHtml(compactSignedMoney(point.delta))}</title></g>`;
      const rawValueY = positive ? topY - 7 : topY + barHeight + 13;
      const valueY = Math.max(margin.top + 10, Math.min(height - 66, rawValueY));
      output += `<text class="finance-chart-month" x="${center}" y="${valueY}" text-anchor="middle">${compactSignedMoney(point.delta)}</text>`;
    }

    const nextCenter =
      index < points.length - 1
        ? margin.left + slotWidth * (index + 1.5)
        : margin.left + slotWidth * (points.length + 0.5);
    output += `<line class="dpp-connector" x1="${center + barWidth / 2}" x2="${nextCenter - barWidth / 2}" y1="${endY}" y2="${endY}"></line>`;
    output += `<text class="finance-chart-month" x="${center}" y="${height - 29}" text-anchor="middle"><tspan x="${center}">${escapeHtml(point.label)}</tspan><tspan class="dpp-muted" x="${center}" dy="13">${escapeHtml(point.detail === point.label ? '' : point.detail)}</tspan></text>`;
  });

  const totalCenter = margin.left + slotWidth * (points.length + 0.5);
  const zeroY = y(0);
  const contributionY = y(contribution);
  const totalTop = Math.min(zeroY, contributionY);
  const totalHeight = Math.max(2, Math.abs(contributionY - zeroY));
  output += `<g><rect class="finance-chart-bar finance-chart-bar--sales" x="${totalCenter - barWidth / 2}" y="${totalTop}" width="${barWidth}" height="${totalHeight}" rx="4"></rect><title>${row._adsPending ? 'Contribution before current-month advertising' : 'Contribution'}: ${escapeHtml(financeMoney(contribution))}</title></g>`;
  const rawTotalValueY = contribution < 0 ? contributionY - 8 : contributionY + 14;
  const totalValueY = Math.max(margin.top + 11, Math.min(height - 66, rawTotalValueY));
  output += `<text class="finance-chart-month" x="${totalCenter}" y="${totalValueY}" text-anchor="middle">${compactSignedMoney(contribution)}</text>`;
  if (open) {
    output += `<text class="dpp-muted" x="${totalCenter}" y="${height - 48}" text-anchor="middle">OPEN</text>`;
  }
  output += `<text class="finance-chart-month" x="${totalCenter}" y="${height - 29}" text-anchor="middle"><tspan x="${totalCenter}">${row._adsPending ? 'Pre-ads' : 'Contribution'}</tspan><tspan class="dpp-muted" x="${totalCenter}" dy="13">${row._adsPending ? 'provisional' : 'result'}</tspan></text>`;

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
    closed.filter((item) => String(item.state || '').toUpperCase() === 'RESTATED').length,
  );
}

function renderCurrentBridge(current) {
  const row = currentContributionRow(current);
  const ads = current.current_month_advertising;
  const contribution = row.contribution_after_product_cogs;

  byId('currentLines').innerHTML = [
    financeLine(
      'Amazon order economics released so far',
      'Released shipment/refund finance against orders from this month.',
      current.amazon_order_net,
    ),
    financeLine(
      'Other Amazon postings / timing',
      'Released service fees, adjustments and reimbursements posted this month.',
      row.other_finance_effect,
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
    bridgeStep('Other postings', row.other_finance_effect),
    bridgeStep('Product COGS', -Math.abs(Number(current.product_cogs || 0))),
    bridgeStep(ads == null ? 'Contribution pre-ads' : 'Contribution', contribution, 'warn'),
  ].join('');
}

function renderYtd(ytd) {
  if (!Number(ytd.months || 0)) {
    byId('ytdBridge').innerHTML =
      '<div class="bridge-step final"><span>Closed YTD</span><strong>Not available</strong></div>';
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
    .map((item) => {
      const normalizedState = normalizeState(item.accounting_state || item.state);
      const ready = normalizedState.includes('COGS_READY');
      const waits = (item.close_waits_for || []).join(' · ') || 'Ready for management-close snapshot';
      const missing = (item.missing_skus || []).map((value) => value.sku).filter(Boolean);
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

function renderHistory(current, closed) {
  const currentRow = currentContributionRow(current);
  const closedRows = closed
    .slice()
    .sort((a, b) => String(b.month).localeCompare(String(a.month)))
    .map(closedContributionRow);
  const rows = currentRow.month ? [currentRow, ...closedRows] : closedRows;
  const header =
    '<div class="history-row head"><div>Month</div><div>Sales</div><div>Amazon effect</div><div>Advertising</div><div>Product cost</div><div>Contribution</div><div>State</div></div>';

  byId('history').innerHTML =
    header +
    rows
      .map((item) => {
        const open = Boolean(item._current);
        const margin =
          !open && item.contribution_margin_pct != null
            ? `${Number(item.contribution_margin_pct).toFixed(1)}%`
            : open && item._adsPending
              ? 'pre-ads'
              : 'provisional';
        const advertising =
          open && item._adsPending
            ? '<strong class="pending-value">Pending</strong><small>not accrued</small>'
            : `<strong class="${valueClass(item.advertising)}">${financeMoney(item.advertising)}</strong>`;
        const state = open ? 'OPEN' : stateLabel(item.state || 'CLOSED');
        const stateNote = open ? 'provisional' : `v${integer(item.version || 1)}`;

        return `<div class="history-row${open ? ' open-month' : ''}">
        <div>${monthLabel(item.month)}${open ? '<small>current</small>' : ''}</div>
        <div data-label="Sales"><strong>${financeMoney(item.net_sales_ex_vat)}</strong><small>ex IVA</small></div>
        <div data-label="Amazon effect"><strong class="${valueClass(item.amazon_order_effect)}">${financeMoney(item.amazon_order_effect)}</strong></div>
        <div data-label="Advertising">${advertising}</div>
        <div data-label="Product cost"><strong class="neg">${financeMoney(-Math.abs(Number(item.product_cogs || 0)))}</strong></div>
        <div data-label="Contribution"><strong class="${valueClass(item.contribution_after_product_cogs)}">${financeMoney(item.contribution_after_product_cogs)}</strong><small>${margin}</small></div>
        <div data-label="State"><span class="history-state">${escapeHtml(state)}</span><small>${escapeHtml(stateNote)}</small></div>
      </div>`;
      })
      .join('');
}

function renderEvents(events) {
  byId('events').innerHTML = (events || []).slice(0, 20).length
    ? (events || [])
        .slice(0, 20)
        .map(
          (item) => `<div class="event-row">
          <div>
            <strong>${escapeHtml(item.transaction_type || 'Accounting event')}</strong>
            <small>${escapeHtml(item.local_time || '')} · ${escapeHtml(item.transaction_status || '—')} · ${escapeHtml(item.description || 'No description from Amazon')}</small>
          </div>
          <div class="amount ${valueClass(item.amount)}">${financeMoney(item.amount)}</div>
        </div>`,
        )
        .join('')
    : '<p>No recent accounting events.</p>';
}

function populateMonthPicker(rows, currentMonth) {
  const select = byId('monthPicker');
  const options = rows
    .slice()
    .sort((a, b) => String(b.month).localeCompare(String(a.month)))
    .map((row) => {
      const marker = row._current ? 'OPEN' : stateLabel(row.state || 'CLOSED');
      return `<option value="${escapeHtml(row.month)}">${escapeHtml(monthLongLabel(row.month))} · ${escapeHtml(marker)}</option>`;
    })
    .join('');
  select.innerHTML = options;

  if (
    !viewState.selectedMonth ||
    !rows.some((row) => monthKey(row.month) === monthKey(viewState.selectedMonth))
  ) {
    viewState.selectedMonth = currentMonth;
  }
  select.value =
    rows.find((row) => monthKey(row.month) === monthKey(viewState.selectedMonth))?.month || currentMonth;
}

function windowDescription(windowKey, rows, currentRow) {
  if (!rows.length) return 'No accounting months are available for this window.';
  const first = rows[0];
  const last = rows.at(-1);
  const containsOpen = rows.some((row) => row._current);
  const adsPending = rows.some((row) => row._current && row._adsPending);
  const suffix = containsOpen
    ? ` The OPEN month is provisional${adsPending ? ' and currently excludes pending advertising' : ''}.`
    : ' All displayed months are management-closed.';
  const range = first && last ? `${monthLongLabel(first.month)} to ${monthLongLabel(last.month)}.` : '';

  if (windowKey === '3m')
    return `Three accounting months, reset to $0 at the start of the window. ${range}${suffix}`;
  if (windowKey === 'ytd') return `Calendar YTD, reset to $0 on January 1. ${range}${suffix}`;
  if (windowKey === '12m')
    return `Rolling 12 accounting months, reset to $0 at the start of the window. ${range}${suffix}`;
  if (windowKey === 'lastYear')
    return `Previous calendar year using available operating history. ${range}${suffix}`;
  if (windowKey === 'all')
    return `Full operating history from the first available accounting month. ${range}${suffix}`;
  return currentRow?._current
    ? `${monthLongLabel(currentRow.month)} detail. OPEN values are provisional${currentRow._adsPending ? '; advertising is still pending' : ''}.`
    : `${monthLongLabel(currentRow?.month)} detail from the immutable management-close snapshot.`;
}

function updateWindowControls() {
  document.querySelectorAll('[data-finance-window]').forEach((button) => {
    const selected = button.dataset.financeWindow === viewState.window;
    button.setAttribute('aria-selected', String(selected));
    button.classList.toggle('active', selected);
  });
  byId('monthPickerWrap').hidden = viewState.window !== 'month';
  byId('cogsToggleWrap').hidden = viewState.window === 'month';
  const cogsToggle = byId('cogsToggle');
  cogsToggle.classList.toggle('active', viewState.includeCogs);
  cogsToggle.setAttribute('aria-pressed', String(viewState.includeCogs));
  cogsToggle.textContent = viewState.includeCogs ? 'COGS included' : 'COGS excluded';
}

function renderWindow() {
  const payload = viewState.payload;
  if (!payload) return;
  const rows = accountingRows(payload);
  const currentMonth = payload.current_month?.month;
  populateMonthPicker(rows, currentMonth);
  updateWindowControls();

  const svg = byId('progression');
  const title = byId('progressionTitle');
  const sub = byId('progressionSub');
  const state = byId('progressionState');
  const legend = byId('progressionLegend');

  if (viewState.window === 'month') {
    const selected =
      rows.find((row) => monthKey(row.month) === monthKey(viewState.selectedMonth)) || rows.at(-1);
    viewState.selectedMonth = selected?.month || currentMonth;
    byId('monthPicker').value = viewState.selectedMonth;
    title.textContent = `${monthLongLabel(selected?.month)} contribution bridge`;
    sub.textContent = windowDescription('month', [selected].filter(Boolean), selected);
    state.textContent = selected?._current
      ? selected._adsPending
        ? 'OPEN · ADS PENDING'
        : 'OPEN · PROVISIONAL'
      : stateLabel(selected?.state || 'CLOSED');
    legend.innerHTML = [
      '<span class="legend-key"><i class="legend-swatch"></i>Sales</span>',
      '<span class="legend-key"><strong class="pos">+</strong>Addition</span>',
      '<span class="legend-key"><strong class="neg">−</strong>Deduction</span>',
      selected?._current ? '<span class="legend-key"><strong>OPEN</strong> · provisional</span>' : '',
      '<span class="legend-key"><i class="legend-swatch"></i>Contribution</span>',
    ].join('');
    svg.setAttribute('aria-label', `Contribution bridge for ${monthLongLabel(selected?.month)}`);
    renderMonthWaterfall(svg, selected);
    return;
  }

  const windowRows = rowsForWindow(rows, viewState.window, currentMonth);
  const labels = {
    '3m': '3-month contribution trajectory',
    ytd: `${monthDate(currentMonth).getFullYear()} YTD contribution trajectory`,
    '12m': 'Rolling 12-month contribution trajectory',
    lastYear: `${monthDate(currentMonth).getFullYear() - 1} contribution trajectory`,
    all: 'Full-history contribution trajectory',
  };
  const stateLabels = {
    '3m': '3 ACCOUNTING MONTHS',
    ytd: 'CALENDAR YTD',
    '12m': 'ROLLING 12 MONTHS',
    lastYear: 'PREVIOUS YEAR',
    all: 'FULL HISTORY',
  };

  title.textContent = labels[viewState.window] || 'Contribution trajectory';
  const cogsRead = viewState.includeCogs
    ? 'Product COGS is included.'
    : 'Product COGS is excluded; the trajectory shows contribution before product COGS.';
  sub.textContent = `${windowDescription(viewState.window, windowRows)} ${cogsRead} Click any month to inspect its contribution bridge.`;
  state.textContent = stateLabels[viewState.window] || 'RUNNING RESULT';
  legend.innerHTML = [
    '<span class="legend-key"><strong class="pos">+</strong>Positive month</span>',
    '<span class="legend-key"><strong class="neg">−</strong>Negative month</span>',
    windowRows.some((row) => row._current)
      ? '<span class="legend-key"><i class="legend-swatch open"></i>OPEN · provisional</span>'
      : '',
    `<span class="legend-key"><strong>${viewState.includeCogs ? 'COGS' : 'PRE-COGS'}</strong> ${viewState.includeCogs ? 'included' : 'view'}</span>`,
    '<span class="legend-key"><i class="legend-swatch"></i>Window total</span>',
  ].join('');
  svg.setAttribute(
    'aria-label',
    `${title.textContent}; cumulative contribution by accounting month; product COGS ${viewState.includeCogs ? 'included' : 'excluded'}`,
  );
  renderProgressionChart(svg, windowRows, viewState.includeCogs);
}

function inspectMonth(month) {
  if (!month) return;
  viewState.window = 'month';
  viewState.selectedMonth = month;
  renderWindow();
}

function render(payload) {
  viewState.payload = payload;
  const current = payload.current_month || {};
  const ytd = payload.ytd_closed_aggregate || {};
  const closed = (payload.closed_months || [])
    .slice()
    .sort((a, b) => String(a.month).localeCompare(String(b.month)));

  byId('clock').textContent = payload.local_time || '--:--';
  byId('asof').textContent = `Finance through ${String(payload.finance_cutoff || '').slice(0, 10)}`;
  byId('throughLabel').textContent =
    `Sales through ${String(payload.sales_through || current.through_date || '').slice(0, 10)} · finance through ${String(payload.finance_cutoff || '').slice(0, 10)}`;

  renderCurrentMonth(current, closed);
  renderCurrentBridge(current);
  renderYtd(ytd);
  renderPendingMonths(payload);
  renderHistory(current, closed);
  renderEvents(payload.recent);
  renderWindow();
}

function bindInteractions() {
  const history = byId('history');
  const toggle = byId('historyToggle');
  toggle.addEventListener('click', () => {
    const expanded = history.classList.toggle('expanded');
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.textContent = expanded ? 'Show recent months only' : 'Show full month history';
  });

  document.querySelectorAll('[data-finance-window]').forEach((button) => {
    button.addEventListener('click', () => {
      viewState.window = button.dataset.financeWindow;
      if (viewState.window === 'month' && !viewState.selectedMonth) {
        viewState.selectedMonth = viewState.payload?.current_month?.month || null;
      }
      renderWindow();
    });
  });

  byId('monthPicker').addEventListener('change', (event) => {
    viewState.window = 'month';
    viewState.selectedMonth = event.target.value;
    renderWindow();
  });

  byId('cogsToggle').addEventListener('click', () => {
    viewState.includeCogs = !viewState.includeCogs;
    renderWindow();
  });

  const chart = byId('progression');
  chart.addEventListener('click', (event) => {
    const target = event.target.closest('[data-month]');
    if (target) inspectMonth(target.dataset.month);
  });
  chart.addEventListener('keydown', (event) => {
    const target = event.target.closest('[data-month]');
    if (!target || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    inspectMonth(target.dataset.month);
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
