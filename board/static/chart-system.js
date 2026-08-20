(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3) {
    console.error('DPP charts require D3 v7.');
    return;
  }

  const COLORS = {
    ink: '#26231f',
    muted: '#746c62',
    line: '#ddd5c9',
    paper: '#f4f0e8',
    sales: '#b78b4d',
    salesLight: '#d8bd95',
    accent: '#e58b1f',
    good: '#2f7d4f',
    bad: '#c94b43',
    cash: '#575047',
    spend: '#6f6252',
    attributed: '#d99a38'
  };

  const money = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0
  });
  const shortMoney = value => {
    const n = Number(value || 0);
    const a = Math.abs(n);
    if (a >= 1e6) return `${n < 0 ? '−' : ''}$${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
    if (a >= 1e3) return `${n < 0 ? '−' : ''}$${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
    return `${n < 0 ? '−' : ''}$${Math.round(a)}`;
  };
  const fullMoney = value => money.format(Number(value || 0)).replace('-MX$', '−$').replace('MX$', '$');
  const parseDate = value => value ? new Date(`${String(value).slice(0, 10)}T12:00:00Z`) : null;
  const monthLabel = value => {
    const d = parseDate(`${String(value).slice(0, 7)}-01`);
    return d3.utcFormat('%b')(d);
  };
  const monthLong = value => {
    const d = parseDate(`${String(value).slice(0, 7)}-01`);
    return d3.utcFormat('%B %Y')(d);
  };

  function shell(selector, height, label, margins = {}, width = 960) {
    const svg = d3.select(selector);
    if (svg.empty()) return null;
    const m = { top: 22, right: 18, bottom: 42, left: 62, ...margins };
    svg.selectAll('*').remove();
    svg.classed('dpp-chart', true)
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid meet')
      .attr('role', 'img')
      .attr('aria-label', label);
    const node = svg.node();
    const host = node.parentElement;
    host.classList.add('dpp-chart-host');
    let tip = host.querySelector('.dpp-chart-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'dpp-chart-tooltip';
      tip.setAttribute('role', 'status');
      host.appendChild(tip);
    }
    return {
      svg,
      width,
      height,
      m,
      innerW: width - m.left - m.right,
      innerH: height - m.top - m.bottom,
      plot: svg.append('g').attr('transform', `translate(${m.left},${m.top})`),
      host,
      tip
    };
  }

  function showTip(ctx, event, title, lines) {
    const rect = ctx.host.getBoundingClientRect();
    const source = event.touches?.[0] || event;
    let x = source.clientX - rect.left;
    let y = source.clientY - rect.top;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const mark = event.currentTarget.getBoundingClientRect();
      x = mark.left + mark.width / 2 - rect.left;
      y = mark.top - rect.top;
    }
    ctx.tip.innerHTML = `<strong>${title}</strong>${lines.map(line => `<span>${line}</span>`).join('')}`;
    ctx.tip.style.left = `${Math.max(70, Math.min(rect.width - 70, x))}px`;
    ctx.tip.style.top = `${Math.max(56, y)}px`;
    ctx.tip.classList.add('show');
  }
  function hideTip(ctx) { ctx.tip.classList.remove('show'); }
  function interactive(selection, ctx, describe) {
    selection
      .attr('tabindex', 0)
      .on('pointerenter pointermove focus', function(event, d) {
        const content = describe(d);
        showTip(ctx, event, content.title, content.lines);
      })
      .on('pointerleave blur', () => hideTip(ctx));
  }

  function grid(ctx, y, ticks, formatter = shortMoney) {
    ctx.plot.append('g')
      .attr('class', 'dpp-grid')
      .call(d3.axisLeft(y).ticks(ticks).tickSize(-ctx.innerW).tickFormat(''));
    ctx.plot.append('g')
      .attr('class', 'dpp-axis')
      .call(d3.axisLeft(y).ticks(ticks).tickSize(0).tickPadding(10).tickFormat(formatter))
      .call(g => g.select('.domain').remove());
  }
  function bottomAxis(ctx, x, formatter, ticks) {
    const axis = d3.axisBottom(x).tickSize(0).tickPadding(12).tickFormat(formatter);
    if (ticks) axis.ticks(ticks);
    ctx.plot.append('g')
      .attr('class', 'dpp-axis')
      .attr('transform', `translate(0,${ctx.innerH})`)
      .call(axis)
      .call(g => g.select('.domain').attr('stroke', '#cfc5b7'));
  }
  function empty(selector, message) {
    const ctx = shell(selector, 220, message, { left: 20, right: 20, bottom: 20 });
    if (!ctx) return;
    ctx.svg.append('text').attr('x', 480).attr('y', 112).attr('text-anchor', 'middle')
      .attr('class', 'dpp-muted').text(message);
  }

  function homeRhythm(selector, rows) {
    const data = (rows || []).map(d => ({ ...d, date: parseDate(d.business_date), value: Number(d.sales || 0) }))
      .filter(d => d.date).sort((a, b) => d3.ascending(a.date, b.date));
    if (data.length < 2) return empty(selector, 'Not enough sales history yet.');
    data.forEach((d, i) => {
      const start = Math.max(0, i - 6);
      d.avg = d3.mean(data.slice(start, i + 1), x => x.value) || 0;
    });
    const compact = window.innerWidth <= 640;
    const ctx = shell(selector, 190, 'Daily sales and seven-day sales signal', { top: 12, right: 12, bottom: 28, left: compact ? 48 : 58 }, compact ? 520 : 960);
    const x = d3.scaleUtc().domain(d3.extent(data, d => d.date)).range([0, ctx.innerW]);
    const y = d3.scaleLinear().domain([0, d3.max(data, d => Math.max(d.value, d.avg)) || 1]).nice(3).range([ctx.innerH, 0]);
    grid(ctx, y, 3);
    const barW = Math.max(2, Math.min(8, ctx.innerW / data.length * .62));
    const bars = ctx.plot.selectAll('.dpp-bar').data(data).join('rect')
      .attr('class', 'dpp-bar')
      .attr('x', d => x(d.date) - barW / 2).attr('width', barW)
      .attr('y', d => y(d.value)).attr('height', d => Math.max(1, ctx.innerH - y(d.value)))
      .attr('rx', 1.5).attr('fill', COLORS.salesLight).attr('opacity', .68);
    const line = d3.line().x(d => x(d.date)).y(d => y(d.avg)).curve(d3.curveMonotoneX);
    ctx.plot.append('path').datum(data).attr('class', 'dpp-line-halo').attr('d', line);
    ctx.plot.append('path').datum(data).attr('class', 'dpp-line').attr('d', line).attr('stroke', COLORS.ink);
    bottomAxis(ctx, x, d3.utcFormat('%b'), d3.utcMonth.every(1));
    interactive(bars, ctx, d => ({ title: d3.utcFormat('%b %-d, %Y')(d.date), lines: [`Sales ${fullMoney(d.value)}`, `7-day signal ${fullMoney(d.avg)}`] }));
  }

  function monthlySales(selector, rows) {
    const data = (rows || []).map(d => ({
      ...d,
      key: String(d.month || '').slice(0, 7),
      value: Number(d.sales || 0),
      projected: Number(d.projected_sales || 0)
    }))
      .filter(d => d.key).sort((a, b) => d3.ascending(a.key, b.key));
    if (!data.length) return empty(selector, 'No monthly sales history yet.');
    const compact = window.innerWidth <= 640;
    const ctx = shell(selector, 340, 'Monthly sales history with current-month run-rate projection', { top: 38, bottom: 44, left: compact ? 52 : 62 }, compact ? 520 : 960);
    const x = d3.scaleBand().domain(data.map(d => d.key)).range([0, ctx.innerW]).padding(.3);
    const y = d3.scaleLinear().domain([0, d3.max(data, d => Math.max(d.value, d.projected)) || 1]).nice(4).range([ctx.innerH, 0]);
    grid(ctx, y, 4);
    const patternId = `dpp-run-rate-${String(selector).replace(/[^a-z0-9]/gi, '')}`;
    const pattern = ctx.svg.append('defs').append('pattern')
      .attr('id', patternId).attr('width', 7).attr('height', 7)
      .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(45)');
    pattern.append('rect').attr('width', 7).attr('height', 7).attr('fill', '#f3dfc4').attr('opacity', .62);
    pattern.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 7).attr('stroke', COLORS.accent).attr('stroke-width', 2).attr('opacity', .6);
    const bars = ctx.plot.selectAll('.dpp-bar').data(data).join('rect')
      .attr('class', 'dpp-bar')
      .attr('x', d => x(d.key)).attr('width', x.bandwidth())
      .attr('y', d => y(d.value)).attr('height', d => Math.max(1, ctx.innerH - y(d.value)))
      .attr('rx', 4).attr('fill', d => d.partial ? COLORS.accent : COLORS.sales);
    const projected = data.filter(d => d.partial && d.projected > d.value);
    const ghosts = ctx.plot.selectAll('.dpp-ghost-bar').data(projected).join('rect')
      .attr('class', 'dpp-bar dpp-ghost-bar')
      .attr('x', d => x(d.key)).attr('width', x.bandwidth())
      .attr('y', d => y(d.projected)).attr('height', d => Math.max(1, y(d.value) - y(d.projected)))
      .attr('rx', 4).attr('fill', `url(#${patternId})`).attr('stroke', COLORS.accent).attr('stroke-width', 1.25);
    if (data.length <= 12) {
      ctx.plot.selectAll('.dpp-value').data(data).join('text').attr('class', 'dpp-value')
        .attr('x', d => x(d.key) + x.bandwidth() / 2).attr('y', d => y(d.value) - 8)
        .attr('text-anchor', 'middle').text(d => d.partial && d.projected > d.value ? `Actual ${shortMoney(d.value)}` : shortMoney(d.value));
      ctx.plot.selectAll('.dpp-projection-value').data(projected).join('text').attr('class', 'dpp-value dpp-projection-value')
        .attr('x', d => x(d.key) + x.bandwidth() / 2).attr('y', d => y(d.projected) - 9)
        .attr('text-anchor', 'middle').text(d => `Run rate ${shortMoney(d.projected)}`);
    }
    bottomAxis(ctx, x, monthLabel);
    if (projected.length) {
      const legend = ctx.plot.append('g').attr('class', 'dpp-legend').attr('transform', 'translate(0,-25)');
      const actual = legend.append('g');
      actual.append('rect').attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', COLORS.accent);
      actual.append('text').attr('x', 16).attr('y', 9).text('Current actual');
      const runRate = legend.append('g').attr('transform', 'translate(112,0)');
      runRate.append('rect').attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', `url(#${patternId})`).attr('stroke', COLORS.accent);
      runRate.append('text').attr('x', 16).attr('y', 9).text('Momentum run rate');
    }
    interactive(bars, ctx, d => ({
      title: monthLong(d.key),
      lines: [`Actual sales ${fullMoney(d.value)}`, d.partial ? 'Current month, still partial' : 'Reconciled month']
    }));
    interactive(ghosts, ctx, d => ({
      title: `${monthLong(d.key)} run rate`,
      lines: [`Projected total ${fullMoney(d.projected)}`, `Remaining momentum ${fullMoney(d.projected - d.value)}`, 'Directional, not a forecast']
    }));
  }

  function ads(selector, rows) {
    const data = (rows || []).slice(-28).map(d => ({
      ...d, key: String(d.business_date || '').slice(0, 10),
      spend: Number(d.spend || 0), attributed: Number(d.attributed_sales || 0)
    })).filter(d => d.key).sort((a, b) => d3.ascending(a.key, b.key));
    if (!data.length) return empty(selector, 'No advertising history yet.');
    const compact = window.innerWidth <= 640;
    const ctx = shell(selector, 320, 'Daily advertising spend and attributed sales', { top: 34, bottom: 44, left: compact ? 52 : 62 }, compact ? 520 : 960);
    const x = d3.scaleBand().domain(data.map(d => d.key)).range([0, ctx.innerW]).padding(.22);
    const subgroup = d3.scaleBand().domain(['spend', 'attributed']).range([0, x.bandwidth()]).padding(.12);
    const y = d3.scaleLinear().domain([0, d3.max(data, d => Math.max(d.spend, d.attributed)) || 1]).nice(4).range([ctx.innerH, 0]);
    grid(ctx, y, 4);
    const groups = ctx.plot.selectAll('.dpp-day').data(data).join('g').attr('transform', d => `translate(${x(d.key)},0)`);
    const series = [
      { key: 'spend', label: 'Spend', color: COLORS.spend },
      { key: 'attributed', label: 'Attributed sales', color: COLORS.attributed }
    ];
    const bars = groups.selectAll('.dpp-bar').data(d => series.map(s => ({ ...s, day: d, value: d[s.key] }))).join('rect')
      .attr('class', 'dpp-bar').attr('x', d => subgroup(d.key)).attr('width', subgroup.bandwidth())
      .attr('y', d => y(d.value)).attr('height', d => Math.max(1, ctx.innerH - y(d.value)))
      .attr('rx', 2).attr('fill', d => d.color);
    bottomAxis(ctx, x, (d, i) => {
      const step = Math.max(1, Math.floor(data.length / 4));
      return i % step === 0 || i === data.length - 1 ? d.slice(5) : '';
    });
    const legend = ctx.plot.append('g').attr('class', 'dpp-legend').attr('transform', 'translate(0,-20)');
    series.forEach((s, i) => {
      const item = legend.append('g').attr('transform', `translate(${i * 130},0)`);
      item.append('rect').attr('width', 9).attr('height', 9).attr('rx', 2).attr('fill', s.color);
      item.append('text').attr('x', 15).attr('y', 8).text(s.label);
    });
    interactive(bars, ctx, d => ({ title: d.day.key, lines: [`${d.label} ${fullMoney(d.value)}`] }));
  }

  function adsEfficiency(selector, rows) {
    const data = (rows || []).map(d => ({
      ...d,
      name: d.campaign_name || d.campaign_id || 'Campaign',
      spend: Number(d.spend || 0),
      attributed: Number(d.attributed_sales || 0),
      clicks: Number(d.clicks || 0)
    })).filter(d => d.spend > 0 && d.attributed >= 0);
    data.forEach(d => { d.roas = d.attributed / d.spend; });
    if (data.length < 2) return empty(selector, 'More campaign data is needed for an efficiency map.');
    const compact = window.innerWidth <= 640;
    const ctx = shell(selector, 350, 'Campaign spend and return efficiency quadrant', { top: 35, right: 28, bottom: 52, left: compact ? 54 : 66 }, compact ? 520 : 960);
    const x = d3.scaleLinear().domain([0, d3.max(data, d => d.spend) || 1]).nice(4).range([0, ctx.innerW]);
    const y = d3.scaleLinear().domain([0, d3.max(data, d => d.roas) || 1]).nice(4).range([ctx.innerH, 0]);
    const r = d3.scaleSqrt().domain([0, d3.max(data, d => d.clicks) || 1]).range([5, 17]);
    const medianSpend = d3.median(data, d => d.spend) || 0;
    const medianRoas = d3.median(data, d => d.roas) || 0;
    grid(ctx, y, 4, v => `${Number(v).toFixed(1)}×`);
    bottomAxis(ctx, x, shortMoney, 4);
    ctx.plot.append('line').attr('class', 'dpp-quadrant-line').attr('x1', x(medianSpend)).attr('x2', x(medianSpend)).attr('y1', 0).attr('y2', ctx.innerH);
    ctx.plot.append('line').attr('class', 'dpp-quadrant-line').attr('x1', 0).attr('x2', ctx.innerW).attr('y1', y(medianRoas)).attr('y2', y(medianRoas));
    const labels = [
      { x: 8, y: 14, text: 'Efficient support' },
      { x: ctx.innerW - 8, y: 14, text: 'Scale winners', anchor: 'end' },
      { x: 8, y: ctx.innerH - 10, text: 'Low-risk tests' },
      { x: ctx.innerW - 8, y: ctx.innerH - 10, text: 'Review spend', anchor: 'end' }
    ];
    ctx.plot.selectAll('.dpp-quadrant-label').data(labels).join('text').attr('class', 'dpp-muted dpp-quadrant-label')
      .attr('x', d => d.x).attr('y', d => d.y).attr('text-anchor', d => d.anchor || 'start').text(d => d.text);
    const dots = ctx.plot.selectAll('.dpp-bubble').data(data).join('circle').attr('class', 'dpp-bar dpp-bubble')
      .attr('cx', d => x(d.spend)).attr('cy', d => y(d.roas)).attr('r', d => r(d.clicks))
      .attr('fill', d => d.roas >= medianRoas ? COLORS.good : COLORS.accent).attr('fill-opacity', .78)
      .attr('stroke', '#fffdf9').attr('stroke-width', 2);
    ctx.plot.append('text').attr('class', 'dpp-muted').attr('x', ctx.innerW).attr('y', ctx.innerH + 42).attr('text-anchor', 'end').text('Spend →');
    ctx.plot.append('text').attr('class', 'dpp-muted').attr('transform', 'rotate(-90)').attr('x', -4).attr('y', -48).attr('text-anchor', 'end').text('ROAS →');
    interactive(dots, ctx, d => ({ title: d.name, lines: [`Spend ${fullMoney(d.spend)}`, `Attributed sales ${fullMoney(d.attributed)}`, `ROAS ${d.roas.toFixed(2)}×`, `${d.clicks} clicks`] }));
  }

  function trajectory(selector, rows) {
    const data = (rows || []).map(d => ({
      ...d, date: parseDate(d.business_date), value: Number(d.sales || 0), avg: Number(d.avg28 || 0)
    })).filter(d => d.date).sort((a, b) => d3.ascending(a.date, b.date));
    if (data.length < 2) return empty(selector, 'Not enough trajectory history yet.');
    const compact = window.innerWidth <= 640;
    const ctx = shell(selector, 340, 'Daily sales and 28-day moving average', { top: 20, bottom: 44, left: compact ? 52 : 62 }, compact ? 520 : 960);
    const x = d3.scaleUtc().domain(d3.extent(data, d => d.date)).range([0, ctx.innerW]);
    const y = d3.scaleLinear().domain([0, d3.max(data, d => Math.max(d.value, d.avg)) || 1]).nice(4).range([ctx.innerH, 0]);
    grid(ctx, y, 4);
    const barW = Math.max(1.5, Math.min(5, ctx.innerW / data.length * .62));
    const bars = ctx.plot.selectAll('.dpp-bar').data(data).join('rect').attr('class', 'dpp-bar')
      .attr('x', d => x(d.date) - barW / 2).attr('width', barW)
      .attr('y', d => y(d.value)).attr('height', d => Math.max(1, ctx.innerH - y(d.value)))
      .attr('fill', COLORS.salesLight).attr('opacity', .64);
    const line = d3.line().defined(d => Number.isFinite(d.avg)).x(d => x(d.date)).y(d => y(d.avg)).curve(d3.curveMonotoneX);
    ctx.plot.append('path').datum(data).attr('class', 'dpp-line-halo').attr('d', line);
    ctx.plot.append('path').datum(data).attr('class', 'dpp-line').attr('d', line);
    bottomAxis(ctx, x, d3.utcFormat('%b'));
    interactive(bars, ctx, d => ({ title: d3.utcFormat('%b %-d, %Y')(d.date), lines: [`Sales ${fullMoney(d.value)}`, `28-day average ${fullMoney(d.avg)}`] }));
  }

  function financeWaterfall(selector, rows) {
    const aggregate = !Array.isArray(rows) && rows ? rows : null;
    const sorted = Array.isArray(rows) ? rows.slice().filter(d => d.month).sort((a, b) => d3.ascending(String(a.month), String(b.month))) : [];
    if (!aggregate && !sorted.length) return empty(selector, 'No closed finance history yet.');
    const latest = aggregate || sorted[sorted.length - 1];
    const sales = Number(latest.net_sales_ex_vat || 0);
    const deductions = Number(latest.amazon_order_effect || 0);
    const advertising = Number(latest.advertising || 0);
    const productCost = -Math.abs(Number(latest.product_cogs || 0));
    const contribution = Number(latest.contribution_after_product_cogs || 0);
    let running = sales;
    const data = [
      { key: 'Sales', detail: 'Sales before IVA', start: 0, end: sales, value: sales, kind: 'sales' },
      { key: 'Amazon', detail: 'Fees, withholding and refunds', start: running, end: running += deductions, value: deductions, kind: 'change' },
      { key: 'Advertising', detail: 'Monthly advertising charge', start: running, end: running += advertising, value: advertising, kind: 'change' },
      { key: 'Product cost', detail: 'Seller-owned product COGS', start: running, end: running += productCost, value: productCost, kind: 'change' },
      { key: 'Contribution', detail: 'Before off-Amazon overhead', start: 0, end: contribution, value: contribution, kind: 'total' }
    ];
    const compact = window.innerWidth <= 640;
    const periodLabel = aggregate
      ? `${latest.year} YTD through ${monthLong(latest.through_month)}`
      : monthLong(latest.month);
    const ctx = shell(selector, compact ? 390 : 350, `${periodLabel} contribution waterfall`, { top: 34, bottom: 58, left: compact ? 54 : 68, right: 24 }, compact ? 520 : 960);
    const x = d3.scaleBand().domain(data.map(d => d.key)).range([0, ctx.innerW]).padding(.34);
    const extents = data.flatMap(d => [d.start, d.end]);
    const lo = Math.min(0, d3.min(extents)), hi = Math.max(0, d3.max(extents));
    const pad = Math.max(1, (hi - lo) * .12);
    const y = d3.scaleLinear().domain([lo - pad, hi + pad]).nice(5).range([ctx.innerH, 0]);
    grid(ctx, y, 5);
    ctx.plot.append('line').attr('class', 'dpp-zero').attr('x1', 0).attr('x2', ctx.innerW).attr('y1', y(0)).attr('y2', y(0));
    for (let i = 0; i < data.length - 2; i++) {
      ctx.plot.append('line').attr('class', 'dpp-connector')
        .attr('x1', x(data[i].key) + x.bandwidth()).attr('x2', x(data[i + 1].key))
        .attr('y1', y(data[i].end)).attr('y2', y(data[i].end));
    }
    const bars = ctx.plot.selectAll('.dpp-bar').data(data).join('rect').attr('class', 'dpp-bar')
      .attr('x', d => x(d.key)).attr('width', x.bandwidth())
      .attr('y', d => y(Math.max(d.start, d.end)))
      .attr('height', d => Math.max(2, Math.abs(y(d.start) - y(d.end))))
      .attr('rx', 4)
      .attr('fill', d => d.kind === 'sales' ? COLORS.sales : d.kind === 'total' ? (d.value >= 0 ? COLORS.good : COLORS.bad) : (d.value >= 0 ? COLORS.good : COLORS.bad));
    ctx.plot.selectAll('.dpp-value').data(data).join('text').attr('class', 'dpp-value')
      .attr('x', d => x(d.key) + x.bandwidth() / 2)
      .attr('y', d => d.value >= 0 ? y(Math.max(d.start, d.end)) - 9 : y(Math.min(d.start, d.end)) + 17)
      .attr('text-anchor', 'middle').text(d => shortMoney(d.value));
    bottomAxis(ctx, x, d => compact && d === 'Product cost' ? 'Product' : d);
    ctx.plot.append('text').attr('class', 'dpp-muted').attr('x', 0).attr('y', -18)
      .text(`${periodLabel} · sales to contribution`);
    interactive(bars, ctx, d => ({ title: d.key, lines: [d.detail, fullMoney(d.value)] }));
  }

  function dailyRhythm(selector, rows, options = {}) {
    const data = (rows || []).map(d => ({
      ...d, date: parseDate(d.business_date), value: Number(d.sales || 0), orders: Number(d.orders || 0)
    })).filter(d => d.date).sort((a, b) => d3.ascending(a.date, b.date));
    if (!data.length) return empty(selector, 'No sales rhythm for this period.');
    const compact = window.innerWidth <= 640;
    const ctx = shell(selector, 220, 'Daily sales rhythm', { top: 12, right: 12, bottom: 32, left: compact ? 54 : 64 }, compact ? 520 : 960);
    const x = d3.scaleBand().domain(data.map(d => d.business_date)).range([0, ctx.innerW]).padding(.34);
    const y = d3.scaleLinear().domain([0, d3.max(data, d => d.value) || 1]).nice(3).range([ctx.innerH, 0]);
    grid(ctx, y, 3);
    const wall = document.documentElement.classList.contains('wall-mode');
    const bars = ctx.plot.selectAll('.dpp-bar').data(data).join('rect').attr('class', 'dpp-bar')
      .attr('x', d => x(d.business_date)).attr('width', x.bandwidth())
      .attr('y', d => y(d.value)).attr('height', d => Math.max(2, ctx.innerH - y(d.value)))
      .attr('rx', 3).attr('fill', d => d.live ? (wall ? '#ffb342' : COLORS.accent) : d.selected ? '#b2762f' : (wall ? '#7d5730' : COLORS.salesLight));
    bottomAxis(ctx, x, (d, i) => {
      if (i === 0 || i === data.length - 1 || i === Math.floor((data.length - 1) / 2)) {
        const row = data[i];
        return row.live ? 'Today' : row.selected && !options.live ? 'Selected' : String(d).slice(5);
      }
      return '';
    });
    interactive(bars, ctx, d => ({ title: d3.utcFormat('%b %-d, %Y')(d.date), lines: [`Sales ${fullMoney(d.value)}`, `${d.orders} order${d.orders === 1 ? '' : 's'}`] }));
  }

  function productDemand(selector, rows) {
    const data = (rows || []).map(d => ({
      ...d, date: parseDate(d.business_date), value: Number(d.sales || 0), units: Number(d.units || 0)
    })).filter(d => d.date).sort((a, b) => d3.ascending(a.date, b.date));
    if (!data.length) return empty(selector, 'No demand history for this product.');
    data.forEach((d, i) => { d.avg = d3.mean(data.slice(Math.max(0, i - 6), i + 1), x => x.value) || 0; });
    const compact = window.innerWidth <= 640;
    const ctx = shell(selector, 300, 'Product daily sales and seven-day trend', { top: 18, right: 14, bottom: 38, left: compact ? 54 : 62 }, compact ? 520 : 960);
    const x = d3.scaleUtc().domain(d3.extent(data, d => d.date)).range([0, ctx.innerW]);
    const y = d3.scaleLinear().domain([0, d3.max(data, d => Math.max(d.value, d.avg)) || 1]).nice(4).range([ctx.innerH, 0]);
    grid(ctx, y, 4);
    const barW = Math.max(2.5, Math.min(18, ctx.innerW / data.length * .58));
    const bars = ctx.plot.selectAll('.dpp-bar').data(data).join('rect').attr('class', 'dpp-bar')
      .attr('x', d => x(d.date) - barW / 2).attr('width', barW)
      .attr('y', d => y(d.value)).attr('height', d => Math.max(1, ctx.innerH - y(d.value)))
      .attr('rx', 3).attr('fill', (d, i) => i === data.length - 1 ? COLORS.accent : COLORS.salesLight).attr('opacity', (d, i) => i === data.length - 1 ? 1 : .78);
    const line = d3.line().x(d => x(d.date)).y(d => y(d.avg)).curve(d3.curveMonotoneX);
    ctx.plot.append('path').datum(data).attr('class', 'dpp-line-halo').attr('d', line);
    ctx.plot.append('path').datum(data).attr('class', 'dpp-line').attr('d', line);
    bottomAxis(ctx, x, d3.utcFormat('%b %-d'), data.length > 45 ? 5 : 4);
    const legend = ctx.plot.append('g').attr('class', 'dpp-legend').attr('transform', 'translate(0,-8)');
    legend.append('line').attr('x1', 0).attr('x2', 20).attr('y1', -4).attr('y2', -4).attr('stroke', COLORS.ink).attr('stroke-width', 3);
    legend.append('text').attr('x', 27).attr('y', 0).text('7-day demand signal');
    interactive(bars, ctx, d => ({ title: d3.utcFormat('%b %-d, %Y')(d.date), lines: [`Sales ${fullMoney(d.value)}`, `${d.units} unit${d.units === 1 ? '' : 's'}`, `7-day signal ${fullMoney(d.avg)}`] }));
  }

  window.DPPCharts = { homeRhythm, monthlySales, ads, adsEfficiency, trajectory, financeWaterfall, dailyRhythm, productDemand };
})();
