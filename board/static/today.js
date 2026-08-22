import { byId, escapeHtml, fetchJson, integer, money } from './ui-utils.js';

const d3 = window.d3;
let data = null;
let period = '30';
let selectedDate = new URLSearchParams(window.location.search).get('date') || '';
let refreshTimer = null;
let lastWidth = 0;

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
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(parseDate(value));
}

function shortMoney(value) {
  const numeric = Math.abs(Number(value || 0));
  return numeric >= 1000
    ? `$${(numeric / 1000).toFixed(numeric >= 10000 ? 0 : 1)}k`
    : `$${Math.round(numeric)}`;
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

    return `<button class="day-choice ${live ? 'live ' : ''}${dateString === chosen ? 'active' : ''}" type="button" data-date="${dateString}" title="${longLabel}${live ? ' · live' : ''}" aria-label="${longLabel}${live ? ' · live' : ''}">
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
  const pace = Number(today.pace_vs_same_weekday_pct);
  const day = weekday(data.selected_date || data.local_today);
  let headline;
  let explanation;

  if (live && orders < 3) {
    headline = orders === 0 ? 'Too early to call today' : 'Today is still low-signal';
    const expected = Number.isFinite(pace) && pace > -99 && sales > 0 ? sales / (1 + pace / 100) : null;
    explanation =
      expected && expected > 0
        ? `${orders} order${orders === 1 ? '' : 's'} so far. A typical ${day.toLowerCase()} would be around ${money(expected)} in shopper spend by this point, so wait for more volume before judging pace.`
        : `${orders} order${orders === 1 ? '' : 's'} so far. Wait for more volume before judging today against a typical ${day.toLowerCase()}.`;
  } else if (pace >= 15) {
    headline = `Ahead of a typical ${day}`;
    explanation = `Shopper spend is ${signedPercent0(pace)} versus comparable ${day.toLowerCase()} performance${live ? ' at this point in the day' : ''}.`;
  } else if (pace <= -15) {
    headline = `Behind a typical ${day}`;
    explanation = `Shopper spend is ${signedPercent0(pace)} versus comparable ${day.toLowerCase()} performance${live ? ' at this point in the day' : ''}.`;
  } else {
    headline = `Tracking near a typical ${day}`;
    explanation = `Shopper spend is ${signedPercent0(pace)} versus comparable ${day.toLowerCase()} performance${live ? ' at this point in the day' : ''}.`;
  }

  byId('dayHeadline').textContent = headline;
  byId('dayHeadline').className = tone(pace);
  byId('dayExplanation').textContent = explanation;
}

function renderBusinessRead() {
  const context = data.context || {};
  const today = data.today || {};
  const live = Boolean(data.is_live);
  const orders = Number(today.orders_today || 0);
  const mtd = Number(context.mtd_delta_pct);
  const last30 = Number(context.last30_delta_pct);
  let headline;
  let explanation;

  if (mtd >= 8 && last30 >= 5) {
    headline = 'The underlying business is strengthening';
    explanation = `MTD shopper spend is ${signedPercent0(mtd)} and the latest 30 days are ${signedPercent0(last30)}. ${live && orders < 3 ? 'Today is too early to override that broader read.' : ''}`;
  } else if (mtd <= -8 && last30 <= -5) {
    headline = 'The underlying business is weakening';
    explanation = `MTD shopper spend is ${signedPercent0(mtd)} and the latest 30 days are ${signedPercent0(last30)}. ${live && orders < 3 ? 'Today is too early to change that broader read.' : ''}`;
  } else if (Math.sign(mtd) !== Math.sign(last30) && Math.abs(mtd) >= 5 && Math.abs(last30) >= 5) {
    headline = 'Short and medium horizons disagree';
    explanation = `MTD shopper spend is ${signedPercent0(mtd)} while the latest 30 days are ${signedPercent0(last30)}. Treat the trend as mixed until the horizons converge.`;
  } else {
    headline = 'The broader business is broadly stable';
    explanation = `MTD shopper spend is ${signedPercent0(mtd)} and the latest 30 days are ${signedPercent0(last30)}. Today should be read as one operating day, not the whole trend.`;
  }

  byId('pulseHeadline').textContent = headline;
  byId('pulseExplanation').textContent = explanation;

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
  const rows = data.recent_daily || [];
  if (period === '7') return rows.slice(-7);
  if (period === 'mtd') {
    const selected = data.selected_date || rows.at(-1)?.business_date || '';
    return rows.filter((row) => String(row.business_date).slice(0, 7) === String(selected).slice(0, 7));
  }
  return rows.slice(-30);
}

function renderRhythmInsight() {
  const all = (data.recent_daily || [])
    .map((row) => ({ ...row, date: parseDate(row.business_date), sales: Number(row.sales || 0) }))
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
  let text;

  if (Number.isFinite(delta) && Math.abs(delta) >= 10) {
    text = `<strong>Recent shopper spend is ${delta > 0 ? 'running stronger' : 'running softer'}.</strong> The latest 7 closed days average ${money(latestAverage)}, ${signedPercent0(delta)} versus the prior 7.`;
  } else {
    text = `<strong>Recent shopper spend is fairly steady.</strong> The latest 7 closed days average ${money(latestAverage)}${Number.isFinite(delta) ? `, ${signedPercent0(delta)} versus the prior 7` : ''}.`;
  }
  if (typical != null)
    text += ` A typical recent ${weekday(selected)} closed day is about ${money(typical)}.`;
  byId('rhythmInsight').innerHTML = text;
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
  const host = byId('rhythm').parentElement;
  const svg = d3.select('#rhythm');

  if (!rows.length) {
    svg.selectAll('*').remove();
    return;
  }

  renderRhythmInsight();
  const width = Math.max(300, Math.round(host.getBoundingClientRect().width));
  const compact = width < 560;
  const height = compact ? 190 : 178;
  const margin = { top: 12, right: 8, bottom: 30, left: compact ? 46 : 52 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  svg.selectAll('*').remove();
  svg.attr('viewBox', `0 0 ${width} ${height}`);

  const group = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
  const x = d3
    .scaleBand()
    .domain(rows.map((row) => row.business_date))
    .range([0, innerWidth])
    .padding(rows.length <= 8 ? 0.18 : 0.24);
  const y = d3
    .scaleLinear()
    .domain([0, d3.max(rows, (row) => row.sales) || 1])
    .nice(4)
    .range([innerHeight, 0]);

  group
    .append('g')
    .attr('class', 'dpp-grid')
    .call(d3.axisLeft(y).ticks(4).tickSize(-innerWidth).tickFormat(''));
  group
    .append('g')
    .attr('class', 'dpp-axis')
    .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(7).tickFormat(shortMoney))
    .call((axis) => axis.select('.domain').remove());

  const bars = group
    .selectAll('rect')
    .data(rows)
    .join('rect')
    .attr('class', 'dpp-bar')
    .attr('x', (row) => x(row.business_date))
    .attr('width', x.bandwidth())
    .attr('y', (row) => y(row.sales))
    .attr('height', (row) => Math.max(1, innerHeight - y(row.sales)))
    .attr('rx', Math.min(4, x.bandwidth() / 4))
    .attr('fill', (row) => {
      const day = row.date.getUTCDay();
      if (data.is_live && row.business_date === data.local_today) return '#e58b1f';
      return day === 0 || day === 6 ? '#d8c09b' : '#b78b4d';
    });

  const dividers = group.append('g').attr('pointer-events', 'none');
  rows.forEach((row, index) => {
    if (!index) return;
    const previous = rows[index - 1];
    const xx = x(row.business_date) - (x.step() - x.bandwidth()) / 2;
    if (row.date.getUTCMonth() !== previous.date.getUTCMonth()) {
      dividers
        .append('line')
        .attr('x1', xx)
        .attr('x2', xx)
        .attr('y1', 0)
        .attr('y2', innerHeight)
        .attr('stroke', '#e58b1f')
        .attr('stroke-width', 1.4)
        .attr('opacity', 0.82);
    } else if (row.date.getUTCDay() === 1) {
      dividers
        .append('line')
        .attr('x1', xx)
        .attr('x2', xx)
        .attr('y1', 0)
        .attr('y2', innerHeight)
        .attr('stroke', '#c9c0b4')
        .attr('opacity', 0.48);
    }
  });

  const targetTicks = rows.length <= 8 ? rows.length : width < 520 ? 4 : width < 850 ? 5 : 7;
  const tickStep = Math.max(1, Math.ceil(rows.length / targetTicks));
  const ticks = rows
    .filter(
      (row, index) => rows.length <= 8 || index === 0 || index === rows.length - 1 || index % tickStep === 0,
    )
    .map((row) => row.business_date);
  group
    .append('g')
    .attr('class', 'dpp-axis')
    .attr('transform', `translate(0,${innerHeight})`)
    .call(
      d3
        .axisBottom(x)
        .tickValues(ticks)
        .tickSize(0)
        .tickPadding(8)
        .tickFormat((key) => d3.utcFormat(rows.length <= 8 ? '%a' : '%-d')(parseDate(key))),
    )
    .call((axis) => axis.select('.domain').attr('stroke', '#cfc5b7'));

  let tooltip = host.querySelector('.dpp-chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'dpp-chart-tooltip';
    host.appendChild(tooltip);
  }

  bars
    .on('pointerenter pointermove', function showTooltip(_event, row) {
      if (width < 640) return;
      const hostRect = host.getBoundingClientRect();
      const barRect = this.getBoundingClientRect();
      tooltip.innerHTML = `<strong>${d3.utcFormat('%a, %b %-d')(row.date)}</strong><span>Shopper spend ${money(row.sales)}</span><span>${integer(row.orders)} orders · ${integer(row.units)} units</span><span>Includes IVA · Amazon Orders</span>`;
      tooltip.style.left = `${Math.min(hostRect.width - 90, Math.max(90, barRect.left - hostRect.left + barRect.width / 2))}px`;
      tooltip.style.top = `${Math.max(54, barRect.top - hostRect.top + 8)}px`;
      tooltip.classList.add('show');
    })
    .on('pointerleave', () => tooltip.classList.remove('show'));

  const totalSales = d3.sum(rows, (row) => row.sales);
  const closed = rows.filter((row) => !(data.is_live && row.business_date === data.local_today));
  const average = d3.mean(closed, (row) => row.sales) || 0;
  const best = d3.max(closed, (row) => row.sales) || 0;
  byId('rhythmRail').innerHTML =
    `<div class="rhythm-kpi"><div class="label">Shopper spend</div><strong>${money(totalSales)}</strong><small>selected window · incl. IVA</small></div><div class="rhythm-kpi"><div class="label">Closed-day pace</div><strong>${money(average)}</strong><small>average shopper spend</small></div><div class="rhythm-kpi"><div class="label">Best day</div><strong>${money(best)}</strong><small>inside this window</small></div>`;
  byId('rhythmSub').textContent =
    period === 'mtd'
      ? `Daily shopper spend · month through ${data.is_live ? 'today' : d3.utcFormat('%b %-d')(parseDate(data.selected_date))}`
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
      <div class="latest-age">${escapeHtml(latest.local_time || '')}${live ? ` · ${age(latest.age_seconds)}` : ''}</div>
    </div>
    <div class="amount">${money(latest.sales)}</div>
  </div>`;
  byId('latestAge').textContent = '';
}

function renderProducts(products, totalSales, live) {
  byId('productsTitle').textContent = live ? 'What is driving today' : 'What drove that day';
  byId('products').innerHTML = products.length
    ? products
        .slice(0, 6)
        .map((item) => {
          const image = item.image_url ? `<img src="${escapeHtml(item.image_url)}" alt="">` : '';
          const contribution = totalSales > 0 ? (100 * Number(item.sales || 0)) / totalSales : 0;
          return `<a class="today-product" href="/product?sku=${encodeURIComponent(item.sku || '')}">
          ${image}
          <div>
            <div class="name">${escapeHtml(item.product || item.sku)}</div>
            <div class="meta">${integer(item.units)} units · ${integer(item.orders)} orders</div>
            <div class="share-track"><i style="width:${Math.max(2, Math.min(100, contribution))}%"></i></div>
          </div>
          <div class="value">${money(item.sales)}<span class="share">${contribution.toFixed(0)}% of shopper spend</span></div>
        </a>`;
        })
        .join('')
    : `<div class="empty">${live ? 'Products will appear as orders arrive.' : 'No product sales recorded for this day.'}</div>`;
}

function renderOrders(orders, today, live) {
  byId('orderSummary').textContent =
    `${integer(today.orders_today)} orders · ${integer(today.units_today)} units · ${money(today.sales_today)} shopper spend incl. IVA`;
  byId('orderGrid').innerHTML = orders.length
    ? orders
        .map(
          (order) => `<div class="today-order">
        <strong>${money(order.sales)}</strong>
        <div class="name">${escapeHtml(order.product || order.sku || 'Order')}</div>
        <div class="meta">${escapeHtml(order.local_time || '')}${live ? ` · ${age(order.age_seconds)}` : ''}</div>
      </div>`,
        )
        .join('')
    : '<div class="empty">No orders recorded.</div>';
}

function render(payload) {
  data = payload;
  const today = payload.today || {};
  const context = payload.context || {};
  const live = Boolean(payload.is_live);

  renderDayPicker();
  byId('salesLabel').textContent = live
    ? 'Shopper spend today · incl. IVA'
    : 'Closed-day shopper spend · incl. IVA';
  byId('sales').textContent = integer(today.sales_today);
  byId('orders').textContent = integer(today.orders_today);
  byId('units').textContent = integer(today.units_today);
  byId('clock').textContent = live ? context.local_time || '--:--' : 'Closed';
  byId('modeStatus').textContent = live ? 'Live Orders · shopper spend' : 'Closed day · shopper spend';

  renderDayRead();
  renderBusinessRead();
  renderLatestOrder(payload.latest_order, live);
  renderProducts(payload.sku_today || [], Number(today.sales_today || 0), live);
  renderOrders(payload.recent_orders || [], today, live);
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
  document.querySelectorAll('.period').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.period').forEach((item) => item.classList.remove('active'));
      button.classList.add('active');
      period = button.dataset.period;
      drawChart();
    });
  });

  byId('ordersPanel').addEventListener('toggle', () => {
    byId('orderToggle').textContent = byId('ordersPanel').open ? 'Hide ↑' : 'View ↓';
  });

  window.addEventListener('popstate', () => {
    selectedDate = new URLSearchParams(window.location.search).get('date') || '';
    load();
  });

  if (window.ResizeObserver) {
    new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect?.width || 0);
      if (data && width && Math.abs(width - lastWidth) > 12) {
        lastWidth = width;
        drawChart();
      }
    }).observe(byId('rhythm').parentElement);
  }
}

bindInteractions();
load();
