/* Sales canonical renderer v2: one fetch, one DOM owner, one chart owner. */
(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3) return;
  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = (v) => '$' + nf.format(Math.round(Number(v || 0)));
  const shortMoney = (v) => {
    const n = Number(v || 0),
      a = Math.abs(n);
    if (a >= 1e6) return `${n < 0 ? '−' : ''}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
    if (a >= 1e3) return `${n < 0 ? '−' : ''}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
    return `${n < 0 ? '−' : ''}$${Math.round(a)}`;
  };
  const pct = (v) =>
    v == null || !Number.isFinite(Number(v))
      ? '—'
      : `${Number(v) > 0 ? '+' : Number(v) < 0 ? '−' : ''}${Math.abs(Number(v)).toFixed(1)}%`;
  const cls = (v) => (Number(v) > 0 ? 'good' : Number(v) < 0 ? 'bad' : '');
  const esc = (s) =>
    String(s || '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const parseDate = (s) => (s ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`) : null);
  const sum = (rows, key) => d3.sum(rows || [], (r) => Number(r[key] || 0));
  const HIST = '#b78b4d',
    WEEKEND = '#d8c09b',
    CURRENT = '#e58b1f',
    MUTED = '#7b7369',
    RUNBG = '#f3dfc4',
    WEEKLINE = '#bfb7ac';
  const ORDER_MOBILE_LIMIT = 10;
  const PRODUCT_MOBILE_LIMIT = 6;
  const mobileHierarchy = window.matchMedia('(max-width: 720px)');
  let DATA = null,
    RANGE = '12m',
    ORDERS_EXPANDED = false,
    PRODUCTS_EXPANDED = false,
    resizeTimer = null;

  function set(id, text, tone = '') {
    const e = document.getElementById(id);
    if (!e) return;
    e.textContent = text;
    e.classList.remove('good', 'bad', 'warn');
    if (tone) e.classList.add(tone);
  }
  function age(sec) {
    sec = Number(sec || 0);
    if (sec < 3600) return Math.max(1, Math.round(sec / 60)) + 'm';
    if (sec < 86400) return (sec / 3600).toFixed(sec < 10800 ? 1 : 0) + 'h';
    return (sec / 86400).toFixed(sec < 259200 ? 1 : 0) + 'd';
  }
  function orderStatus(status) {
    const key = String(status || '')
      .trim()
      .toUpperCase();
    if (key === 'PENDING') return 'Amazon processing';
    if (key === 'PENDING_AVAILABILITY') return 'Amazon processing · availability';
    if (key === 'INVOICE_UNCONFIRMED') return 'Amazon processing · invoice';
    return String(status || '—');
  }
  function orderStatusTone(status) {
    const key = String(status || '')
      .trim()
      .toUpperCase();
    if (['PENDING', 'PENDING_AVAILABILITY', 'INVOICE_UNCONFIRMED'].includes(key)) return 'waiting';
    if (['SHIPPED', 'UNSHIPPED', 'PARTIALLY_SHIPPED'].includes(key)) return 'active';
    if (['CANCELLED', 'CANCELED', 'UNFULFILLABLE'].includes(key)) return 'problem';
    return 'neutral';
  }
  function monthName(s) {
    const d = parseDate(s);
    return d ? new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(d) : 'Month';
  }

  function renderSignals() {
    const h = DATA?.headline || {},
      t = DATA?.today || {},
      series = DATA?.series || [];
    set('mtdLabel', `${monthName(h.business_date)} MTD`);
    set('mtdSales', money(h.sales_mtd));
    set('mtdVolume', `${nf.format(h.orders_mtd || 0)} orders · ${nf.format(h.units_mtd || 0)} units`);
    set('mtdNote', `${pct(h.delta_mtd_pct)} vs same days last month`, cls(h.delta_mtd_pct));
    set('salesRunRate', money(h.projected_month_sales));
    set('t7Sales', money(h.sales_t7));
    set(
      't7Volume',
      `${nf.format(h.orders_t7 || 0)} orders · ${nf.format(sum(series.slice(-7), 'units'))} units`,
    );
    set('t7Note', `${pct(h.delta7_pct)} vs prior 7`, cls(h.delta7_pct));
    set('t28Sales', money(h.sales_t28));
    set('t28Volume', `${nf.format(h.orders_t28 || 0)} orders · ${nf.format(h.units_t28 || 0)} units`);
    set('t28Note', `${pct(h.delta28_pct)} vs prior 28`, cls(h.delta28_pct));
    set('todaySales', money(t.sales_today));
    set('todayMeta', `${t.orders_today || 0} orders · ${t.units_today || 0} units`);
    const ord = Number(t.orders_today || 0),
      pv = t.pace_vs_same_weekday_pct;
    set(
      'todayPace',
      ord < 3 ? 'Pace is still low-signal' : `${pct(pv)} vs same weekday / same time`,
      ord < 3 ? '' : cls(pv),
    );
    set('ytdLabel', `${String(h.business_date || '').slice(0, 4)} YTD`);
    set('ytdSales', money(h.sales_ytd));
    set('ytdVolume', `${nf.format(h.orders_ytd || 0)} orders · ${nf.format(h.units_ytd || 0)} units`);
    set('clock', DATA.local_time || '--:--');
    set('asof', 'Historical through ' + String(h.business_date || '').slice(5));
  }

  function renderProducts() {
    const out = document.getElementById('skuRows'),
      control = document.getElementById('productsMore'),
      rows = DATA?.skus || [],
      hiddenCount = Math.max(0, rows.length - PRODUCT_MOBILE_LIMIT);
    if (!out) return;
    out.innerHTML = rows
      .map((r, index) => {
        const img = r.image_url
          ? `<img class="product-thumb" src="${esc(r.image_url)}" alt="" loading="lazy">`
          : '';
        return `<tr${index >= PRODUCT_MOBILE_LIMIT ? ' class="product-reference-row"' : ''}><td><a class="product-line" href="/product?sku=${encodeURIComponent(r.sku)}">${img}<div style="min-width:0"><div class="product-sku">${esc(r.sku)}</div><div class="product-name">${esc(r.product || r.sku)}</div></div></a></td><td class="num"><strong>${money(r.sales_t28)}</strong></td><td class="num ${cls(r.delta28_pct)}">${pct(r.delta28_pct)}</td><td class="num">${nf.format(r.units_t28 || 0)}</td><td><span class="state ${esc(r.state)}">${esc(r.state)}</span></td></tr>`;
      })
      .join('');
    document.getElementById('products')?.classList.toggle('products-expanded', PRODUCTS_EXPANDED);
    if (!control) return;
    control.hidden = hiddenCount === 0;
    control.setAttribute('aria-expanded', PRODUCTS_EXPANDED ? 'true' : 'false');
    set('productsMoreLabel', PRODUCTS_EXPANDED ? 'Show leading products' : 'Show all products');
    set(
      'productsMoreCount',
      PRODUCTS_EXPANDED ? `${nf.format(rows.length)} shown` : `${nf.format(hiddenCount)} more`,
    );
  }
  function renderOrders() {
    const out = document.getElementById('orderRows'),
      control = document.getElementById('ordersMore'),
      rows = DATA?.orders || [],
      hiddenCount = Math.max(0, rows.length - ORDER_MOBILE_LIMIT);
    if (!out) return;
    out.innerHTML = rows
      .map((r, index) => {
        const details = Array.isArray(r.order_items)
          ? r.order_items
          : Array.isArray(r.item_details)
            ? r.item_details
            : [];
        const unitCount = details.reduce(
          (total, item) => total + Number(item.quantity_ordered ?? item.quantity ?? 0),
          0,
        );
        const items = details.length
          ? `<div class="sales-order-items__summary">${nf.format(details.length)} line item${details.length === 1 ? '' : 's'} · ${nf.format(unitCount)} unit${unitCount === 1 ? '' : 's'}</div>${details
              .map((item) => {
                const name = item.product || item.sku || item.asin || 'Item';
                const image = item.image_url
                  ? `<img src="${esc(item.image_url)}" alt="${esc(name)}" loading="lazy">`
                  : '<span class="sales-order-item__placeholder"></span>';
                const quantity = Number(item.quantity_ordered ?? item.quantity ?? 0);
                const identity = [item.sku, item.asin].filter(Boolean).join(' · ');
                return `<div class="sales-order-item">
                  ${image}
                  <div>
                    <strong>${esc(name)}</strong>
                    <span>${esc(identity || 'Identity unavailable')}</span>
                  </div>
                  <b>×${nf.format(quantity)}</b>
                </div>`;
              })
              .join('')}`
          : '<div class="sales-order-items__empty">Item details unavailable for this order.</div>';
        return `<tr${index >= ORDER_MOBILE_LIMIT ? ' class="order-reference-row"' : ''}>
          <td class="order-moment">
            <span class="order-moment__label">Order</span>
            <strong>${age(r.age_seconds)}</strong>
            <span>${esc(r.local_time || '')}</span>
            <code>${esc(r.order_short || '')}</code>
          </td>
          <td><div class="sales-order-items">${items}</div></td>
          <td class="order-spend">
            <strong>${money(r.sales)}</strong>
            <span>shopper spend incl. IVA</span>
          </td>
          <td class="order-status-cell">
            <span class="order-status-cell__label">Fulfillment</span>
            <span class="order-status-pill ${orderStatusTone(r.status)}">${esc(orderStatus(r.status))}</span>
          </td>
        </tr>`;
      })
      .join('');
    document.getElementById('orders')?.classList.toggle('orders-expanded', ORDERS_EXPANDED);
    if (!control) return;
    control.hidden = hiddenCount === 0;
    control.setAttribute('aria-expanded', ORDERS_EXPANDED ? 'true' : 'false');
    set('ordersMoreLabel', ORDERS_EXPANDED ? 'Show fewer orders' : 'Show all recent orders');
    set(
      'ordersMoreCount',
      ORDERS_EXPANDED ? `${nf.format(rows.length)} shown` : `${nf.format(hiddenCount)} more`,
    );
  }

  function ensureTip(host) {
    host.classList.add('dpp-chart-host');
    let tip = host.querySelector('.dpp-chart-tooltip.sales-period-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'dpp-chart-tooltip home-week-tooltip sales-period-tooltip';
      tip.setAttribute('role', 'status');
      host.appendChild(tip);
    }
    return tip;
  }
  function showTip(ctx, target, title, rows, footer) {
    const tip = ctx.tip,
      hr = ctx.host.getBoundingClientRect(),
      tr = target.getBoundingClientRect();
    tip.innerHTML = `<strong>${esc(title)}</strong>${rows.map((r) => `<span class="home-tip-row"><span class="home-tip-label">${esc(r.label)}</span><span class="home-tip-value">${esc(r.value)}</span></span>`).join('')}${footer ? `<span class="home-tip-footer">${esc(footer)}</span>` : ''}`;
    tip.style.visibility = 'hidden';
    tip.classList.add('show');
    const tw = tip.offsetWidth || 190,
      th = tip.offsetHeight || 120,
      center = tr.left - hr.left + tr.width / 2,
      right = center < hr.width / 2,
      gap = 12;
    let left;
    if (right) {
      left = Math.min(tr.right - hr.left + gap, hr.width - tw - 8);
      tip.style.transform = 'translate(0,-50%)';
    } else {
      left = Math.max(tr.left - hr.left - gap, tw + 8);
      tip.style.transform = 'translate(-100%,-50%)';
    }
    const yy = tr.top - hr.top + Math.max(18, tr.height * 0.42),
      y = Math.max(th / 2 + 8, Math.min(hr.height - th / 2 - 8, yy));
    tip.style.left = `${left}px`;
    tip.style.top = `${y}px`;
    tip.style.visibility = 'visible';
  }
  function hideTip(ctx) {
    ctx.tip?.classList.remove('show');
  }

  function shell(label, top = 38) {
    const svg = d3.select('#monthChart');
    if (svg.empty()) return null;
    svg.selectAll('*').remove();
    const node = svg.node(),
      host = node.parentElement,
      hostW = Math.max(320, host.getBoundingClientRect().width || 960),
      compact = hostW < 720,
      width = compact ? 520 : 960,
      height = 340,
      m = { top, right: compact ? 14 : 38, bottom: 44, left: compact ? 54 : 62 };
    svg
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'img')
      .attr('aria-label', label)
      .classed('dpp-chart', true);
    const iw = width - m.left - m.right,
      ih = height - m.top - m.bottom,
      plot = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    return { svg, node, host, tip: ensureTip(host), width, height, m, iw, ih, compact, plot };
  }
  function grid(ctx, y) {
    ctx.plot
      .append('g')
      .attr('class', 'dpp-grid')
      .call(d3.axisLeft(y).ticks(4).tickSize(-ctx.iw).tickFormat(''));
    ctx.plot
      .append('g')
      .attr('class', 'dpp-axis')
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(9).tickFormat(shortMoney))
      .call((g) => g.select('.domain').remove());
  }
  function axis(ctx, x, values, fmt) {
    ctx.plot
      .append('g')
      .attr('class', 'dpp-axis')
      .attr('transform', `translate(0,${ctx.ih})`)
      .call(d3.axisBottom(x).tickValues(values).tickSize(0).tickPadding(12).tickFormat(fmt))
      .call((g) => g.select('.domain').attr('stroke', '#cfc5b7'));
  }
  function copy(title, sub) {
    set('salesChartTitle', title);
    set('salesChartSub', sub);
  }
  function makePattern(svg, id) {
    const p = svg
      .append('defs')
      .append('pattern')
      .attr('id', id)
      .attr('width', 7)
      .attr('height', 7)
      .attr('patternUnits', 'userSpaceOnUse')
      .attr('patternTransform', 'rotate(45)');
    p.append('rect').attr('width', 7).attr('height', 7).attr('fill', RUNBG).attr('opacity', 0.48);
    p.append('line')
      .attr('x1', 0)
      .attr('y1', 0)
      .attr('x2', 0)
      .attr('y2', 7)
      .attr('stroke', CURRENT)
      .attr('stroke-width', 1.7)
      .attr('opacity', 0.48);
  }
  function runLabel(sel) {
    sel
      .style('fill', MUTED)
      .style('font-size', '8.5px')
      .style('font-weight', '650')
      .style('letter-spacing', '.015em');
  }

  function monthData(rows) {
    const h = DATA.headline || {};
    return (rows || [])
      .map((r) => ({
        ...r,
        key: String(r.month || '').slice(0, 7),
        date: parseDate(`${String(r.month || '').slice(0, 7)}-01`),
        value: Number(r.sales || 0),
        orders: Number(r.orders || 0),
        units: Number(r.units || 0),
        projection: r.partial ? Number(h.projected_month_sales || 0) : 0,
      }))
      .filter((r) => r.key && r.date)
      .sort((a, b) => d3.ascending(a.key, b.key));
  }
  function drawMonthly(rows, isFull = false) {
    const data = monthData(rows);
    if (!data.length) return;
    const h = DATA.headline || {};
    copy(
      isFull ? 'Full sales history' : 'Monthly sales',
      isFull
        ? `Monthly sales · ${data.length} months · year boundaries${data.at(-1)?.partial ? ' · current month partial' : ''}`
        : '12 months · current month actual + run rate',
    );
    const c = shell(
      isFull
        ? 'Full monthly sales history with year boundaries'
        : 'Twelve months of monthly sales with current-month run rate',
    );
    const x = d3
        .scaleBand()
        .domain(data.map((r) => r.key))
        .range([0, c.iw])
        .padding(0.3),
      y = d3
        .scaleLinear()
        .domain([0, d3.max(data, (r) => Math.max(r.value, r.projection || 0)) || 1])
        .nice(4)
        .range([c.ih, 0]);
    grid(c, y);
    const pid = isFull ? 'sales-full-runrate' : 'sales-month-runrate';
    makePattern(c.svg, pid);
    const bars = c.plot
      .selectAll('.sales-month')
      .data(data)
      .join('rect')
      .attr('class', 'dpp-bar sales-month')
      .attr('x', (r) => x(r.key))
      .attr('width', x.bandwidth())
      .attr('y', (r) => y(r.value))
      .attr('height', (r) => Math.max(1, c.ih - y(r.value)))
      .attr('rx', 4)
      .attr('fill', (r) => (r.partial ? CURRENT : HIST));
    const ghost = data.filter((r) => r.projection > r.value);
    c.plot
      .selectAll('.sales-runrate-ghost')
      .data(ghost)
      .join('rect')
      .attr('class', 'dpp-bar sales-runrate-ghost')
      .attr('x', (r) => x(r.key))
      .attr('width', x.bandwidth())
      .attr('y', (r) => y(r.projection))
      .attr('height', (r) => Math.max(1, y(r.value) - y(r.projection)))
      .attr('rx', 4)
      .attr('fill', `url(#${pid})`)
      .attr('stroke', CURRENT)
      .attr('stroke-width', 1)
      .attr('stroke-opacity', 0.72);
    if (isFull) {
      const years = d3.groups(data, (r) => r.date.getUTCFullYear()),
        layer = c.plot.append('g').attr('pointer-events', 'none');
      years.forEach(([year, items], i) => {
        const left = x(items[0].key),
          right = x(items.at(-1).key) + x.bandwidth(),
          center = (left + right) / 2;
        if (i > 0) {
          const divider = left - (x.step() - x.bandwidth()) / 2;
          layer
            .append('line')
            .attr('x1', divider)
            .attr('x2', divider)
            .attr('y1', 18)
            .attr('y2', c.ih)
            .attr('stroke', '#aaa197')
            .attr('stroke-width', 1)
            .attr('stroke-dasharray', '3 4')
            .attr('opacity', 0.76);
        }
        layer
          .append('text')
          .attr('x', center)
          .attr('y', 11)
          .attr('text-anchor', 'middle')
          .attr('fill', MUTED)
          .attr('font-size', 8.7)
          .attr('font-weight', 760)
          .attr('letter-spacing', '.06em')
          .text(String(year));
      });
    }
    if (!c.compact && data.length <= 16)
      c.plot
        .selectAll('.sales-month-value')
        .data(data.filter((r) => !r.partial))
        .join('text')
        .attr('class', 'dpp-value sales-month-value')
        .attr('x', (r) => x(r.key) + x.bandwidth() / 2)
        .attr('y', (r) => y(r.value) - 8)
        .attr('text-anchor', 'middle')
        .text((r) => shortMoney(r.value));
    const labels = c.plot
      .selectAll('.sales-runrate-label')
      .data(ghost)
      .join('text')
      .attr('class', 'sales-runrate-label')
      .attr('x', (r) => x(r.key) + x.bandwidth() / 2)
      .attr('y', (r) => Math.max(18, y(r.projection) - 8))
      .attr('text-anchor', 'middle')
      .text((r) => `Run rate · ${shortMoney(r.projection)}`);
    runLabel(labels);
    let ticks = data;
    if (isFull && data.length > 18)
      ticks = data.filter((r, i) => r.date.getUTCMonth() % 3 === 0 || i === 0 || i === data.length - 1);
    axis(
      c,
      x,
      ticks.map((r) => r.key),
      (k) => d3.utcFormat('%b')(parseDate(`${k}-01`)),
    );
    bars
      .attr('tabindex', 0)
      .on('pointerenter pointermove focus', function (e, r) {
        const rows = [{ label: 'Sales', value: money(r.value) }];
        if (r.partial) rows.push({ label: 'MTD', value: 'partial' });
        showTip(
          c,
          this,
          d3.utcFormat('%B %Y')(r.date),
          rows,
          `${nf.format(r.orders)} orders · ${nf.format(r.units)} units`,
        );
      })
      .on('pointerleave blur', () => hideTip(c));
    if (isFull) {
      const fullRows = DATA.months_full || DATA.months || [],
        total = sum(fullRows, 'sales'),
        orders = sum(fullRows, 'orders'),
        units = sum(fullRows, 'units'),
        last12 = fullRows.slice(-12),
        prior12 = fullRows.slice(-24, -12),
        a = sum(last12, 'sales'),
        b = sum(prior12, 'sales'),
        delta = b > 0 ? (100 * (a - b)) / b : null;
      renderKpis([
        { l: 'Full history sales', v: money(total), n: `${fullRows.length} months` },
        { l: 'Orders · units', v: `${nf.format(orders)} · ${nf.format(units)}`, n: 'full history' },
        {
          l: 'Monthly pace',
          v: fullRows.length ? money(total / fullRows.length) : '—',
          n: 'average / month',
        },
        { l: 'Benchmark', v: pct(delta), n: 'last 12M vs prior 12M', tone: cls(delta) },
      ]);
    } else
      renderKpis([
        { l: `${monthName(h.business_date)} MTD sales`, v: money(h.sales_mtd), n: 'current open month' },
        {
          l: 'Orders · units',
          v: `${nf.format(h.orders_mtd || 0)} · ${nf.format(h.units_mtd || 0)}`,
          n: 'month to date',
        },
        { l: 'Pace', v: `${money(h.daily_avg_mtd)}/day`, n: `run rate ${money(h.projected_month_sales)}` },
        { l: 'Benchmark', v: pct(h.delta_mtd_pct), n: 'vs same days last month', tone: cls(h.delta_mtd_pct) },
      ]);
  }

  function weeksFromRows(rows) {
    const daily = (rows || [])
      .map((r) => ({
        date: parseDate(r.business_date),
        sales: Number(r.sales || 0),
        orders: Number(r.orders || 0),
        units: Number(r.units || 0),
      }))
      .filter((r) => r.date)
      .sort((a, b) => d3.ascending(a.date, b.date));
    return d3
      .rollups(
        daily,
        (v) => {
          const daySales = Array(7).fill(0);
          v.forEach((x) => {
            daySales[(x.date.getUTCDay() + 6) % 7] += x.sales;
          });
          return {
            sales: sum(v, 'sales'),
            orders: sum(v, 'orders'),
            units: sum(v, 'units'),
            days: v.length,
            dates: v.map((x) => x.date).sort(d3.ascending),
            daySales,
          };
        },
        (r) => +d3.utcMonday.floor(r.date),
      )
      .map(([k, v]) => ({ week: new Date(Number(k)), ...v }))
      .sort((a, b) => d3.ascending(a.week, b.week));
  }
  function currentWeekProjection(weeks) {
    const current = weeks.at(-1);
    if (!current || current.days <= 0 || current.days >= 7 || current.sales <= 0) return null;
    const prior = weeks
      .slice(0, -1)
      .filter((w) => w.days >= 7 && w.sales > 0)
      .slice(-8);
    if (!prior.length) return null;
    const latest = current.dates.at(-1),
      elapsed = (latest.getUTCDay() + 6) % 7,
      shares = prior
        .map((w) => d3.sum(w.daySales.slice(0, elapsed + 1)) / w.sales)
        .filter((v) => Number.isFinite(v) && v > 0.04 && v <= 1),
      baseline = d3.mean(prior.slice(-4), (w) => w.sales) || 0,
      hshare = d3.mean(shares),
      pace = hshare > 0 ? current.sales / hshare : (current.sales / Math.max(current.days, 1)) * 7,
      confidence = Math.min(1, Math.max(1, current.days) / 7),
      projected = Math.max(current.sales, baseline * (1 - confidence) + pace * confidence);
    return { current, latest, projected };
  }
  function drawWeekly() {
    const rows = (DATA.series || []).slice(-90),
      weeks = weeksFromRows(rows).slice(-13);
    if (!weeks.length) return;
    const projection = currentWeekProjection(weeks);
    copy('Weekly sales', `90 days · weekly sales${weeks.at(-1).days < 7 ? ' · current week partial' : ''}`);
    const c = shell('Ninety days of weekly sales');
    const ymax = d3.max(weeks, (w) => Math.max(w.sales, projection?.projected || 0)) || 1,
      x = d3
        .scaleBand()
        .domain(weeks.map((w) => +w.week))
        .range([0, c.iw])
        .padding(0.3),
      y = d3.scaleLinear().domain([0, ymax]).nice(4).range([c.ih, 0]);
    grid(c, y);
    const current = weeks.at(-1),
      bars = c.plot
        .selectAll('.sales-week')
        .data(weeks)
        .join('rect')
        .attr('class', 'dpp-bar sales-week')
        .attr('x', (w) => x(+w.week))
        .attr('width', x.bandwidth())
        .attr('y', (w) => y(w.sales))
        .attr('height', (w) => Math.max(1, c.ih - y(w.sales)))
        .attr('rx', 4)
        .attr('fill', (w) => (w === current && w.days < 7 ? CURRENT : HIST));
    if (projection && projection.projected > current.sales) {
      const pid = 'sales-week-runrate';
      makePattern(c.svg, pid);
      c.plot
        .append('rect')
        .attr('class', 'sales-week-runrate')
        .attr('x', x(+current.week))
        .attr('width', x.bandwidth())
        .attr('y', y(projection.projected))
        .attr('height', Math.max(1, y(current.sales) - y(projection.projected)))
        .attr('rx', 4)
        .attr('fill', `url(#${pid})`)
        .attr('stroke', CURRENT)
        .attr('stroke-width', 1)
        .attr('stroke-opacity', 0.72);
      const lab = c.plot
        .append('text')
        .attr('class', 'sales-week-runrate-label')
        .attr('x', x(+current.week) + x.bandwidth() / 2)
        .attr('y', Math.max(18, y(projection.projected) - 8))
        .attr('text-anchor', 'middle')
        .text(`Run rate · ${shortMoney(projection.projected)}`);
      runLabel(lab);
    }
    axis(
      c,
      x,
      weeks.filter((w, i) => i === 0 || i === weeks.length - 1 || i % 3 === 0).map((w) => +w.week),
      (v) => d3.utcFormat('%b %-d')(new Date(Number(v))),
    );
    weeks.forEach((w, i) => {
      w.previous = i > 0 ? weeks[i - 1] : null;
      const prior = weeks
        .slice(0, i)
        .filter((x) => x.days >= 7)
        .slice(-4);
      w.benchmark = w.days >= 7 && prior.length === 4 ? d3.mean(prior, (x) => x.sales) : null;
    });
    bars
      .attr('tabindex', 0)
      .on('pointerenter pointermove focus', function (e, w) {
        const tr = [{ label: 'Sales', value: money(w.sales) }];
        if (w.days >= 7) {
          if (w.previous?.days >= 7 && w.previous.sales > 0)
            tr.push({ label: 'LW', value: pct((100 * (w.sales - w.previous.sales)) / w.previous.sales) });
          if (w.benchmark > 0)
            tr.push({ label: '4W', value: pct((100 * (w.sales - w.benchmark)) / w.benchmark) });
        } else tr.push({ label: 'WTD', value: 'partial' });
        showTip(
          c,
          this,
          `Week of ${d3.utcFormat('%b %-d')(w.week)}`,
          tr,
          `${nf.format(w.orders)} orders · ${nf.format(w.units)} units`,
        );
      })
      .on('pointerleave blur', () => hideTip(c));
    const sales = sum(rows, 'sales'),
      orders = sum(rows, 'orders'),
      units = sum(rows, 'units'),
      complete = weeks.filter((w) => w.days >= 7),
      recent = sum(complete.slice(-4), 'sales'),
      prior = sum(complete.slice(-8, -4), 'sales'),
      delta = prior > 0 ? (100 * (recent - prior)) / prior : null,
      pace = projection?.projected || current.sales;
    renderKpis([
      { l: '90D sales', v: money(sales), n: 'reconciled period' },
      { l: 'Orders · units', v: `${nf.format(orders)} · ${nf.format(units)}`, n: 'last 90 days' },
      {
        l: 'Pace',
        v: `${money(pace)}/week`,
        n: projection
          ? `weekday-adjusted · through ${d3.utcFormat('%a')(projection.latest)}`
          : 'latest completed week',
      },
      { l: 'Benchmark', v: pct(delta), n: 'last 4W vs prior 4W', tone: cls(delta) },
    ]);
  }

  function drawMonthBoundary(c, x, rows) {
    if (rows.length < 2) return;
    const last = rows.at(-1).date,
      start = d3.utcMonth.floor(last);
    if (+rows[0].date >= +start) return;
    const first = rows.find((r) => +r.date >= +start);
    if (!first) return;
    const divider = x(+first.date) - (x.step() - x.bandwidth()) / 2;
    c.plot
      .append('line')
      .attr('x1', divider)
      .attr('x2', divider)
      .attr('y1', 0)
      .attr('y2', c.ih)
      .attr('stroke', CURRENT)
      .attr('stroke-width', 1.3)
      .attr('opacity', 0.72);
    c.plot
      .append('text')
      .attr('x', divider + 7)
      .attr('y', 11)
      .attr('fill', MUTED)
      .attr('font-size', 9)
      .attr('font-weight', 760)
      .attr('letter-spacing', '.05em')
      .text(d3.utcFormat('%b')(start).toUpperCase());
    const prev = d3.utcMonth.offset(start, -1),
      key = d3.utcFormat('%Y-%m')(prev),
      closed = (DATA.months || []).find((r) => String(r.month || '').slice(0, 7) === key && !r.partial);
    if (closed)
      c.plot
        .append('text')
        .attr('x', divider - 7)
        .attr('y', 11)
        .attr('text-anchor', 'end')
        .attr('fill', MUTED)
        .attr('font-size', 9)
        .attr('font-weight', 650)
        .attr('letter-spacing', '.02em')
        .text(`${d3.utcFormat('%b')(prev).toUpperCase()} CLOSED · ${shortMoney(closed.sales)}`);
  }
  function drawDaily() {
    const h = DATA.headline || {},
      rows = (DATA.series || [])
        .slice(-28)
        .map((r) => ({
          date: parseDate(r.business_date),
          sales: Number(r.sales || 0),
          orders: Number(r.orders || 0),
          units: Number(r.units || 0),
        }))
        .filter((r) => r.date)
        .sort((a, b) => d3.ascending(a.date, b.date));
    if (!rows.length) return;
    copy('Daily sales', '28 days · daily sales · week and month boundaries');
    const c = shell('Twenty-eight days of daily sales with week and month boundaries');
    const x = d3
        .scaleBand()
        .domain(rows.map((r) => +r.date))
        .range([0, c.iw])
        .padding(0.25),
      y = d3
        .scaleLinear()
        .domain([0, d3.max(rows, (r) => r.sales) || 1])
        .nice(4)
        .range([c.ih, 0]);
    grid(c, y);
    const bars = c.plot
      .selectAll('.sales-day')
      .data(rows)
      .join('rect')
      .attr('class', 'dpp-bar sales-day')
      .attr('x', (r) => x(+r.date))
      .attr('width', x.bandwidth())
      .attr('y', (r) => y(r.sales))
      .attr('height', (r) => Math.max(1, c.ih - y(r.sales)))
      .attr('rx', 4)
      .attr('fill', (r) => {
        const d = r.date.getUTCDay();
        return d === 0 || d === 6 ? WEEKEND : HIST;
      });
    rows.forEach((r, i) => {
      if (i === 0 || r.date.getUTCDay() !== 1) return;
      const xx = x(+r.date) - (x.step() - x.bandwidth()) / 2;
      c.plot
        .append('line')
        .attr('x1', xx)
        .attr('x2', xx)
        .attr('y1', 22)
        .attr('y2', c.ih)
        .attr('stroke', WEEKLINE)
        .attr('stroke-width', 0.8)
        .attr('opacity', 0.35);
    });
    drawMonthBoundary(c, x, rows);
    axis(
      c,
      x,
      rows.filter((r, i) => i === 0 || i === rows.length - 1 || i % 7 === 0).map((r) => +r.date),
      (v) => d3.utcFormat('%b %-d')(new Date(Number(v))),
    );
    rows.forEach((r, i) => {
      r.prev = i ? rows[i - 1] : null;
      r.avg7 = i >= 7 ? d3.mean(rows.slice(i - 7, i), (x) => x.sales) : null;
    });
    bars
      .attr('tabindex', 0)
      .on('pointerenter pointermove focus', function (e, r) {
        const tr = [{ label: 'Sales', value: money(r.sales) }];
        if (r.prev?.sales > 0)
          tr.push({ label: 'PD', value: pct((100 * (r.sales - r.prev.sales)) / r.prev.sales) });
        if (r.avg7 > 0) tr.push({ label: '7D', value: pct((100 * (r.sales - r.avg7)) / r.avg7) });
        showTip(
          c,
          this,
          d3.utcFormat('%a, %b %-d')(r.date),
          tr,
          `${nf.format(r.orders)} orders · ${nf.format(r.units)} units`,
        );
      })
      .on('pointerleave blur', () => hideTip(c));
    renderKpis([
      { l: '28D sales', v: money(h.sales_t28), n: 'reconciled period' },
      {
        l: 'Orders · units',
        v: `${nf.format(h.orders_t28 || 0)} · ${nf.format(h.units_t28 || 0)}`,
        n: 'last 28 days',
      },
      { l: 'Pace', v: `${money(h.daily_avg_t28)}/day`, n: '28-day average' },
      { l: 'Benchmark', v: pct(h.delta28_pct), n: 'vs prior 28 days', tone: cls(h.delta28_pct) },
    ]);
  }

  function renderKpis(items) {
    const rail = document.getElementById('salesChartKpiRail');
    if (!rail) return;
    rail.innerHTML = items
      .map(
        (i) =>
          `<div class="sales-chart-kpi"><div class="sales-chart-kpi-label">${i.l}</div><div class="sales-chart-kpi-value ${i.tone || ''}">${i.v}</div><div class="sales-chart-kpi-note">${i.n}</div></div>`,
      )
      .join('');
  }
  function renderChart() {
    if (!DATA) return;
    if (RANGE === 'full') {
      drawMonthly(DATA.months_full || DATA.months || [], true);
      return;
    }
    if (RANGE === '90d') {
      drawWeekly();
      return;
    }
    if (RANGE === '28d') {
      drawDaily();
      return;
    }
    drawMonthly(DATA.months || [], false);
  }
  function render() {
    renderSignals();
    renderProducts();
    renderOrders();
    renderChart();
  }

  function bind() {
    document.querySelectorAll('.tabs button').forEach((b) =>
      b.addEventListener('click', () => {
        document.querySelectorAll('.tabs button').forEach((x) => x.classList.remove('active'));
        document.querySelectorAll('.view').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        document.getElementById(b.dataset.view)?.classList.add('active');
      }),
    );
    document.querySelector('.sales-range')?.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-range]');
      if (!b || b.dataset.range === RANGE) return;
      RANGE = b.dataset.range;
      document.querySelectorAll('.sales-range button').forEach((x) => {
        const on = x === b;
        x.classList.toggle('active', on);
        x.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      renderChart();
    });
    document.getElementById('ordersMore')?.addEventListener('click', () => {
      ORDERS_EXPANDED = !ORDERS_EXPANDED;
      renderOrders();
    });
    document.getElementById('productsMore')?.addEventListener('click', () => {
      PRODUCTS_EXPANDED = !PRODUCTS_EXPANDED;
      renderProducts();
    });
    const reference = document.getElementById('salesReference');
    const updateReferenceToggle = () => {
      set('salesReferenceToggle', reference?.open ? 'Hide ↑' : 'View ↓');
    };
    if (reference) {
      reference.open = !mobileHierarchy.matches;
      reference.addEventListener('toggle', updateReferenceToggle);
      updateReferenceToggle();
    }
    mobileHierarchy.addEventListener('change', (event) => {
      if (reference) reference.open = !event.matches;
    });
    const host = document.querySelector('.sales-chart-card');
    if ('ResizeObserver' in window && host) {
      new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(renderChart, 100);
      }).observe(host);
    } else
      window.addEventListener(
        'resize',
        () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(renderChart, 140);
        },
        { passive: true },
      );
  }
  async function load() {
    try {
      const r = await fetch('/api/sales', { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      DATA = await r.json();
      render();
    } catch (e) {
      set('asof', 'Sales data unavailable');
      console.error(e);
    }
  }
  bind();
  load();
  setInterval(load, 60000);
})();
