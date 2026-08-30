import {
  byId,
  escapeHtml,
  fetchJson,
  formatBusinessClock,
  formatCount,
  integer,
  money,
  mountRuleTrigger,
} from './ui-utils.js';

const d3 = window.d3;
let data = null;
let period = '30';
let selectedDate = new URLSearchParams(window.location.search).get('date') || '';
let refreshTimer = null;
let lastWidth = 0;
let rhythmResizeFrame = 0;
let pendingRhythmWidth = 0;
const mobileHierarchy = window.matchMedia('(max-width: 640px)');

const AMAZON_PROCESSING = new Set(['PENDING', 'PENDING_AVAILABILITY', 'INVOICE_UNCONFIRMED']);

function parseDate(value) {
  return value ? new Date(`${String(value).slice(0, 10)}T12:00:00Z`) : null;
}

function signedPercent0(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const numeric = Number(value);
  return `${numeric >= 0 ? '+' : '−'}${Math.abs(numeric).toFixed(0)}%`;
}

function tone(value) {
  const numeric = Number(value);
  if (numeric >= 5) return 'good';
  if (numeric <= -5) return 'bad';
  return 'warn';
}

function dayLetter(date) {
  return ['S', 'M', 'T', 'W', 'T', 'F', 'S'][date.getUTCDay()];
}

function weekday(value) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(parseDate(value));
}

function shiftDate(value, days) {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function age(seconds) {
  const value = Number(seconds || 0);
  if (value < 3600) return `${Math.max(1, Math.round(value / 60))}m`;
  if (value < 86400) return `${(value / 3600).toFixed(value < 10800 ? 1 : 0)}h`;
  return `${(value / 86400).toFixed(1)}d`;
}

function statusLabel(status) {
  const key = String(status || '').toUpperCase();
  return (
    {
      PENDING: 'Amazon processing',
      PENDING_AVAILABILITY: 'Amazon processing · availability',
      INVOICE_UNCONFIRMED: 'Amazon processing · invoice',
      UNSHIPPED: 'Unshipped',
      PARTIALLY_SHIPPED: 'Partially shipped',
      SHIPPED: 'Shipped',
      CANCELLED: 'Cancelled',
      UNFULFILLABLE: 'Unfulfillable',
    }[key] ||
    key.replaceAll('_', ' ').toLowerCase() ||
    'Unknown'
  );
}

function statusTone(status) {
  const key = String(status || '').toUpperCase();
  if (AMAZON_PROCESSING.has(key)) return 'pending';
  if (['UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED'].includes(key)) return 'active';
  if (['UNFULFILLABLE', 'CANCELLED'].includes(key)) return 'problem';
  return '';
}

function fulfillmentLabel(order) {
  if (order.fulfillment_model && order.fulfillment_model !== '—') return order.fulfillment_model;
  const fulfilledBy = String(order.fulfilled_by || '').toUpperCase();
  if (fulfilledBy === 'AMAZON') return 'FBA';
  if (fulfilledBy === 'MERCHANT') return 'FBM';
  return '—';
}

function renderOrderCard(order) {
  const items = order.items || [];
  const itemHtml = items.length
    ? items
        .map((item) => {
          const image = item.image_url
            ? `<img src="${escapeHtml(item.image_url)}" alt="">`
            : '<span class="item-image-placeholder"></span>';
          const identity = [item.sku ? `SKU ${item.sku}` : '', item.asin ? `ASIN ${item.asin}` : '']
            .filter(Boolean)
            .join(' · ');
          return `<div class="operational-order__item">
            ${image}
            <div>
              <div class="item-name">${escapeHtml(item.product || item.sku || item.asin || 'Item')}</div>
              <div class="item-identity">${escapeHtml(identity || 'Identity unavailable')}</div>
              <div class="item-id">Item ${escapeHtml(item.order_item_id || '—')}</div>
            </div>
            <div class="item-qty">×${integer(item.quantity_ordered || 0)}</div>
          </div>`;
        })
        .join('')
    : `<div class="operational-order__item"><span class="item-image-placeholder"></span><div><div class="item-name">${escapeHtml(order.product || order.sku || 'Order')}</div><div class="item-identity">${escapeHtml([order.sku ? `SKU ${order.sku}` : '', order.asin ? `ASIN ${order.asin}` : ''].filter(Boolean).join(' · ') || 'Item detail pending')}</div></div><div class="item-qty">×${integer(order.units || 0)}</div></div>`;

  const rawStatus = String(order.status || '').toUpperCase();
  const status = statusLabel(rawStatus);
  const fulfillment = fulfillmentLabel(order);
  const total = order.sales === null || order.sales === undefined ? '—' : money(order.sales);
  const timing = [
    order.local_time ? formatBusinessClock(order.local_time) : '',
    order.age_seconds !== null && order.age_seconds !== undefined ? age(order.age_seconds) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const fulfilled = Number(order.quantity_fulfilled || 0);
  const unfulfilled = Number(order.quantity_unfulfilled || 0);
  const units = Number(
    order.units || items.reduce((sum, item) => sum + Number(item.quantity_ordered || 0), 0),
  );
  const unitLabel = formatCount(units, 'unit');
  const fulfillmentState = AMAZON_PROCESSING.has(rawStatus)
    ? `${unitLabel} · fulfillment not started`
    : `${unitLabel} · ${fulfilled} fulfilled · ${unfulfilled} unfulfilled`;
  const channel = order.channel_name || 'Amazon';

  return `<article class="today-order operational-order ops-owned">
    <div class="operational-order__top">
      <div class="operational-order__badges">
        <span class="order-badge ${statusTone(rawStatus)}" title="Amazon status: ${escapeHtml(rawStatus || 'unknown')}">${escapeHtml(status)}</span>
        <span class="order-badge fulfillment">${escapeHtml(fulfillment)}</span>
      </div>
      <strong>${total}</strong>
    </div>
    <div class="operational-order__meta">
      <code>${escapeHtml(order.order_id || 'Order ID unavailable')}</code>
      <span>${escapeHtml(timing)}</span>
    </div>
    <div class="operational-order__items">${itemHtml}</div>
    <div class="operational-order__foot">
      <span>${fulfillmentState}</span>
      <span>${escapeHtml(channel)} · shopper spend incl. IVA</span>
    </div>
  </article>`;
}

function renderOrderFlow(payload) {
  const flow = payload.order_flow || payload.today?.order_flow || null;
  if (!flow) {
    byId('pendingOrdersKpi').textContent = '—';
    byId('pendingOrdersKpiNote').textContent = 'current queue';
    byId('orderFlowGrid').innerHTML =
      '<div class="empty ops-owned">Current order queue is shown on live Today.</div>';
    byId('orderFlowFoot').textContent = 'Operational status is current state, not selected-day history.';
    byId('openOrderSummary').textContent = 'Current order queue is not attached to historical day views';
    byId('openOrderGrid').innerHTML =
      '<div class="empty ops-owned">Open orders are available on live Today.</div>';
    return;
  }

  const open = Number(flow.open_orders || 0);
  const pending = Number(flow.pending_orders || 0);
  const unshipped = Number(flow.unshipped_orders || 0);
  const partial = Number(flow.partially_shipped_orders || 0);
  const fba = Number(flow.fba_open_orders || 0);
  const fbm = Number(flow.fbm_open_orders || 0);
  const unknown = Number(flow.unknown_fulfillment_open_orders || 0);

  byId('pendingOrdersKpi').textContent = integer(pending);
  byId('pendingOrdersKpiNote').textContent = pending
    ? open === pending
      ? 'awaiting Amazon'
      : `${pending} of ${open} open`
    : 'none awaiting Amazon';

  byId('orderFlowGrid').innerHTML = `<div class="order-flow-rollup ops-owned">
      <div><span>Open now</span><small>Amazon processing + unshipped + partial</small></div>
      <strong>${integer(open)}</strong>
    </div>
    <div class="order-flow-children ops-owned">
      <div class="order-flow-stat"><strong>${integer(pending)}</strong><span>Amazon processing</span></div>
      <div class="order-flow-stat"><strong>${integer(unshipped)}</strong><span>Unshipped</span></div>
      <div class="order-flow-stat"><strong>${integer(partial)}</strong><span>Partial</span></div>
    </div>`;

  const notes = [
    `Shipped today ${integer(flow.shipped_today || 0)}`,
    `Open fulfillment · FBA ${fba} · FBM ${fbm}${unknown ? ` · ${unknown} other` : ''}`,
  ];
  if (Number(flow.problem_orders || 0)) notes.push(`${integer(flow.problem_orders)} needs attention`);
  byId('orderFlowFoot').textContent = notes.join(' · ');

  const openOrders = payload.open_orders || payload.today?.open_orders || [];
  if (!open) {
    byId('openOrderSummary').textContent = 'No open Amazon orders';
  } else if (open === pending && unshipped === 0 && partial === 0) {
    byId('openOrderSummary').textContent =
      `${open} open · all awaiting Amazon processing · current fulfillment state`;
  } else {
    const components = [];
    if (pending) components.push(`${pending} Amazon processing`);
    if (unshipped) components.push(`${unshipped} unshipped`);
    if (partial) components.push(`${partial} partial`);
    byId('openOrderSummary').textContent =
      `${open} open · ${components.join(' · ')} · current fulfillment state`;
  }
  byId('openOrderGrid').innerHTML = openOrders.length
    ? openOrders.map(renderOrderCard).join('')
    : '<div class="empty ops-owned">No open orders.</div>';
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function renderDayPicker() {
  if (document.documentElement.classList.contains('wall-mode')) return;

  const today = data.local_today;
  const chosen = data.selected_date || today;
  const limit = Math.min(7, Number(data.history_limit_days ?? 7));

  byId('dayPicker').innerHTML = Array.from({ length: limit + 1 }, (_, index) => {
    const dateString = shiftDate(today, -index);
    const date = parseDate(dateString);
    const live = index === 0;
    const longLabel = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(date);

    return `<button class="day-choice ${live ? 'live ' : ''}${dateString === chosen ? 'active' : ''}" type="button" data-date="${dateString}" title="${longLabel}${live ? ' · live' : ''}" aria-label="${longLabel}${live ? ' · live' : ''}" aria-pressed="${dateString === chosen}">
      <b>${live ? 'Today' : dayLetter(date)}</b><span>${live ? '' : date.getUTCDate()}</span>
    </button>`;
  }).join('');

  byId('dayPicker')
    .querySelectorAll('button')
    .forEach((button) => {
      button.addEventListener('click', () => selectDay(button.dataset.date));
    });
}

function selectDay(date) {
  selectedDate = date === data.local_today ? '' : date;
  const url = new URL(window.location.href);
  if (selectedDate) url.searchParams.set('date', selectedDate);
  else url.searchParams.delete('date');
  window.history.pushState({}, '', url);
  load();
}

function renderDayRead() {
  const today = data.today || {};
  const live = Boolean(data.is_live);
  const orders = Number(today.orders_today || 0);
  const sales = Number(today.sales_today || 0);
  const pace = today.pace_vs_same_weekday_pct == null ? Number.NaN : Number(today.pace_vs_same_weekday_pct);
  const day = weekday(data.selected_date || data.local_today);
  const read = data.day_read || {};
  const headline = read.label || 'Pace unavailable';
  let explanation;

  if (!read.eligible && live && orders < 3) {
    const expected = Number.isFinite(pace) && pace > -99 && sales > 0 ? sales / (1 + pace / 100) : null;
    explanation =
      expected && expected > 0
        ? `${formatCount(orders, 'order')} so far. A typical ${day.toLowerCase()} would be around ${money(expected)} in shopper spend by this point, so wait for more volume before judging pace.`
        : `${formatCount(orders, 'order')} so far. Wait for more volume before judging today against a typical ${day.toLowerCase()}.`;
  } else {
    explanation = Number.isFinite(pace)
      ? `Shopper spend is ${signedPercent0(pace)} versus comparable ${day.toLowerCase()} performance${live ? ' at this point in the day' : ''}.`
      : 'A comparable same-weekday pace is not available.';
  }

  byId('dayHeadline').textContent = headline;
  byId('dayHeadline').className = tone(pace);
  byId('dayExplanation').textContent = explanation;
  mountRuleTrigger(byId('dayHeadline'), read, data.interpretation_rules);
}

function renderBusinessRead() {
  const context = data.context || {};
  const mtd = Number(context.mtd_delta_pct);
  const last30 = Number(context.last30_delta_pct);
  const wtd = Number(context.week_delta_pct);
  const read = data.business_context_read || {};

  const benchmarks = [
    ['MTD', mtd],
    ['30D', last30],
    ['WTD', wtd],
  ];

  byId('pulseHeadline').textContent = read.label || 'Momentum unavailable';
  mountRuleTrigger(byId('pulseHeadline'), read, data.interpretation_rules);
  byId('pulseExplanation').className = 'business-benchmarks';
  byId('pulseExplanation').innerHTML = benchmarks
    .map(
      ([label, delta]) => `<span class="business-benchmark">
        <b>${label}</b>
        <strong class="${tone(delta)}">${signedPercent0(delta)}</strong>
      </span>`,
    )
    .join('');

  const rows = [
    ['MTD', context.sales_mtd, context.mtd_delta_pct, 'vs same days last month'],
    ['30D', context.sales_last30, context.last30_delta_pct, 'vs prior 30D'],
    ['WTD', context.sales_week, context.week_delta_pct, 'vs same days prior week'],
  ];
  byId('contextList').innerHTML = rows
    .map(
      ([label, value, delta, note]) => `<div class="context-row">
      <div><div class="label">${label}</div><small>${note}</small></div>
      <div class="value"><strong>${money(value)}</strong><span class="${tone(delta)}">${signedPercent0(delta)}</span></div>
    </div>`,
    )
    .join('');
}

function periodRows() {
  const rows = period === 'ytd' ? data.daily_history || data.recent_daily || [] : data.recent_daily || [];
  if (period === '7') return rows.slice(-7);
  if (period === 'mtd') {
    const selected = data.selected_date || rows.at(-1)?.business_date || '';
    return rows.filter((row) => String(row.business_date).slice(0, 7) === String(selected).slice(0, 7));
  }
  if (period === 'ytd') return rows;
  return rows.slice(-30);
}

function renderRhythmInsight() {
  const all = (data.recent_daily || [])
    .map((row) => ({
      ...row,
      date: parseDate(row.business_date),
      sales: Number(row.sales || 0),
    }))
    .filter((row) => row.date);
  const closed = all.filter((row) => !(data.is_live && row.business_date === data.local_today));
  const last7 = closed.slice(-7);
  const prior7 = closed.slice(-14, -7);
  const latestAverage = d3.mean(last7, (row) => row.sales) || 0;
  const priorAverage = d3.mean(prior7, (row) => row.sales) || 0;
  const delta = priorAverage > 0 ? (100 * (latestAverage - priorAverage)) / priorAverage : null;
  const selected = String(data.selected_date || data.local_today);
  const selectedDateObject = parseDate(selected);
  const comparable = closed
    .filter(
      (row) => row.business_date !== selected && row.date.getUTCDay() === selectedDateObject.getUTCDay(),
    )
    .map((row) => row.sales);
  const typical = median(comparable);
  const facts = [`7D avg ${money(latestAverage)}`];
  if (Number.isFinite(delta)) facts.push(`${signedPercent0(delta)} vs prior 7`);
  if (typical != null) facts.push(`${weekday(selected)} median ${money(typical)}`);
  byId('rhythmInsight').textContent = facts.join(' · ');
}

function drawChart() {
  const rows = periodRows()
    .map((row) => ({
      ...row,
      date: parseDate(row.business_date),
      sales: Number(row.sales || 0),
      orders: Number(row.orders || 0),
      units: Number(row.units || 0),
    }))
    .filter((row) => row.date);
  if (!rows.length || !window.DPPCharts?.demandRhythm) return;
  renderRhythmInsight();
  const stats =
    window.DPPCharts.demandRhythm('#rhythm', rows, { showCurrentWeek: false, window: period }) || {};
  const totalSales = stats.total ?? d3.sum(rows, (row) => row.sales);
  const closed = rows.filter((row) => !(data.is_live && row.business_date === data.local_today));
  const average = stats.average ?? d3.mean(closed, (row) => row.sales) ?? 0;
  const best = stats.best ?? d3.max(closed, (row) => row.sales) ?? 0;
  byId('rhythmRail').innerHTML =
    `<div class="rhythm-kpi"><div class="label">Shopper spend</div><strong>${money(totalSales)}</strong><small>selected window · incl. IVA</small></div><div class="rhythm-kpi"><div class="label">Closed-day pace</div><strong>${money(average)}</strong><small>average shopper spend</small></div><div class="rhythm-kpi"><div class="label">Best day</div><strong>${money(best)}</strong><small>inside this window</small></div>`;
  byId('rhythmSub').textContent =
    period === 'mtd'
      ? `Daily shopper spend · month through ${data.is_live ? 'today' : d3.utcFormat('%b %-d')(parseDate(data.selected_date))}`
      : period === 'ytd'
        ? `Daily shopper spend · ${String(data.selected_date || data.local_today).slice(0, 4)} year to date${rows[0]?.business_date > `${String(data.selected_date || data.local_today).slice(0, 4)}-01-01` ? ` · available history begins ${d3.utcFormat('%B %Y')(rows[0].date)}` : ''}`
        : `Daily shopper spend · ${rows.length} days`;
}

function renderLatestOrder(latest, live) {
  if (!latest) {
    byId('latest').innerHTML =
      `<div class="empty">${live ? 'Waiting for today’s first order.' : 'No orders recorded for this day.'}</div>`;
    byId('latestAge').textContent = '';
    return;
  }

  const image = latest.image_url ? `<img src="${escapeHtml(latest.image_url)}" alt="">` : '';
  byId('latest').innerHTML = `<div class="latest-product">
    ${image}
    <div>
      <div class="sku">${escapeHtml(latest.sku || '')}</div>
      <div class="name">${escapeHtml(latest.product || latest.sku || 'Order')}</div>
      <div class="latest-age">${escapeHtml(latest.local_time ? formatBusinessClock(latest.local_time) : '')}${live ? ` · ${age(latest.age_seconds)}` : ''}</div>
    </div>
    <div class="amount">${money(latest.sales)}</div>
  </div>`;
  byId('latestAge').textContent = '';
}

function renderProducts(payload) {
  const products = payload.sku_today || [];
  const totalSales = Number(payload.today?.sales_today || 0);
  const live = Boolean(payload.is_live);
  const previousReferenceOpen = Boolean(byId('todayProductsReference')?.open);
  byId('productsTitle').textContent = live ? 'What is driving today' : 'What drove that day';
  if (products.length) {
    const cards = products.slice(0, 8).map((item) => {
      const image = item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="">` : '';
      const contribution = totalSales > 0 ? (100 * Number(item.sales || 0)) / totalSales : 0;
      const identity = [item.sku ? `SKU ${item.sku}` : '', item.asin ? `ASIN ${item.asin}` : '']
        .filter(Boolean)
        .join(' · ');
      return `<a class="today-product ops-owned" href="/product?sku=${encodeURIComponent(item.sku || '')}">
            ${image}
            <div>
              <div class="name">${escapeHtml(item.product || item.sku || item.asin || 'Product')}</div>
              <div class="product-identity">${escapeHtml(identity)}</div>
              <div class="meta">${formatCount(item.units, 'unit')} · ${formatCount(item.orders, 'order')}</div>
              <div class="share-track"><i style="width:${Math.max(2, Math.min(100, contribution))}%"></i></div>
            </div>
            <div class="value"><strong>${money(item.sales || 0)}</strong><span class="share">${contribution.toFixed(0)}% of shopper spend</span></div>
          </a>`;
    });
    const secondary = cards.slice(3);
    byId('products').innerHTML =
      `<div class="today-products-priority ops-owned">${cards.slice(0, 3).join('')}</div>
      ${
        secondary.length
          ? `<details class="today-products-reference ops-owned" id="todayProductsReference" open>
        <summary><span><strong>${formatCount(secondary.length, 'more product')}</strong><small>Secondary contribution</small></span><b>View ↓</b></summary>
        <div class="today-products-secondary">${secondary.join('')}</div>
      </details>`
          : ''
      }`;
    const reference = byId('todayProductsReference');
    if (reference) {
      reference.open = mobileHierarchy.matches ? previousReferenceOpen : true;
      const toggle = reference.querySelector('summary b');
      const updateToggle = () => {
        if (toggle) toggle.textContent = reference.open ? 'Hide ↑' : 'View ↓';
      };
      reference.addEventListener('toggle', updateToggle);
      updateToggle();
    }
  } else {
    byId('products').innerHTML =
      `<div class="empty ops-owned">${live ? 'Products will appear as orders arrive.' : 'No product sales recorded for this day.'}</div>`;
  }
}

function renderSelectedOrders(payload) {
  const orders = payload.recent_orders || [];
  const today = payload.today || {};
  byId('orderSummary').textContent =
    `${formatCount(today.orders_today, 'order')} · ${formatCount(today.units_today, 'unit')} · ${money(today.sales_today || 0)} shopper spend incl. IVA`;
  byId('orderGrid').innerHTML = orders.length
    ? orders.map(renderOrderCard).join('')
    : '<div class="empty ops-owned">No orders recorded for this day.</div>';
}

function render(payload) {
  data = payload;
  const today = payload.today || {};
  const context = payload.context || {};
  const live = Boolean(payload.is_live);
  const selected = payload.selected_date || payload.local_today;
  const selectedLabel = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(parseDate(selected));

  renderDayPicker();
  byId('todayDayState').textContent = live ? 'Live operating day' : 'Closed operating day';
  byId('todayTitle').textContent = live ? 'Today' : selectedLabel;
  byId('todayKpis').setAttribute(
    'aria-label',
    live ? 'Today operating KPIs' : `${selectedLabel} operating KPIs`,
  );
  byId('salesLabel').textContent = live
    ? 'Shopper spend today · incl. IVA'
    : 'Closed-day shopper spend · incl. IVA';
  byId('sales').textContent = integer(today.sales_today);
  byId('orders').textContent = integer(today.orders_today);
  byId('units').textContent = integer(today.units_today);
  byId('clock').textContent = live ? formatBusinessClock(context.local_time) : 'Closed';
  byId('modeStatus').textContent = live ? 'Live Orders · shopper spend' : 'Closed day · shopper spend';

  renderDayRead();
  renderBusinessRead();
  renderLatestOrder(payload.latest_order, live);
  renderOrderFlow(payload);
  renderProducts(payload);
  renderSelectedOrders(payload);
  drawChart();

  if (refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (live) refreshTimer = window.setInterval(load, 20000);
}

async function load() {
  const query = selectedDate ? `?date=${encodeURIComponent(selectedDate)}` : '';
  try {
    render(await fetchJson(`/api/today${query}`));
  } catch (error) {
    byId('dayHeadline').textContent = 'Feed unavailable';
    byId('dayExplanation').textContent = error.message;
  }
}

function bindInteractions() {
  document.querySelectorAll('[data-period]').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('[data-period]').forEach((item) => {
        item.classList.remove('active');
        item.setAttribute('aria-pressed', 'false');
      });
      button.classList.add('active');
      button.setAttribute('aria-pressed', 'true');
      period = button.dataset.period;
      drawChart();
    });
  });

  byId('ordersPanel').addEventListener('toggle', () => {
    byId('orderToggle').textContent = byId('ordersPanel').open ? 'Hide ↑' : 'View ↓';
  });

  const openPanel = byId('openOrdersPanel');
  if (openPanel) {
    openPanel.addEventListener('toggle', () => {
      byId('openOrderToggle').textContent = openPanel.open ? 'Hide ↑' : 'View ↓';
    });
  }

  const businessEvidence = byId('todayBusinessEvidence');
  if (businessEvidence) {
    const updateBusinessToggle = () => {
      byId('todayBusinessToggle').textContent = businessEvidence.open ? 'Hide ↑' : 'View ↓';
    };
    businessEvidence.open = !mobileHierarchy.matches;
    businessEvidence.addEventListener('toggle', updateBusinessToggle);
    updateBusinessToggle();
  }

  mobileHierarchy.addEventListener('change', (event) => {
    if (businessEvidence) businessEvidence.open = !event.matches;
    const productReference = byId('todayProductsReference');
    if (productReference) productReference.open = !event.matches;
  });

  window.addEventListener('popstate', () => {
    selectedDate = new URLSearchParams(window.location.search).get('date') || '';
    load();
  });

  if (window.ResizeObserver) {
    new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (!width) return;
      pendingRhythmWidth = width;
      if (rhythmResizeFrame) return;
      rhythmResizeFrame = window.requestAnimationFrame(() => {
        rhythmResizeFrame = 0;
        const nextWidth = pendingRhythmWidth;
        if (!data || Math.abs(nextWidth - lastWidth) <= 12) return;
        lastWidth = nextWidth;
        drawChart();
      });
    }).observe(byId('rhythm').parentElement);
  }
}

bindInteractions();
load();
