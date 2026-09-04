(() => {
  'use strict';
  const d3 = window.d3;
  if (!d3) {
    console.error('DPP charts require D3 v7.');
    return;
  }

  // SVG presentation attributes retain CSS variable references, so a profile
  // change repaints existing charts without changing data or chart behavior.
  const COLORS = Object.freeze({
    ink: 'var(--dpp-text)',
    muted: 'var(--dpp-text-muted)',
    line: 'var(--dpp-data-grid)',
    paper: 'var(--dpp-page)',
    surface: 'var(--dpp-surface)',
    sales: 'var(--dpp-data1)',
    salesLight: 'var(--dpp-data1)',
    accent: 'var(--dpp-data2)',
    cash: 'var(--dpp-data3)',
    spend: 'var(--dpp-data4)',
    attributed: 'var(--dpp-data5)',
    selected: 'var(--dpp-data6)',
    incomplete: 'var(--dpp-data-incomplete)',
    good: 'var(--dpp-healthy)',
    warning: 'var(--dpp-warning)',
    bad: 'var(--dpp-critical)',
  });

  const MONEY_PREFIX = '$\u00a0';
  const money = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const shortMoney = (value) => {
    const n = Number(value || 0);
    const a = Math.abs(n);
    if (a >= 1e6) return `${n < 0 ? '−' : ''}${MONEY_PREFIX}${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}m`;
    if (a >= 1e3) return `${n < 0 ? '−' : ''}${MONEY_PREFIX}${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`;
    return `${n < 0 ? '−' : ''}${MONEY_PREFIX}${Math.round(a)}`;
  };
  const fullMoney = (value) => {
    const numeric = Number(value || 0);
    return `${numeric < 0 ? '−' : ''}${MONEY_PREFIX}${money.format(Math.abs(numeric))}`;
  };
  const parseDate = (value) => (value ? new Date(`${String(value).slice(0, 10)}T12:00:00Z`) : null);
  const monthLabel = (value) => {
    const d = parseDate(`${String(value).slice(0, 7)}-01`);
    return d3.utcFormat('%b')(d);
  };
  const monthLong = (value) => {
    const d = parseDate(`${String(value).slice(0, 7)}-01`);
    return d3.utcFormat('%B %Y')(d);
  };

  function shell(selector, height, label, margins = {}, width = 960) {
    const svg = d3.select(selector);
    if (svg.empty()) return null;
    const m = { top: 22, right: 18, bottom: 42, left: 62, ...margins };
    svg.selectAll('*').remove();
    svg
      .classed('dpp-chart', true)
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
      tip,
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
    ctx.tip.innerHTML = `<strong>${title}</strong>${lines.map((line) => `<span>${line}</span>`).join('')}`;
    ctx.tip.dataset.placement = 'above';
    const tipWidth = ctx.tip.offsetWidth;
    const tipHeight = ctx.tip.offsetHeight;
    const inset = 8;
    const gap = 10;
    const halfWidth = tipWidth / 2;
    const minimumX = Math.min(rect.width / 2, inset + halfWidth);
    const maximumX = Math.max(rect.width / 2, rect.width - inset - halfWidth);
    const roomAbove = y - inset;
    const roomBelow = rect.height - y - inset;
    const placeBelow = roomAbove < tipHeight + gap && roomBelow >= roomAbove;
    const placement = placeBelow ? 'below' : 'above';
    const maximumTop = Math.max(inset, rect.height - inset - tipHeight);
    const tooltipTop = placeBelow
      ? Math.min(maximumTop, Math.max(inset, y + gap))
      : Math.min(rect.height - inset, Math.max(inset + tipHeight, y - gap));
    ctx.tip.dataset.placement = placement;
    ctx.tip.style.left = `${Math.max(minimumX, Math.min(maximumX, x))}px`;
    ctx.tip.style.top = `${tooltipTop}px`;
    ctx.tip.classList.add('show');
  }
  function hideTip(ctx) {
    ctx.tip.classList.remove('show');
  }
  function interactive(selection, ctx, describe) {
    selection
      .attr('tabindex', 0)
      .attr('role', 'img')
      .attr('aria-label', (d) => {
        const content = describe(d);
        return [content.title, ...(content.lines || [])].filter(Boolean).join('. ');
      })
      .on('pointerenter pointermove focus', function (event, d) {
        const content = describe(d);
        showTip(ctx, event, content.title, content.lines);
      })
      .on('pointerleave blur', () => hideTip(ctx));
  }

  function grid(ctx, y, ticks, formatter = shortMoney) {
    ctx.plot
      .append('g')
      .attr('class', 'dpp-grid')
      .call(d3.axisLeft(y).ticks(ticks).tickSize(-ctx.innerW).tickFormat(''));
    ctx.plot
      .append('g')
      .attr('class', 'dpp-axis')
      .call(d3.axisLeft(y).ticks(ticks).tickSize(0).tickPadding(10).tickFormat(formatter))
      .call((g) => g.select('.domain').remove());
  }
  function bottomAxis(ctx, x, formatter, ticks, tickValues) {
    const axis = d3.axisBottom(x).tickSize(0).tickPadding(12).tickFormat(formatter);
    if (ticks) axis.ticks(ticks);
    if (tickValues) axis.tickValues(tickValues);
    ctx.plot
      .append('g')
      .attr('class', 'dpp-axis')
      .attr('transform', `translate(0,${ctx.innerH})`)
      .call(axis)
      .call((g) => g.select('.domain').attr('stroke', COLORS.line));
  }
  function empty(selector, message) {
    const ctx = shell(selector, 220, message, { left: 20, right: 20, bottom: 20 });
    if (!ctx) return;
    ctx.svg
      .append('text')
      .attr('x', 480)
      .attr('y', 112)
      .attr('text-anchor', 'middle')
      .attr('class', 'dpp-muted')
      .text(message);
  }

  function wrapChartLabels(selection, value, maxCharacters = 30) {
    selection.each(function (datum) {
      const words = String(value(datum) || '')
        .split(/\s+/)
        .filter(Boolean);
      const lines = [''];
      for (const word of words) {
        const current = lines.at(-1);
        const candidate = current ? `${current} ${word}` : word;
        if (candidate.length <= maxCharacters || !current) lines[lines.length - 1] = candidate;
        else if (lines.length === 1) lines.push(word);
        else lines[1] = `${lines[1]} ${word}`;
      }
      if (lines[1]?.length > maxCharacters + 7) {
        lines[1] = `${lines[1].slice(0, maxCharacters + 4).trimEnd()}…`;
      }
      const label = d3.select(this);
      const y = Number(label.attr('y')) - (lines.length - 1) * 7;
      label.attr('y', y).text(null);
      label
        .selectAll('tspan')
        .data(lines)
        .join('tspan')
        .attr('x', label.attr('x'))
        .attr('dy', (line, index) => (index ? 15 : 0))
        .text((line) => line);
    });
  }

  function demandRhythm(selector, rows, options = {}) {
    const data = (rows || [])
      .map((d) => ({
        ...d,
        date: parseDate(d.business_date),
        value: Number(d.sales || 0),
        orders: Number(d.orders || 0),
        units: Number(d.units || 0),
      }))
      .filter((d) => d.date)
      .sort((a, b) => d3.ascending(a.date, b.date));
    if (!data.length) return empty(selector, 'Not enough sales history yet.');
    const averageDays = Math.max(2, Number(options.averageDays || 7));
    data.forEach((d, i) => {
      const start = Math.max(0, i - (averageDays - 1));
      d.avg = d3.mean(data.slice(start, i + 1), (x) => x.value) || 0;
      d.weekend = [0, 6].includes(d.date.getUTCDay());
    });
    const positiveDays = data.map((d) => d.value).filter((value) => value > 0);
    const exceptionalThreshold = d3.quantile(positiveDays.sort(d3.ascending), 0.9) || Infinity;
    data.forEach((d) => {
      d.exceptional = d.value >= exceptionalThreshold;
    });
    const hostWidth = Math.max(
      300,
      Math.round(document.querySelector(selector)?.parentElement?.getBoundingClientRect().width || 960),
    );
    const compact = hostWidth < 640;
    const width = compact ? Math.max(520, hostWidth) : hostWidth;
    const height = compact ? 230 : hostWidth > 1500 ? 330 : 290;
    const ctx = shell(
      selector,
      height,
      `Daily shopper spend and ${averageDays}-day moving average`,
      { top: 18, right: 18, bottom: 38, left: compact ? 52 : 62 },
      width,
    );
    const firstDate = data[0].date;
    const latest = data[data.length - 1];
    const yearStart = new Date(Date.UTC(latest.date.getUTCFullYear(), 0, 1));
    const veryShortWindow = data.length <= 3;
    // Early in a calendar month, MTD can contain only four to seven daily observations.
    // A fixed 44px cap makes those primary bars read like minor ticks across a
    // wide chart. Preserve the same proportional occupancy used by other short
    // windows until the month has enough days for the ordinary cap.
    const sparseCalendarWindow = options.window === 'mtd' && data.length <= 7;
    const halfDay = 12 * 60 * 60 * 1000;
    const domainStart = veryShortWindow
      ? new Date(firstDate.getTime() - halfDay)
      : options.window === 'ytd'
        ? yearStart
        : d3.utcDay.floor(firstDate);
    const domainEnd = veryShortWindow
      ? new Date(latest.date.getTime() + halfDay)
      : d3.utcDay.offset(d3.utcDay.floor(latest.date), 1);
    const x = d3.scaleUtc().domain([domainStart, domainEnd]).range([0, ctx.innerW]);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(data, (d) => Math.max(d.value, d.avg)) || 1])
      .nice(3)
      .range([ctx.innerH, 0]);
    const currentWeekStart = d3.utcMonday.floor(latest.date);
    const currentWeekX = Math.max(0, x(currentWeekStart));
    const gradientId = `demand-rhythm-area-${String(selector).replace(/[^a-z0-9]/gi, '')}`;
    const gradient = ctx.svg
      .append('defs')
      .append('linearGradient')
      .attr('id', gradientId)
      .attr('x1', '0%')
      .attr('x2', '0%')
      .attr('y1', '0%')
      .attr('y2', '100%');
    gradient.append('stop').attr('offset', '0%').attr('stop-color', COLORS.cash).attr('stop-opacity', 0.14);
    gradient.append('stop').attr('offset', '100%').attr('stop-color', COLORS.cash).attr('stop-opacity', 0.01);
    if (options.showCurrentWeek !== false) {
      ctx.plot
        .append('rect')
        .attr('class', 'demand-rhythm__current-period')
        .attr('x', currentWeekX)
        .attr('width', Math.max(0, ctx.innerW - currentWeekX))
        .attr('height', ctx.innerH)
        .attr('rx', 5);
    }
    ctx.plot
      .selectAll('.demand-rhythm__week-line')
      .data(d3.utcMonday.range(d3.utcMonday.ceil(firstDate), latest.date))
      .join('line')
      .attr('class', 'demand-rhythm__week-line')
      .attr('x1', (d) => x(d))
      .attr('x2', (d) => x(d))
      .attr('y1', 0)
      .attr('y2', ctx.innerH);
    grid(ctx, y, 3);
    const daySlot = data.length > 1 ? Math.abs(x(data[1].date) - x(data[0].date)) : ctx.innerW;
    const barOccupancy = data.length <= 14 ? 0.5 : data.length <= 45 ? 0.52 : 0.72;
    const barW = Math.max(
      2,
      veryShortWindow || sparseCalendarWindow
        ? Math.min(360, daySlot * barOccupancy)
        : Math.min(44, daySlot * barOccupancy),
    );
    const bars = ctx.plot
      .selectAll('.dpp-bar')
      .data(data)
      .join('rect')
      .attr(
        'class',
        (d) =>
          `dpp-bar demand-rhythm__bar${d.weekend ? ' demand-rhythm__bar--weekend' : ''}${d.exceptional ? ' demand-rhythm__bar--exceptional' : ''}${d.live ? ' demand-rhythm__bar--live' : ''}${d.selected ? ' demand-rhythm__bar--selected' : ''}`,
      )
      .attr('x', (d) => x(d.date) - barW / 2)
      .attr('width', barW)
      .attr('y', (d) => y(d.value))
      .attr('height', (d) => Math.max(1, ctx.innerH - y(d.value)))
      .attr('rx', Math.min(3, barW / 2));
    const line = d3
      .line()
      .x((d) => x(d.date))
      .y((d) => y(d.avg))
      .curve(d3.curveCatmullRom.alpha(0.5));
    const area = d3
      .area()
      .x((d) => x(d.date))
      .y0(y(0))
      .y1((d) => y(d.avg))
      .curve(d3.curveCatmullRom.alpha(0.5));
    ctx.plot
      .append('path')
      .datum(data)
      .attr('class', 'demand-rhythm__area')
      .attr('fill', `url(#${gradientId})`)
      .attr('d', area);
    ctx.plot
      .append('path')
      .datum(data)
      .attr('class', 'dpp-line-halo demand-rhythm__line-halo')
      .attr('d', line);
    ctx.plot.append('path').datum(data).attr('class', 'dpp-line demand-rhythm__line').attr('d', line);
    ctx.plot
      .append('circle')
      .attr('class', 'demand-rhythm__latest-dot')
      .attr('cx', x(latest.date))
      .attr('cy', y(latest.avg))
      .attr('r', 4);
    const labelAbove = y(latest.avg) > 22;
    ctx.plot
      .append('text')
      .attr('class', 'demand-rhythm__latest-label')
      .attr('x', x(latest.date) - 7)
      .attr('y', y(latest.avg) + (labelAbove ? -9 : 17))
      .attr('text-anchor', 'end')
      .text(`${averageDays}-day ${shortMoney(latest.avg)}`);
    if (options.showCurrentWeek !== false && currentWeekX < ctx.innerW - 42) {
      ctx.plot
        .append('text')
        .attr('class', 'demand-rhythm__current-label')
        .attr('x', ctx.innerW - 6)
        .attr('y', 10)
        .attr('text-anchor', 'end')
        .text('PARTIAL');
    }
    const spanDays = Math.max(1, (latest.date - firstDate) / 86400000);
    const tickInterval =
      spanDays > 210 ? d3.utcMonth.every(2) : spanDays > 62 ? d3.utcMonth.every(1) : d3.utcWeek.every(1);
    bottomAxis(ctx, x, spanDays > 62 ? d3.utcFormat('%b') : d3.utcFormat('%b %-d'), tickInterval);
    interactive(bars, ctx, (d) => ({
      title: d3.utcFormat('%b %-d, %Y')(d.date),
      lines: [
        `Shopper spend ${fullMoney(d.value)}`,
        `${averageDays}-day signal ${fullMoney(d.avg)}`,
        ...(d.orders || d.units ? [`${d.orders} orders · ${d.units} units`] : []),
        ...(d.exceptional ? ['High-spend day · top 10%'] : d.weekend ? ['Weekend'] : []),
      ],
    }));
    return {
      rows: data,
      total: d3.sum(data, (d) => d.value),
      average:
        d3.mean(
          data.filter((d) => !d.live),
          (d) => d.value,
        ) || 0,
      best:
        d3.max(
          data.filter((d) => !d.live),
          (d) => d.value,
        ) || 0,
    };
  }

  function homeRhythm(selector, rows, _weeklyProducts, options = {}) {
    return demandRhythm(selector, rows, { showCurrentWeek: true, ...options });
  }

  function monthlySales(selector, rows) {
    const data = (rows || [])
      .map((d) => ({
        ...d,
        key: String(d.month || '').slice(0, 7),
        value: Number(d.sales || 0),
        projected: Number(d.projected_sales || 0),
      }))
      .filter((d) => d.key)
      .sort((a, b) => d3.ascending(a.key, b.key));
    if (!data.length) return empty(selector, 'No monthly sales history yet.');
    const compact = window.innerWidth <= 640;
    const ctx = shell(
      selector,
      340,
      'Monthly sales history with current-month run-rate projection',
      { top: 38, bottom: 44, left: compact ? 52 : 62 },
      compact ? 520 : 960,
    );
    const x = d3
      .scaleBand()
      .domain(data.map((d) => d.key))
      .range([0, ctx.innerW])
      .padding(0.3);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(data, (d) => Math.max(d.value, d.projected)) || 1])
      .nice(4)
      .range([ctx.innerH, 0]);
    grid(ctx, y, 4);
    const patternId = `dpp-run-rate-${String(selector).replace(/[^a-z0-9]/gi, '')}`;
    const pattern = ctx.svg
      .append('defs')
      .append('pattern')
      .attr('id', patternId)
      .attr('width', 7)
      .attr('height', 7)
      .attr('patternUnits', 'userSpaceOnUse')
      .attr('patternTransform', 'rotate(45)');
    pattern
      .append('rect')
      .attr('width', 7)
      .attr('height', 7)
      .attr('fill', COLORS.incomplete)
      .attr('opacity', 0.34);
    pattern
      .append('line')
      .attr('x1', 0)
      .attr('y1', 0)
      .attr('x2', 0)
      .attr('y2', 7)
      .attr('stroke', COLORS.accent)
      .attr('stroke-width', 2)
      .attr('opacity', 0.6);
    const bars = ctx.plot
      .selectAll('.dpp-bar')
      .data(data)
      .join('rect')
      .attr('class', 'dpp-bar')
      .attr('x', (d) => x(d.key))
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(d.value))
      .attr('height', (d) => Math.max(1, ctx.innerH - y(d.value)))
      .attr('rx', 4)
      .style('--dpp-mark-color', (d) => (d.partial ? COLORS.accent : COLORS.sales))
      .attr('fill', 'var(--dpp-mark-color)');
    const projected = data.filter((d) => d.partial && d.projected > d.value);
    const ghosts = ctx.plot
      .selectAll('.dpp-ghost-bar')
      .data(projected)
      .join('rect')
      .attr('class', 'dpp-bar dpp-ghost-bar')
      .attr('x', (d) => x(d.key))
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(d.projected))
      .attr('height', (d) => Math.max(1, y(d.value) - y(d.projected)))
      .attr('rx', 4)
      .attr('fill', `url(#${patternId})`)
      .attr('stroke', COLORS.accent)
      .attr('stroke-width', 1.25);
    if (data.length <= 12) {
      ctx.plot
        .selectAll('.dpp-value')
        .data(data)
        .join('text')
        .attr('class', 'dpp-value')
        .attr('x', (d) => x(d.key) + x.bandwidth() / 2)
        .attr('y', (d) => y(d.value) - 8)
        .attr('text-anchor', 'middle')
        .text((d) =>
          d.partial && d.projected > d.value ? `Actual ${shortMoney(d.value)}` : shortMoney(d.value),
        );
      ctx.plot
        .selectAll('.dpp-projection-value')
        .data(projected)
        .join('text')
        .attr('class', 'dpp-value dpp-projection-value')
        .attr('x', (d) => x(d.key) + x.bandwidth() / 2)
        .attr('y', (d) => y(d.projected) - 9)
        .attr('text-anchor', 'middle')
        .text((d) => `Run rate ${shortMoney(d.projected)}`);
    }
    bottomAxis(ctx, x, monthLabel);
    if (projected.length) {
      const legend = ctx.plot.append('g').attr('class', 'dpp-legend').attr('transform', 'translate(0,-25)');
      const actual = legend.append('g');
      actual.append('rect').attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', COLORS.accent);
      actual.append('text').attr('x', 16).attr('y', 9).text('Current actual');
      const runRate = legend.append('g').attr('transform', 'translate(112,0)');
      runRate
        .append('rect')
        .attr('width', 10)
        .attr('height', 10)
        .attr('rx', 2)
        .attr('fill', `url(#${patternId})`)
        .attr('stroke', COLORS.accent);
      runRate.append('text').attr('x', 16).attr('y', 9).text('Momentum run rate');
    }
    interactive(bars, ctx, (d) => ({
      title: monthLong(d.key),
      lines: [
        `Actual sales ${fullMoney(d.value)}`,
        d.partial ? 'Current month, still partial' : 'Reconciled month',
      ],
    }));
    interactive(ghosts, ctx, (d) => ({
      title: `${monthLong(d.key)} run rate`,
      lines: [
        `Projected total ${fullMoney(d.projected)}`,
        `Remaining momentum ${fullMoney(d.projected - d.value)}`,
        'Directional, not a forecast',
      ],
    }));
  }

  function ads(selector, rows) {
    const data = (rows || [])
      .slice(-28)
      .map((d) => ({
        ...d,
        key: String(d.business_date || '').slice(0, 10),
        spend: Number(d.spend || 0),
        attributed: Number(d.attributed_sales || 0),
        sellerSales: Number(d.total_business_sales || 0),
      }))
      .filter((d) => d.key)
      .sort((a, b) => d3.ascending(a.key, b.key));
    if (!data.length) return empty(selector, 'No advertising history yet.');
    const weekly = [];
    for (let index = 0; index < data.length; index += 7) {
      const days = data.slice(index, index + 7);
      const start = parseDate(days[0].key);
      const end = parseDate(days.at(-1).key);
      const startLabel = d3.utcFormat('%b %-d')(start);
      const endLabel =
        start.getUTCMonth() === end.getUTCMonth() ? d3.utcFormat('%-d')(end) : d3.utcFormat('%b %-d')(end);
      const compactLabel =
        index === 0 ? `${startLabel}–${endLabel}` : `${d3.utcFormat('%-d')(start)}–${endLabel}`;
      const spend = d3.sum(days, (d) => d.spend);
      const sellerSales = d3.sum(days, (d) => d.sellerSales);
      weekly.push({
        label: compactLabel,
        fullLabel: `${startLabel}–${endLabel}`,
        spend,
        sellerSales,
        attributed: d3.sum(days, (d) => d.attributed),
        tacos: sellerSales > 0 ? (spend / sellerSales) * 100 : null,
      });
    }
    const comparable = weekly.filter((week) => Number.isFinite(week.tacos));
    if (!comparable.length)
      return empty(selector, 'Seller sales are unavailable for the current Ads window.');
    const hostWidth = Math.round(
      document.querySelector(selector)?.parentElement?.getBoundingClientRect().width || 760,
    );
    const width = Math.max(340, hostWidth);
    const ctx = shell(
      selector,
      270,
      'Weekly advertising spend per 100 dollars of total seller sales',
      { top: 28, right: 20, bottom: 46, left: 54 },
      width,
    );
    const x = d3
      .scaleBand()
      .domain(comparable.map((d) => d.label))
      .range([0, ctx.innerW])
      .padding(0.42);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(comparable, (d) => d.tacos) || 1])
      .nice(4)
      .range([ctx.innerH, 0]);
    grid(ctx, y, 4, (value) => `${MONEY_PREFIX}${Math.round(Number(value))}`);
    const bars = ctx.plot
      .selectAll('.ads-week-mark')
      .data(comparable)
      .join('rect')
      .attr('class', 'dpp-bar ads-week-mark')
      .attr('x', (d) => x(d.label))
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(d.tacos))
      .attr('height', (d) => Math.max(1, ctx.innerH - y(d.tacos)))
      .attr('rx', 5)
      .style('--dpp-mark-color', COLORS.spend)
      .attr('fill', 'var(--dpp-mark-color)')
      .attr('stroke', COLORS.spend);
    ctx.plot
      .selectAll('.ads-week-value')
      .data(comparable)
      .join('text')
      .attr('class', 'dpp-value ads-week-value')
      .attr('x', (d) => x(d.label) + x.bandwidth() / 2)
      .attr('y', (d) => Math.max(14, y(d.tacos) - 8))
      .attr('text-anchor', 'middle')
      .text((d) => `${MONEY_PREFIX}${Math.round(d.tacos)}`);
    bottomAxis(ctx, x, (value) => value);
    interactive(bars, ctx, (d) => ({
      title: d.fullLabel,
      lines: [
        `${MONEY_PREFIX}${d.tacos.toFixed(1)} ad spend per $100 seller sales`,
        `Ad spend ${fullMoney(d.spend)}`,
        `Total seller sales ${fullMoney(d.sellerSales)}`,
        `Amazon-attributed sales ${fullMoney(d.attributed)}`,
      ],
    }));
  }

  function adsPortfolio(selector, rows) {
    const data = (rows || [])
      .map((d) => ({
        ...d,
        name: d.product || d.product_name || d.sku || 'Product',
        sellerSales: Number(d.total_business_sales || 0),
        spend: Number(d.spend || 0),
        attributed: Number(d.attributed_sales || 0),
        tacos: d.tacos == null ? null : Number(d.tacos) * 100,
      }))
      .filter((d) => d.sellerSales > 0 && Number.isFinite(d.tacos))
      .sort((a, b) => d3.descending(a.tacos, b.tacos));
    if (!data.length) return empty(selector, 'No reconciled product portfolio data yet.');
    const hostWidth = Math.round(
      document.querySelector(selector)?.parentElement?.getBoundingClientRect().width || 960,
    );
    const compact = hostWidth < 640;
    const width = compact ? Math.max(320, hostWidth) : Math.max(680, hostWidth);
    const height = Math.max(300, data.length * (compact ? 58 : 48) + (compact ? 52 : 70));
    const ctx = shell(
      selector,
      height,
      'Products ranked by advertising spend per 100 dollars of total seller sales',
      { top: compact ? 10 : 18, right: compact ? 50 : 72, bottom: 44, left: compact ? 12 : 240 },
      width,
    );
    const x = d3
      .scaleLinear()
      .domain([0, (d3.max(data, (d) => d.tacos) || 1) * 1.12])
      .range([0, ctx.innerW]);
    const y = d3
      .scaleBand()
      .domain(data.map((d) => d.sku || d.name))
      .range([0, ctx.innerH])
      .padding(compact ? 0.34 : 0.48);
    const ticks = x.ticks(4);
    ctx.plot
      .append('g')
      .attr('class', 'dpp-grid')
      .selectAll('line')
      .data(ticks)
      .join('line')
      .attr('x1', (value) => x(value))
      .attr('x2', (value) => x(value))
      .attr('y1', 0)
      .attr('y2', ctx.innerH);
    bottomAxis(ctx, x, (value) => `${MONEY_PREFIX}${Math.round(Number(value))}`, 4);
    const marks = ctx.plot
      .selectAll('.ads-portfolio-mark')
      .data(data)
      .join('rect')
      .attr('class', 'dpp-bar ads-portfolio-mark')
      .attr('x', 0)
      .attr('y', (d) => y(d.sku || d.name) + (compact ? 21 : 0))
      .attr('width', (d) => Math.max(1, x(d.tacos)))
      .attr('height', compact ? Math.min(16, y.bandwidth() - 21) : y.bandwidth())
      .attr('rx', compact ? 8 : y.bandwidth() / 2)
      .style('--dpp-mark-color', COLORS.spend)
      .attr('fill', 'var(--dpp-mark-color)')
      .attr('fill-opacity', 0.86)
      .attr('stroke', COLORS.spend);
    const productLabels = ctx.plot
      .selectAll('.ads-portfolio-label')
      .data(data)
      .join('text')
      .attr('class', 'dpp-label ads-portfolio-label')
      .attr('x', compact ? 0 : -12)
      .attr('y', (d) => y(d.sku || d.name) + (compact ? 14 : y.bandwidth() / 2 + 5))
      .attr('text-anchor', compact ? 'start' : 'end');
    if (compact) productLabels.text((d) => d.name);
    else wrapChartLabels(productLabels, (d) => d.name);
    ctx.plot
      .selectAll('.ads-portfolio-value')
      .data(data)
      .join('text')
      .attr('class', 'dpp-value ads-portfolio-value')
      .attr('x', (d) => x(d.tacos) + 9)
      .attr('y', (d) => y(d.sku || d.name) + (compact ? 35 : y.bandwidth() / 2 + 5))
      .text((d) => `${MONEY_PREFIX}${Math.round(d.tacos)}`);
    interactive(marks, ctx, (d) => ({
      title: `${d.name} · ${d.sku || 'SKU unavailable'}`,
      lines: [
        `${MONEY_PREFIX}${d.tacos.toFixed(1)} ad spend per $100 seller sales`,
        `Total seller sales ${fullMoney(d.sellerSales)}`,
        `Ad spend ${fullMoney(d.spend)}`,
        `Amazon-attributed sales ${fullMoney(d.attributed)}`,
      ],
    }));
  }

  function adsEfficiency(selector, rows) {
    const data = (rows || [])
      .map((d) => ({
        ...d,
        name: d.campaign_name || d.campaign_id || 'Campaign',
        spend: Number(d.spend || 0),
        attributed: Number(d.attributed_sales || 0),
        clicks: Number(d.clicks || 0),
      }))
      .filter((d) => d.spend > 0 && d.attributed >= 0);
    data.forEach((d) => {
      d.roas = d.attributed / d.spend;
    });
    if (data.length < 2) return empty(selector, 'More campaign data is needed for comparison.');
    data.sort((a, b) => d3.descending(a.roas, b.roas));
    const hostWidth = Math.round(
      document.querySelector(selector)?.parentElement?.getBoundingClientRect().width || 960,
    );
    const compact = hostWidth < 640;
    const width = compact ? 680 : Math.max(680, hostWidth);
    const height = Math.max(300, data.length * 46 + 70);
    const ctx = shell(
      selector,
      height,
      'Campaigns ranked by Amazon-attributed sales per dollar of advertising spend',
      { top: 18, right: 68, bottom: 44, left: compact ? 210 : 240 },
      width,
    );
    const x = d3
      .scaleLinear()
      .domain([0, (d3.max(data, (d) => d.roas) || 1) * 1.14])
      .range([0, ctx.innerW]);
    const y = d3
      .scaleBand()
      .domain(data.map((d) => d.campaign_id || d.name))
      .range([0, ctx.innerH])
      .padding(0.48);
    const ticks = x.ticks(4);
    ctx.plot
      .append('g')
      .attr('class', 'dpp-grid')
      .selectAll('line')
      .data(ticks)
      .join('line')
      .attr('x1', (value) => x(value))
      .attr('x2', (value) => x(value))
      .attr('y1', 0)
      .attr('y2', ctx.innerH);
    bottomAxis(ctx, x, (value) => `${Number(value).toFixed(1)}×`, 4);
    const bars = ctx.plot
      .selectAll('.ads-campaign-mark')
      .data(data)
      .join('rect')
      .attr('class', 'dpp-bar ads-campaign-mark')
      .attr('x', 0)
      .attr('y', (d) => y(d.campaign_id || d.name))
      .attr('width', (d) => Math.max(1, x(d.roas)))
      .attr('height', y.bandwidth())
      .attr('rx', y.bandwidth() / 2)
      .style('--dpp-mark-color', COLORS.attributed)
      .attr('fill', 'var(--dpp-mark-color)')
      .attr('fill-opacity', 0.86)
      .attr('stroke', COLORS.attributed);
    const campaignLabels = ctx.plot
      .selectAll('.ads-campaign-label')
      .data(data)
      .join('text')
      .attr('class', 'dpp-label ads-campaign-label')
      .attr('x', -12)
      .attr('y', (d) => y(d.campaign_id || d.name) + y.bandwidth() / 2 + 5)
      .attr('text-anchor', 'end');
    wrapChartLabels(campaignLabels, (d) => d.name);
    ctx.plot
      .selectAll('.ads-campaign-value')
      .data(data)
      .join('text')
      .attr('class', 'dpp-value ads-campaign-value')
      .attr('x', (d) => x(d.roas) + 9)
      .attr('y', (d) => y(d.campaign_id || d.name) + y.bandwidth() / 2 + 5)
      .text((d) => `${d.roas.toFixed(2)}×`);
    interactive(bars, ctx, (d) => ({
      title: d.name,
      lines: [
        `Spend ${fullMoney(d.spend)}`,
        `Attributed sales ${fullMoney(d.attributed)}`,
        `ROAS ${d.roas.toFixed(2)}×`,
        `${d.clicks} clicks`,
      ],
    }));
  }

  function trajectory(selector, rows, options = {}) {
    const data = (rows || [])
      .map((d) => ({
        ...d,
        date: parseDate(d.business_date),
        value: Number(d.sales || 0),
        avg: Number(d.avg28 || 0),
      }))
      .filter((d) => d.date)
      .sort((a, b) => d3.ascending(a.date, b.date));
    if (data.length < 2) return empty(selector, 'Not enough trajectory history yet.');
    const hostWidth = Math.max(
      300,
      Math.round(document.querySelector(selector)?.parentElement?.getBoundingClientRect().width || 0),
    );
    const compact = hostWidth < 640;
    const weekly = options.aggregate === 'weekly' || data.length > 120;
    const marks = weekly ? aggregateSeriesByWeek(data) : data;
    const ctx = shell(
      selector,
      compact ? 280 : hostWidth > 1500 ? 420 : 350,
      weekly
        ? 'Weekly average daily shopper spend and 28-day moving average'
        : 'Daily shopper spend and 28-day moving average',
      { top: 20, bottom: 44, left: compact ? 52 : 62 },
      hostWidth,
    );
    const x = weekly
      ? d3
          .scaleBand()
          .domain(marks.map((d) => +d.date))
          .range([0, ctx.innerW])
          .padding(0.28)
      : d3
          .scaleUtc()
          .domain(d3.extent(data, (d) => d.date))
          .range([0, ctx.innerW]);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(marks, (d) => Math.max(d.value, d.avg)) || 1])
      .nice(4)
      .range([ctx.innerH, 0]);
    grid(ctx, y, 4);
    const barW = weekly ? x.bandwidth() : Math.max(2, Math.min(8, (ctx.innerW / marks.length) * 0.58));
    const bars = ctx.plot
      .selectAll('.dpp-bar')
      .data(marks)
      .join('rect')
      .attr('class', 'dpp-bar')
      .attr('x', (d) => (weekly ? x(+d.date) : x(d.date) - barW / 2))
      .attr('width', barW)
      .attr('y', (d) => y(d.value))
      .attr('height', (d) => Math.max(1, ctx.innerH - y(d.value)))
      .style('--dpp-mark-color', COLORS.salesLight)
      .attr('fill', 'var(--dpp-mark-color)')
      .attr('opacity', 0.64);
    const line = d3
      .line()
      .defined((d) => Number.isFinite(d.avg))
      .x((d) => (weekly ? x(+d.date) + x.bandwidth() / 2 : x(d.date)))
      .y((d) => y(d.avg))
      .curve(d3.curveMonotoneX);
    ctx.plot.append('path').datum(marks).attr('class', 'dpp-line-halo').attr('d', line);
    ctx.plot.append('path').datum(marks).attr('class', 'dpp-line').attr('d', line);
    if (weekly) {
      const values = marks.map((d) => +d.date);
      const tickValues = trajectoryTickValues(
        values,
        values.map((value) => x(value) + x.bandwidth() / 2),
        ctx.innerW,
        compact,
      );
      bottomAxis(ctx, x, (value) => d3.utcFormat('%b %-d')(new Date(Number(value))), null, tickValues);
    } else {
      bottomAxis(ctx, x, d3.utcFormat('%b'), d3.utcMonth.every(1));
    }
    interactive(bars, ctx, (d) => ({
      title: weekly
        ? `${d3.utcFormat('%b %-d')(d.date)}–${d3.utcFormat('%b %-d, %Y')(d.end)}`
        : d3.utcFormat('%b %-d, %Y')(d.date),
      lines: weekly
        ? [
            `Average daily shopper spend ${fullMoney(d.value)}`,
            `Week total ${fullMoney(d.total)}`,
            `28-day average ${fullMoney(d.avg)}`,
          ]
        : [`Shopper spend ${fullMoney(d.value)}`, `28-day average ${fullMoney(d.avg)}`],
    }));
  }

  function trajectoryTickValues(values, positions, plotWidth, compact = false) {
    if (values.length <= 2) return values.slice();
    const minimumSpacing = compact ? 64 : 76;
    const tickCount = Math.min(
      values.length,
      Math.max(2, Math.min(8, Math.floor(plotWidth / minimumSpacing))),
    );
    const lastIndex = values.length - 1;
    const candidateIndexes = Array.from({ length: tickCount }, (_, index) =>
      Math.round((index * lastIndex) / (tickCount - 1)),
    );
    const selectedIndexes = [0];
    const lastPosition = positions[lastIndex];
    candidateIndexes.slice(1, -1).forEach((index) => {
      const previousIndex = selectedIndexes.at(-1);
      if (
        positions[index] - positions[previousIndex] >= minimumSpacing &&
        lastPosition - positions[index] >= minimumSpacing
      ) {
        selectedIndexes.push(index);
      }
    });
    selectedIndexes.push(lastIndex);
    return selectedIndexes.map((index) => values[index]);
  }

  function aggregateSeriesByWeek(data) {
    return d3
      .rollups(
        data,
        (values) => ({
          date: d3.min(values, (d) => d.date),
          end: d3.max(values, (d) => d.date),
          value: d3.mean(values, (d) => d.value) || 0,
          total: d3.sum(values, (d) => d.value),
          avg: values.at(-1)?.avg || 0,
          days: values.length,
        }),
        (d) => +d3.utcMonday.floor(d.date),
      )
      .map(([, value]) => value);
  }

  function financeWaterfall(selector, rows) {
    const aggregate = !Array.isArray(rows) && rows ? rows : null;
    const sorted = Array.isArray(rows)
      ? rows
          .slice()
          .filter((d) => d.month)
          .sort((a, b) => d3.ascending(String(a.month), String(b.month)))
      : [];
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
      {
        key: 'Amazon',
        detail: 'Fees, withholding and refunds',
        start: running,
        end: (running += deductions),
        value: deductions,
        kind: 'change',
      },
      {
        key: 'Advertising',
        detail: 'Monthly advertising charge',
        start: running,
        end: (running += advertising),
        value: advertising,
        kind: 'change',
      },
      {
        key: 'Product cost',
        detail: 'Seller-owned product COGS',
        start: running,
        end: (running += productCost),
        value: productCost,
        kind: 'change',
      },
      {
        key: 'Contribution',
        detail: 'Before off-Amazon overhead',
        start: 0,
        end: contribution,
        value: contribution,
        kind: 'total',
      },
    ];
    const compact = window.innerWidth <= 640;
    const periodLabel = aggregate
      ? `${latest.year} YTD through ${monthLong(latest.through_month)}`
      : monthLong(latest.month);
    const ctx = shell(
      selector,
      compact ? 390 : 350,
      `${periodLabel} contribution waterfall`,
      { top: 34, bottom: 58, left: compact ? 54 : 68, right: 24 },
      compact ? 520 : 960,
    );
    const x = d3
      .scaleBand()
      .domain(data.map((d) => d.key))
      .range([0, ctx.innerW])
      .padding(0.34);
    const extents = data.flatMap((d) => [d.start, d.end]);
    const lo = Math.min(0, d3.min(extents)),
      hi = Math.max(0, d3.max(extents));
    const pad = Math.max(1, (hi - lo) * 0.12);
    const y = d3
      .scaleLinear()
      .domain([lo - pad, hi + pad])
      .nice(5)
      .range([ctx.innerH, 0]);
    grid(ctx, y, 5);
    ctx.plot
      .append('line')
      .attr('class', 'dpp-zero')
      .attr('x1', 0)
      .attr('x2', ctx.innerW)
      .attr('y1', y(0))
      .attr('y2', y(0));
    for (let i = 0; i < data.length - 2; i++) {
      ctx.plot
        .append('line')
        .attr('class', 'dpp-connector')
        .attr('x1', x(data[i].key) + x.bandwidth())
        .attr('x2', x(data[i + 1].key))
        .attr('y1', y(data[i].end))
        .attr('y2', y(data[i].end));
    }
    const bars = ctx.plot
      .selectAll('.dpp-bar')
      .data(data)
      .join('rect')
      .attr('class', 'dpp-bar')
      .attr('x', (d) => x(d.key))
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(Math.max(d.start, d.end)))
      .attr('height', (d) => Math.max(2, Math.abs(y(d.start) - y(d.end))))
      .attr('rx', 4)
      .style('--dpp-mark-color', (d) =>
        d.kind === 'sales'
          ? COLORS.sales
          : d.kind === 'total'
            ? d.value >= 0
              ? COLORS.good
              : COLORS.bad
            : d.value >= 0
              ? COLORS.good
              : COLORS.bad,
      )
      .attr('fill', 'var(--dpp-mark-color)');
    ctx.plot
      .selectAll('.dpp-value')
      .data(data)
      .join('text')
      .attr('class', 'dpp-value')
      .attr('x', (d) => x(d.key) + x.bandwidth() / 2)
      .attr('y', (d) => (d.value >= 0 ? y(Math.max(d.start, d.end)) - 9 : y(Math.min(d.start, d.end)) + 17))
      .attr('text-anchor', 'middle')
      .text((d) => shortMoney(d.value));
    bottomAxis(ctx, x, (d) => (compact && d === 'Product cost' ? 'Product' : d));
    ctx.plot
      .append('text')
      .attr('class', 'dpp-muted')
      .attr('x', 0)
      .attr('y', -18)
      .text(`${periodLabel} · sales to contribution`);
    interactive(bars, ctx, (d) => ({ title: d.key, lines: [d.detail, fullMoney(d.value)] }));
  }

  function dailyRhythm(selector, rows, options = {}) {
    const data = (rows || [])
      .map((d) => ({
        ...d,
        date: parseDate(d.business_date),
        value: Number(d.sales || 0),
        orders: Number(d.orders || 0),
      }))
      .filter((d) => d.date)
      .sort((a, b) => d3.ascending(a.date, b.date));
    if (!data.length) return empty(selector, 'No sales rhythm for this period.');
    const compact = window.innerWidth <= 640;
    const ctx = shell(
      selector,
      220,
      'Daily sales rhythm',
      { top: 12, right: 12, bottom: 32, left: compact ? 54 : 64 },
      compact ? 520 : 960,
    );
    const x = d3
      .scaleBand()
      .domain(data.map((d) => d.business_date))
      .range([0, ctx.innerW])
      .padding(0.34);
    const y = d3
      .scaleLinear()
      .domain([0, d3.max(data, (d) => d.value) || 1])
      .nice(3)
      .range([ctx.innerH, 0]);
    grid(ctx, y, 3);
    const wall = document.documentElement.classList.contains('wall-mode');
    const bars = ctx.plot
      .selectAll('.dpp-bar')
      .data(data)
      .join('rect')
      .attr('class', 'dpp-bar')
      .attr('x', (d) => x(d.business_date))
      .attr('width', x.bandwidth())
      .attr('y', (d) => y(d.value))
      .attr('height', (d) => Math.max(2, ctx.innerH - y(d.value)))
      .attr('rx', 3)
      .style('--dpp-mark-color', (d) =>
        d.live
          ? wall
            ? COLORS.warning
            : COLORS.accent
          : d.selected
            ? COLORS.selected
            : wall
              ? COLORS.incomplete
              : COLORS.salesLight,
      )
      .attr('fill', 'var(--dpp-mark-color)');
    bottomAxis(ctx, x, (d, i) => {
      if (i === 0 || i === data.length - 1 || i === Math.floor((data.length - 1) / 2)) {
        const row = data[i];
        return row.live ? 'Today' : row.selected && !options.live ? 'Selected' : String(d).slice(5);
      }
      return '';
    });
    interactive(bars, ctx, (d) => ({
      title: d3.utcFormat('%b %-d, %Y')(d.date),
      lines: [`Sales ${fullMoney(d.value)}`, `${d.orders} order${d.orders === 1 ? '' : 's'}`],
    }));
  }

  function productDemand(selector, rows, options = {}) {
    const metric = options.metric === 'units' ? 'units' : 'sales';
    const data = (rows || [])
      .map((d) => ({
        ...d,
        date: parseDate(d.business_date),
        value: Number(metric === 'units' ? d.units || 0 : d.sales || 0),
        sales: Number(d.sales || 0),
        units: Number(d.units || 0),
      }))
      .filter((d) => d.date)
      .sort((a, b) => d3.ascending(a.date, b.date));
    if (!data.length) return empty(selector, 'No demand history for this product.');
    data.forEach((d, i) => {
      d.avg = d3.mean(data.slice(Math.max(0, i - 6), i + 1), (x) => x.value) || 0;
    });
    const maximum = d3.max(data, (d) => Math.max(d.value, d.avg)) || 0;
    if (maximum === 0) {
      return empty(
        selector,
        metric === 'units' ? 'No units ordered in this range.' : 'No demand in this range.',
      );
    }
    const compact = window.innerWidth <= 640;
    const ctx = shell(
      selector,
      300,
      metric === 'units'
        ? 'Product daily units and seven-day trend'
        : 'Product daily sales and seven-day trend',
      { top: 18, right: 6, bottom: 38, left: compact ? 42 : 48 },
      compact ? 520 : 960,
    );
    const x = d3
      .scaleUtc()
      .domain(d3.extent(data, (d) => d.date))
      .range([0, ctx.innerW]);
    const y = d3.scaleLinear().domain([0, maximum]).nice(4).range([ctx.innerH, 0]);
    grid(ctx, y, 4, metric === 'units' ? d3.format('~g') : shortMoney);
    const barW = Math.max(2.5, Math.min(18, (ctx.innerW / data.length) * 0.58));
    const bars = ctx.plot
      .selectAll('.dpp-bar')
      .data(data)
      .join('rect')
      .attr('class', 'dpp-bar')
      .attr('x', (d) => x(d.date) - barW / 2)
      .attr('width', barW)
      .attr('y', (d) => y(d.value))
      .attr('height', (d) => Math.max(1, ctx.innerH - y(d.value)))
      .attr('rx', 3)
      .style('--dpp-mark-color', (d, i) => (i === data.length - 1 ? COLORS.accent : COLORS.salesLight))
      .attr('fill', 'var(--dpp-mark-color)')
      .attr('opacity', (d, i) => (i === data.length - 1 ? 1 : 0.78));
    const line = d3
      .line()
      .x((d) => x(d.date))
      .y((d) => y(d.avg))
      .curve(d3.curveMonotoneX);
    ctx.plot.append('path').datum(data).attr('class', 'dpp-line-halo').attr('d', line);
    ctx.plot.append('path').datum(data).attr('class', 'dpp-line').attr('d', line);
    bottomAxis(ctx, x, d3.utcFormat('%b %-d'), data.length > 45 ? 5 : 4);
    const legend = ctx.plot.append('g').attr('class', 'dpp-legend').attr('transform', 'translate(0,-8)');
    legend
      .append('line')
      .attr('x1', 0)
      .attr('x2', 20)
      .attr('y1', -4)
      .attr('y2', -4)
      .attr('stroke', COLORS.ink)
      .attr('stroke-width', 3);
    legend
      .append('text')
      .attr('x', 27)
      .attr('y', 0)
      .text(metric === 'units' ? '7-day unit signal' : '7-day demand signal');
    interactive(bars, ctx, (d) => ({
      title: d3.utcFormat('%b %-d, %Y')(d.date),
      lines: [
        `Sales ${fullMoney(d.sales)}`,
        `${d.units} unit${d.units === 1 ? '' : 's'}`,
        metric === 'units'
          ? `7-day signal ${d.avg.toFixed(d.avg < 10 ? 1 : 0)} units`
          : `7-day signal ${fullMoney(d.avg)}`,
      ],
    }));
  }

  window.DPPCharts = {
    demandRhythm,
    homeRhythm,
    monthlySales,
    ads,
    adsPortfolio,
    adsEfficiency,
    trajectory,
    financeWaterfall,
    dailyRhythm,
    productDemand,
    trajectoryTickValues,
  };
})();
