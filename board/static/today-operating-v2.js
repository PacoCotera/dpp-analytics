/* Today operating layout v2
   Reframes normal Today as live state -> rhythm -> evidence.
   One composition owner: no duplicate data fetches, no chart mutation loops. */
(() => {
  'use strict';
  if (!document.body.classList.contains('today-shell')) return;
  if (document.documentElement.classList.contains('wall-mode')) return;
  if (document.body.classList.contains('today-operating-v3')) return;
  document.body.classList.add('today-operating-v2', 'today-operating-v3');

  const d3 = window.d3;
  if (!d3) return;

  const app = document.querySelector('.today-shell > .app');
  const hero = document.querySelector('.hero');
  const heroMain = hero?.querySelector('.hero-main');
  const latest = hero?.querySelector('.latest');
  const context = document.querySelector('.context-strip');
  const picker = document.getElementById('dayPicker');
  const eyebrow = document.getElementById('salesEyebrow');
  if (!app || !hero || !heroMain || !latest || !context || !picker || !eyebrow) return;

  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = v => '$' + nf.format(Math.round(Number(v || 0)));
  const shortMoney = v => {
    const n = Number(v || 0), a = Math.abs(n);
    if (a >= 1000000) return `${n < 0 ? '−' : ''}$${(a / 1000000).toFixed(a >= 10000000 ? 0 : 1)}m`;
    if (a >= 1000) return `${n < 0 ? '−' : ''}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
    return `${n < 0 ? '−' : ''}$${Math.round(a)}`;
  };
  const parseDate = s => s ? new Date(`${String(s).slice(0, 10)}T12:00:00Z`) : null;
  const weekdayLetter = d => ['S', 'M', 'T', 'W', 'T', 'F', 'S'][d.getUTCDay()];

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
  [...context.children].forEach(node => {
    node.classList.add('today-state-row');
    rail.appendChild(node);
  });

  const heroHead = document.createElement('div');
  heroHead.className = 'today-hero-head';
  heroMain.insertBefore(heroHead, heroMain.firstChild);
  heroHead.append(eyebrow, picker);

  const pulseTitle = document.createElement('div');
  pulseTitle.className = 'today-pulse-title';
  pulseTitle.textContent = 'Business pulse';
  rail.prepend(pulseTitle);
  const kpiGrid = document.createElement('div');
  kpiGrid.className = 'today-kpi-grid';
  pulseTitle.after(kpiGrid);
  [...rail.querySelectorAll('.today-state-row')].forEach(row => kpiGrid.appendChild(row));

  const latestLabel = document.getElementById('latestLabel');
  if (latestLabel) latestLabel.textContent = 'Latest sale';
  const productsSub = document.getElementById('productsSub');
  if (productsSub) productsSub.textContent = 'Product mix for the selected day';
  const rhythmTitle = document.querySelector('.content-grid > .panel:first-child .panel-title');
  if (rhythmTitle) rhythmTitle.textContent = 'Recent rhythm';
  const labels = { weekLabel: 'WTD', mtdLabel: 'MTD', last30Label: '30D' };
  Object.entries(labels).forEach(([id, text]) => {
    const el = document.getElementById(id); if (el) el.dataset.compactLabel = text;
  });

  /* Orders are supporting evidence. Preserve the original header nodes because the base
     Today renderer updates #winsSub on every refresh; hide them rather than deleting them. */
  const wins = document.querySelector('.wins');
  if (wins) {
    wins.classList.add('today-orders-compact');
    const stream = wins.querySelector('#stream');
    const sourceHead = wins.querySelector('.panel-head');
    if (sourceHead) sourceHead.style.display = 'none';
    const details = document.createElement('details');
    details.className = 'today-orders-details';
    const summary = document.createElement('summary');
    summary.innerHTML = '<span><strong>Order ledger</strong><small>Transaction detail for the selected day</small></span><b>Show ↓</b>';
    if (stream) details.append(summary, stream);
    wins.appendChild(details);
    details.addEventListener('toggle', () => {
      const b = summary.querySelector('b');
      if (b) b.textContent = details.open ? 'Hide ↑' : 'Show ↓';
    });
  }

  function canonicalizePicker() {
    const buttons = [...picker.querySelectorAll('.day-choice')];
    buttons.forEach((btn, i) => {
      const d = parseDate(btn.dataset.date);
      if (!d) return;
      const b = btn.querySelector('b'), span = btn.querySelector('span');
      if (b) b.textContent = btn.classList.contains('live') ? 'Today' : weekdayLetter(d);
      if (span) span.textContent = btn.classList.contains('live') ? '' : String(d.getUTCDate());
      btn.dataset.canonical = '1';
      btn.dataset.slot = String(i);
      const long = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(d);
      btn.title = `${long}${btn.classList.contains('live') ? ' · live' : ''}`;
      btn.setAttribute('aria-label', btn.title);
    });
    const active = picker.querySelector('.day-choice.active');
    document.body.dataset.dayMode = active?.classList.contains('live') ? 'live' : 'closed';
  }

  canonicalizePicker();
  const pickerObserver = new MutationObserver(() => canonicalizePicker());
  pickerObserver.observe(picker, { childList: true });

  function ensureRhythmRail(host) {
    const panel = host.closest('.panel');
    if (!panel) return null;
    let out = panel.querySelector('.today-rhythm-kpi-rail');
    if (!out) {
      out = document.createElement('div');
      out.className = 'today-rhythm-kpi-rail';
      panel.appendChild(out);
    }
    return out;
  }

  function renderRhythmRail(host, rows) {
    const out = ensureRhythmRail(host);
    if (!out) return;
    const sales = d3.sum(rows, r => Number(r.sales || 0));
    const orders = d3.sum(rows, r => Number(r.orders || 0));
    const units = d3.sum(rows, r => Number(r.units || 0));
    const pace = sales / Math.max(1, rows.length);
    out.innerHTML = `
      <div class="today-rhythm-kpi"><div class="label">Sales</div><strong>${money(sales)}</strong><small>selected window</small></div>
      <div class="today-rhythm-kpi"><div class="label">Orders · units</div><strong>${orders} · ${units}</strong><small>volume</small></div>
      <div class="today-rhythm-kpi"><div class="label">Daily pace</div><strong>${money(pace)}</strong><small>average / day</small></div>
      <div class="today-rhythm-kpi"><div class="label">Range</div><strong>${rows.length}D</strong><small>${rows.length ? d3.utcFormat('%b %-d')(parseDate(rows[0].business_date)) : '—'} → ${rows.length ? d3.utcFormat('%b %-d')(parseDate(rows.at(-1).business_date)) : '—'}</small></div>`;
  }

  function drawMeasuredRhythm(selector, inputRows, opts = {}) {
    const svg = d3.select(selector);
    if (svg.empty()) return;
    const node = svg.node();
    const host = node.parentElement;
    const rows = (inputRows || []).map(r => ({
      ...r,
      date: parseDate(r.business_date),
      sales: Number(r.sales || 0),
      orders: Number(r.orders || 0),
      units: Number(r.units || 0)
    })).filter(r => r.date);
    if (!rows.length) { svg.selectAll('*').remove(); return; }

    const width = Math.max(300, Math.round(host.getBoundingClientRect().width));
    const compact = width < 560;
    const height = compact ? 190 : width < 900 ? 184 : 178;
    const m = { top: 12, right: 8, bottom: 30, left: compact ? 44 : 50 };
    const iw = width - m.left - m.right, ih = height - m.top - m.bottom;
    svg.selectAll('*').remove();
    svg.attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'xMidYMid meet').classed('dpp-chart', true);

    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);
    const x = d3.scaleBand().domain(rows.map(r => r.business_date)).range([0, iw]).padding(rows.length <= 8 ? .18 : .24);
    const y = d3.scaleLinear().domain([0, d3.max(rows, r => r.sales) || 1]).nice(4).range([ih, 0]);
    g.append('g').attr('class', 'dpp-grid').call(d3.axisLeft(y).ticks(4).tickSize(-iw).tickFormat(''));
    g.append('g').attr('class', 'dpp-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(7).tickFormat(shortMoney)).call(a => a.select('.domain').remove());

    const selected = rows.at(-1)?.business_date;
    const bars = g.selectAll('rect.today-rhythm-bar').data(rows).join('rect')
      .attr('class', 'dpp-bar today-rhythm-bar')
      .attr('x', r => x(r.business_date)).attr('width', x.bandwidth())
      .attr('y', r => y(r.sales)).attr('height', r => Math.max(1, ih - y(r.sales)))
      .attr('rx', Math.min(4, x.bandwidth() / 4))
      .attr('fill', r => {
        const dow = r.date.getUTCDay();
        if (opts.live && r.business_date === selected) return '#e58b1f';
        return dow === 0 || dow === 6 ? '#d8c09b' : '#b78b4d';
      });

    const dividers = g.append('g').attr('pointer-events', 'none');
    rows.forEach((r, i) => {
      if (!i) return;
      const prev = rows[i - 1];
      const xx = x(r.business_date) - (x.step() - x.bandwidth()) / 2;
      if (r.date.getUTCMonth() !== prev.date.getUTCMonth()) {
        dividers.append('line').attr('x1', xx).attr('x2', xx).attr('y1', 0).attr('y2', ih).attr('stroke', '#e58b1f').attr('stroke-width', 1.4).attr('opacity', .82);
      } else if (r.date.getUTCDay() === 1) {
        dividers.append('line').attr('x1', xx).attr('x2', xx).attr('y1', 0).attr('y2', ih).attr('stroke', '#c9c0b4').attr('stroke-width', .8).attr('opacity', .48);
      }
    });

    const targetTicks = rows.length <= 8 ? rows.length : width < 520 ? 4 : width < 850 ? 5 : 7;
    const step = Math.max(1, Math.ceil(rows.length / targetTicks));
    const ticks = rows.filter((r, i) => rows.length <= 8 || i === 0 || i === rows.length - 1 || i % step === 0).map(r => r.business_date);
    g.append('g').attr('class', 'dpp-axis').attr('transform', `translate(0,${ih})`)
      .call(d3.axisBottom(x).tickValues(ticks).tickSize(0).tickPadding(8).tickFormat(k => d3.utcFormat(rows.length <= 8 ? '%a' : '%-d')(parseDate(k))))
      .call(a => a.select('.domain').attr('stroke', '#cfc5b7'));

    let tip = host.querySelector('.today-rhythm-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'dpp-chart-tooltip today-rhythm-tip'; host.appendChild(tip); }
    bars.attr('tabindex', 0).on('pointerenter pointermove focus', function(_ev, r) {
      if (host.getBoundingClientRect().width < 640) return;
      const hr = host.getBoundingClientRect(), br = this.getBoundingClientRect();
      tip.innerHTML = `<strong>${d3.utcFormat('%a, %b %-d')(r.date)}</strong><span>Sales ${money(r.sales)}</span><span>${r.orders} orders · ${r.units} units</span>`;
      tip.style.left = `${Math.min(hr.width - 90, Math.max(90, br.left - hr.left + br.width / 2))}px`;
      tip.style.top = `${Math.max(54, br.top - hr.top + 8)}px`;
      tip.classList.add('show');
    }).on('pointerleave blur', () => tip.classList.remove('show'));
    renderRhythmRail(host, rows);
  }

  window.DPPCharts = window.DPPCharts || {};
  window.DPPCharts.dailyRhythm = drawMeasuredRhythm;

  let lastChartWidth = 0;
  const rhythm = document.getElementById('rhythm');
  const rhythmHost = rhythm?.parentElement;
  if (rhythmHost && window.ResizeObserver) {
    const ro = new ResizeObserver(entries => {
      const w = Math.round(entries[0]?.contentRect?.width || 0);
      if (!w || Math.abs(w - lastChartWidth) < 8) return;
      lastChartWidth = w;
      const active = document.querySelector('.period.active');
      if (active && rhythm.querySelector('.dpp-bar')) active.click();
    });
    ro.observe(rhythmHost);
  }

  const productsTitle = document.getElementById('productsTitle');
  if (productsTitle) productsTitle.textContent = 'Products sold';
})();