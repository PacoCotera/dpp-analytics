/* Today canonical operating composition v4
   Single composition owner on top of the base Today data renderer.
   No duplicate fetches, MutationObservers, delayed rerenders, or UA sniffing. */
(() => {
  'use strict';
  if (!document.body.classList.contains('today-shell')) return;
  if (document.documentElement.classList.contains('wall-mode')) return;
  if (document.body.dataset.todayCanonical === '1') return;
  document.body.dataset.todayCanonical = '1';
  document.body.classList.add('today-operating-v2', 'today-operating-v3', 'today-operating-v4');

  const d3 = window.d3;
  if (!d3) return;

  const picker = document.getElementById('dayPicker');
  const hero = document.querySelector('.hero');
  const heroMain = hero?.querySelector('.hero-main');
  const latest = hero?.querySelector('.latest');
  const context = document.querySelector('.context-strip');
  const eyebrow = document.getElementById('salesEyebrow');
  if (!picker || !hero || !heroMain || !latest || !context || !eyebrow) return;

  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = v => '$' + nf.format(Math.round(Number(v || 0)));
  const shortMoney = v => {
    const n = Number(v || 0), a = Math.abs(n);
    if (a >= 1000000) return `${n < 0 ? '−' : ''}$${(a / 1000000).toFixed(a >= 10000000 ? 0 : 1)}m`;
    if (a >= 1000) return `${n < 0 ? '−' : ''}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
    return `${n < 0 ? '−' : ''}$${Math.round(a)}`;
  };
  const parseDate = s => s ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`) : null;
  const shift = (s, n) => { const d = parseDate(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const weekdayLetter = d => ['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getUTCDay()];
  const pct = v => v == null || !Number.isFinite(Number(v)) ? '—' : `${Number(v) >= 0 ? '+' : '−'}${Math.abs(Number(v)).toFixed(0)}%`;
  const monthName = s => new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(parseDate(s));
  const weekdayName = s => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(parseDate(s));

  const stage = document.createElement('section');
  stage.className = 'today-operating-stage';
  stage.setAttribute('aria-label', 'Current business state');
  const main = document.createElement('div');
  main.className = 'today-operating-main';
  const rail = document.createElement('aside');
  rail.className = 'today-state-rail';
  rail.setAttribute('aria-label', 'Today operating context');
  hero.before(stage);
  stage.append(main, rail);
  main.appendChild(heroMain);
  rail.appendChild(latest);

  const heroHead = document.createElement('div');
  heroHead.className = 'today-hero-head';
  heroMain.insertBefore(heroHead, heroMain.firstChild);
  heroHead.append(eyebrow, picker);

  const pulse = document.createElement('section');
  pulse.className = 'today-pulse-read';
  pulse.innerHTML = '<div class="today-pulse-kicker">Business pulse</div><strong id="pulseHeadline">Reading today…</strong><p id="pulseExplanation">Comparing the current day with recent operating context.</p>';
  rail.prepend(pulse);

  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'today-kpi-grid';
  [...context.children].forEach(node => { node.classList.add('today-state-row'); kpiGrid.appendChild(node); });
  pulse.after(kpiGrid);
  const labels = { weekLabel: 'WTD', mtdLabel: 'MTD', last30Label: '30D' };
  Object.entries(labels).forEach(([id, text]) => { const el = document.getElementById(id); if (el) el.dataset.compactLabel = text; });

  const latestLabel = document.getElementById('latestLabel');
  if (latestLabel) latestLabel.textContent = 'Latest sale';
  const rhythmTitle = document.querySelector('.content-grid > .panel:first-child .panel-title');
  if (rhythmTitle) rhythmTitle.textContent = 'Recent rhythm';

  const wins = document.querySelector('.wins');
  if (wins) {
    wins.classList.add('today-orders-compact');
    const stream = wins.querySelector('#stream');
    const sourceHead = wins.querySelector('.panel-head');
    if (sourceHead) sourceHead.hidden = true;
    const details = document.createElement('details');
    details.className = 'today-orders-details';
    const summary = document.createElement('summary');
    summary.innerHTML = '<span><strong>Orders</strong><small id="orderSummaryText">Transaction evidence for the selected day</small></span><b>View ↓</b>';
    if (stream) details.append(summary, stream);
    wins.appendChild(details);
    details.addEventListener('toggle', () => { const b = summary.querySelector('b'); if (b) b.textContent = details.open ? 'Hide ↑' : 'View ↓'; });
  }

  /* Replace the base picker function itself. The old long labels are never painted. */
  buildDayPicker = function canonicalDayPicker(localToday) {
    if (wall) return;
    const chosen = DATA?.selected_date || localToday;
    const limit = Math.min(7, Number(DATA?.history_limit_days ?? 7));
    picker.innerHTML = Array.from({ length: limit + 1 }, (_, i) => {
      const ds = shift(localToday, -i), d = parseDate(ds), live = i === 0;
      const long = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
      return `<button class="day-choice ${live ? 'live partial ' : ''}${ds === chosen ? 'active' : ''}" data-date="${ds}" data-canonical="1" title="${long}${live ? ' · live' : ''}" aria-label="${long}${live ? ' · live' : ''}"><b>${live ? 'Today' : weekdayLetter(d)}</b><span>${live ? '' : d.getUTCDate()}</span></button>`;
    }).join('');
    picker.querySelectorAll('.day-choice').forEach(b => b.onclick = () => selectDay(b.dataset.date));
    document.body.dataset.dayMode = picker.querySelector('.day-choice.active')?.classList.contains('live') ? 'live' : 'closed';
  };

  function renderPulse(d) {
    const t = d?.today || {}, c = d?.context || {};
    const live = !!d?.is_live, orders = Number(t.orders_today || 0), pace = Number(t.pace_vs_same_weekday_pct);
    const mtd = Number(c.mtd_delta_pct), week = Number(c.week_delta_pct);
    const day = weekdayName(d.selected_date || d.local_today);
    let headline, explanation;
    if (live && orders < 3) {
      headline = orders === 0 ? 'Still waiting for the day to declare itself' : 'Still early';
      explanation = orders === 0 ? `No orders yet. ${monthName(d.selected_date || d.local_today)} MTD is ${pct(mtd)} vs the same days last month.` : `Only ${orders} order${orders === 1 ? '' : 's'} so far, so today’s pace is still low-signal. MTD is ${pct(mtd)}.`;
    } else if (pace >= 15) {
      headline = `${live ? 'Ahead of' : 'A strong'} typical ${day} pace`;
      explanation = `${pct(pace)} vs comparable ${day.toLowerCase()} performance. Week is ${pct(week)} and MTD ${pct(mtd)}.`;
    } else if (pace <= -15) {
      headline = `${live ? 'Behind' : 'A soft'} typical ${day} pace`;
      explanation = `${pct(pace)} vs comparable ${day.toLowerCase()} performance. Week is ${pct(week)} and MTD ${pct(mtd)}.`;
    } else {
      headline = `Tracking near a typical ${day}`;
      explanation = `${pct(pace)} vs comparable ${day.toLowerCase()} performance. Week is ${pct(week)} and MTD ${pct(mtd)}.`;
    }
    document.getElementById('pulseHeadline').textContent = headline;
    document.getElementById('pulseExplanation').textContent = explanation;
    const os = document.getElementById('orderSummaryText');
    if (os) os.textContent = `${orders} order${orders === 1 ? '' : 's'} · ${Number(t.units_today || 0)} units · ${money(t.sales_today || 0)}`;
    const productsTitle = document.getElementById('productsTitle');
    if (productsTitle) productsTitle.textContent = live ? 'What is driving today' : 'What drove that day';
    const productsSub = document.getElementById('productsSub');
    if (productsSub) productsSub.textContent = 'Product mix · sales contribution';
  }

  const baseRender = render;
  render = function canonicalRender(d) { baseRender(d); renderPulse(d); };

  function ensureRhythmRail(host) {
    const panel = host.closest('.panel');
    if (!panel) return null;
    let out = panel.querySelector('.today-rhythm-kpi-rail');
    if (!out) { out = document.createElement('div'); out.className = 'today-rhythm-kpi-rail'; panel.appendChild(out); }
    return out;
  }

  function renderRhythmRail(host, rows) {
    const out = ensureRhythmRail(host); if (!out) return;
    const sales = d3.sum(rows, r => Number(r.sales || 0)), orders = d3.sum(rows, r => Number(r.orders || 0)), units = d3.sum(rows, r => Number(r.units || 0)), pace = sales / Math.max(1, rows.length);
    out.innerHTML = `<div class="today-rhythm-kpi"><div class="label">Sales</div><strong>${money(sales)}</strong><small>selected window</small></div><div class="today-rhythm-kpi"><div class="label">Orders · units</div><strong>${orders} · ${units}</strong><small>volume</small></div><div class="today-rhythm-kpi"><div class="label">Daily pace</div><strong>${money(pace)}</strong><small>average / day</small></div><div class="today-rhythm-kpi"><div class="label">Range</div><strong>${rows.length}D</strong><small>${rows.length ? d3.utcFormat('%b %-d')(parseDate(rows[0].business_date)) : '—'} → ${rows.length ? d3.utcFormat('%b %-d')(parseDate(rows.at(-1).business_date)) : '—'}</small></div>`;
  }

  function drawMeasuredRhythm(selector, inputRows, opts = {}) {
    const svg = d3.select(selector); if (svg.empty()) return;
    const node = svg.node(), host = node.parentElement;
    const rows = (inputRows || []).map(r => ({ ...r, date: parseDate(r.business_date), sales: Number(r.sales || 0), orders: Number(r.orders || 0), units: Number(r.units || 0) })).filter(r => r.date);
    if (!rows.length) { svg.selectAll('*').remove(); return; }
    const width = Math.max(300, Math.round(host.getBoundingClientRect().width));
    const compact = width < 560, height = compact ? 190 : width < 900 ? 184 : 178;
    const m = { top: 12, right: 8, bottom: 30, left: compact ? 44 : 50 }, iw = width - m.left - m.right, ih = height - m.top - m.bottom;
    svg.selectAll('*').remove(); svg.attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'xMidYMid meet').classed('dpp-chart', true);
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    const x = d3.scaleBand().domain(rows.map(r => r.business_date)).range([0, iw]).padding(rows.length <= 8 ? .18 : .24);
    const y = d3.scaleLinear().domain([0, d3.max(rows, r => r.sales) || 1]).nice(4).range([ih, 0]);
    g.append('g').attr('class', 'dpp-grid').call(d3.axisLeft(y).ticks(4).tickSize(-iw).tickFormat(''));
    g.append('g').attr('class', 'dpp-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(7).tickFormat(shortMoney)).call(a => a.select('.domain').remove());
    const selected = rows.at(-1)?.business_date;
    const bars = g.selectAll('rect.today-rhythm-bar').data(rows).join('rect').attr('class', 'dpp-bar today-rhythm-bar').attr('x', r => x(r.business_date)).attr('width', x.bandwidth()).attr('y', r => y(r.sales)).attr('height', r => Math.max(1, ih - y(r.sales))).attr('rx', Math.min(4, x.bandwidth() / 4)).attr('fill', r => { const dow = r.date.getUTCDay(); if (opts.live && r.business_date === selected) return '#e58b1f'; return dow === 0 || dow === 6 ? '#d8c09b' : '#b78b4d'; });
    const dividers = g.append('g').attr('pointer-events', 'none');
    rows.forEach((r, i) => { if (!i) return; const prev = rows[i - 1], xx = x(r.business_date) - (x.step() - x.bandwidth()) / 2; if (r.date.getUTCMonth() !== prev.date.getUTCMonth()) dividers.append('line').attr('x1', xx).attr('x2', xx).attr('y1', 0).attr('y2', ih).attr('stroke', '#e58b1f').attr('stroke-width', 1.4).attr('opacity', .82); else if (r.date.getUTCDay() === 1) dividers.append('line').attr('x1', xx).attr('x2', xx).attr('y1', 0).attr('y2', ih).attr('stroke', '#c9c0b4').attr('stroke-width', .8).attr('opacity', .48); });
    const targetTicks = rows.length <= 8 ? rows.length : width < 520 ? 4 : width < 850 ? 5 : 7, step = Math.max(1, Math.ceil(rows.length / targetTicks));
    const ticks = rows.filter((r, i) => rows.length <= 8 || i === 0 || i === rows.length - 1 || i % step === 0).map(r => r.business_date);
    g.append('g').attr('class', 'dpp-axis').attr('transform', `translate(0,${ih})`).call(d3.axisBottom(x).tickValues(ticks).tickSize(0).tickPadding(8).tickFormat(k => d3.utcFormat(rows.length <= 8 ? '%a' : '%-d')(parseDate(k)))).call(a => a.select('.domain').attr('stroke', '#cfc5b7'));
    let tip = host.querySelector('.today-rhythm-tip'); if (!tip) { tip = document.createElement('div'); tip.className = 'dpp-chart-tooltip today-rhythm-tip'; host.appendChild(tip); }
    bars.attr('tabindex', 0).on('pointerenter pointermove focus', function(_ev, r) { if (host.getBoundingClientRect().width < 640) return; const hr = host.getBoundingClientRect(), br = this.getBoundingClientRect(); tip.innerHTML = `<strong>${d3.utcFormat('%a, %b %-d')(r.date)}</strong><span>Sales ${money(r.sales)}</span><span>${r.orders} orders · ${r.units} units</span>`; tip.style.left = `${Math.min(hr.width - 90, Math.max(90, br.left - hr.left + br.width / 2))}px`; tip.style.top = `${Math.max(54, br.top - hr.top + 8)}px`; tip.classList.add('show'); }).on('pointerleave blur', () => tip.classList.remove('show'));
    renderRhythmRail(host, rows);
  }

  window.DPPCharts = window.DPPCharts || {};
  window.DPPCharts.dailyRhythm = drawMeasuredRhythm;

  const rhythm = document.getElementById('rhythm'), rhythmHost = rhythm?.parentElement;
  let lastChartWidth = 0;
  if (rhythmHost && window.ResizeObserver) {
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0]?.contentRect?.width || 0);
      if (!w || Math.abs(w - lastChartWidth) < 12 || !DATA) return;
      lastChartWidth = w;
      drawMeasuredRhythm('#rhythm', periodRows(), { live: !!DATA?.is_live });
    });
    ro.observe(rhythmHost);
  }
})();