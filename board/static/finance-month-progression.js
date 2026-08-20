(() => {
  'use strict';
  const MARKER = 'data-finance-month-progression-v2';
  if (document.documentElement.hasAttribute(MARKER)) return;
  document.documentElement.setAttribute(MARKER, '1');

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthName = value => {
    if (!value) return '—';
    const [year, month] = String(value).slice(0, 7).split('-').map(Number);
    return `${months[month - 1]} ${String(year).slice(-2)}`;
  };
  const shortMoney = value => {
    const n = Number(value || 0), amount = Math.abs(n);
    if (amount >= 1000) return `${n < 0 ? '−' : ''}$${(amount / 1000).toFixed(amount >= 10000 ? 0 : 1)}k`;
    return `${n < 0 ? '−' : ''}$${Math.round(amount)}`;
  };
  const fullMoney = value => `${Number(value || 0) < 0 ? '−' : ''}$${new Intl.NumberFormat('en-US', {maximumFractionDigits: 0}).format(Math.abs(Math.round(Number(value || 0))))}`;

  const style = document.createElement('style');
  style.textContent = `
    .finance-progression{margin-top:24px;border-top:2px solid var(--ink);padding-top:13px}
    .finance-progression-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:7px}
    .finance-progression-title{font-size:20px;font-weight:830;letter-spacing:-.02em}
    .finance-progression-sub{font-size:11px;color:var(--muted);line-height:1.45;margin-top:3px;max-width:720px}
    .finance-progression-status{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:10px;font-weight:750;white-space:nowrap}
    .finance-progression-status:before{content:'';width:7px;height:7px;border-radius:50%;background:var(--good)}
    .finance-progression-chart{display:block;width:100%;height:auto;overflow:visible;touch-action:pan-y}
    .finance-progression-tip{position:absolute;z-index:8;min-width:165px;padding:10px 12px;border-radius:12px;background:rgba(30,28,25,.96);color:#fffaf1;box-shadow:0 12px 30px rgba(28,24,20,.18);font-size:11px;line-height:1.45;pointer-events:none;opacity:0;transform:translate(-50%,-100%) translateY(-10px);transition:opacity .12s ease}
    .finance-progression-tip.show{opacity:1}.finance-progression-tip strong{display:block;font-size:12px;margin-bottom:2px}.finance-progression-tip span{display:block;color:#d9d1c6}
    @media(max-width:640px){.finance-progression-head{display:block}.finance-progression-status{margin-top:7px}.finance-progression-sub{font-size:12px}.finance-progression-tip{display:none}}
  `;
  document.head.appendChild(style);

  function chart(host, rows) {
    const d3 = window.d3;
    if (!d3) throw new Error('D3 is unavailable');
    const data = (rows || []).slice().filter(row => row.month).sort((a, b) => String(a.month).localeCompare(String(b.month))).map((row, index, all) => {
      const contribution = Number(row.contribution_after_product_cogs || 0);
      const windowRows = all.slice(Math.max(0, index - 2), index + 1);
      const signal = d3.mean(windowRows, item => Number(item.contribution_after_product_cogs || 0)) || 0;
      return {...row, contribution, signal};
    });
    if (!data.length) return;

    const compact = window.innerWidth <= 640;
    const width = compact ? 520 : 960, height = compact ? 330 : 320;
    const margin = {top: 42, right: 24, bottom: 54, left: compact ? 58 : 70};
    const innerW = width - margin.left - margin.right, innerH = height - margin.top - margin.bottom;
    const svg = d3.select(host).attr('viewBox', `0 0 ${width} ${height}`).attr('preserveAspectRatio', 'xMidYMid meet').attr('role', 'img').attr('aria-label', 'Month-to-month contribution progression');
    svg.selectAll('*').remove();
    const plot = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    const x = d3.scaleBand().domain(data.map(d => String(d.month).slice(0, 7))).range([0, innerW]).padding(.34);
    const extent = data.flatMap(d => [d.contribution, d.signal, 0]);
    const pad = Math.max(250, (d3.max(extent) - d3.min(extent)) * .14);
    const y = d3.scaleLinear().domain([d3.min(extent) - pad, d3.max(extent) + pad]).nice(5).range([innerH, 0]);

    plot.append('g').attr('class', 'dpp-grid').call(d3.axisLeft(y).ticks(5).tickSize(-innerW).tickFormat(''));
    plot.append('g').attr('class', 'dpp-axis').call(d3.axisLeft(y).ticks(5).tickSize(0).tickPadding(10).tickFormat(shortMoney)).call(g => g.select('.domain').remove());
    plot.append('g').attr('class', 'dpp-axis').attr('transform', `translate(0,${innerH})`).call(d3.axisBottom(x).tickSize(0).tickPadding(12).tickFormat(monthName)).call(g => g.select('.domain').attr('stroke', '#cfc5b7'));
    plot.append('line').attr('class', 'dpp-zero').attr('x1', 0).attr('x2', innerW).attr('y1', y(0)).attr('y2', y(0));

    const bars = plot.selectAll('.finance-month-bar').data(data).join('rect')
      .attr('class', 'dpp-bar finance-month-bar').attr('tabindex', 0)
      .attr('x', d => x(String(d.month).slice(0, 7))).attr('width', x.bandwidth())
      .attr('y', d => y(Math.max(0, d.contribution))).attr('height', d => Math.max(2, Math.abs(y(d.contribution) - y(0))))
      .attr('rx', 4).attr('fill', d => d.contribution >= 0 ? '#2f7d4f' : '#c94b43');

    plot.selectAll('.finance-month-value').data(data).join('text').attr('class', 'dpp-value finance-month-value')
      .attr('x', d => x(String(d.month).slice(0, 7)) + x.bandwidth() / 2)
      .attr('y', d => d.contribution >= 0 ? y(d.contribution) - 9 : y(d.contribution) + 17)
      .attr('text-anchor', 'middle').text(d => shortMoney(d.contribution));

    const signal = d3.line().x(d => x(String(d.month).slice(0, 7)) + x.bandwidth() / 2).y(d => y(d.signal)).curve(d3.curveMonotoneX);
    plot.append('path').datum(data).attr('class', 'dpp-line-halo').attr('d', signal)
      .attr('fill', 'none').attr('stroke', '#f8f5ef').attr('stroke-width', 7).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
    plot.append('path').datum(data).attr('class', 'dpp-line').attr('d', signal)
      .attr('fill', 'none').attr('stroke', '#26231f').attr('stroke-width', 3).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round');
    plot.selectAll('.finance-signal-dot').data(data).join('circle').attr('class', 'dpp-dot finance-signal-dot')
      .attr('cx', d => x(String(d.month).slice(0, 7)) + x.bandwidth() / 2).attr('cy', d => y(d.signal)).attr('r', 4);

    const legend = plot.append('g').attr('class', 'dpp-legend').attr('transform', 'translate(0,-24)');
    legend.append('rect').attr('width', 10).attr('height', 10).attr('rx', 2).attr('fill', '#c94b43');
    legend.append('text').attr('x', 16).attr('y', 9).text('Monthly contribution');
    const trend = legend.append('g').attr('transform', 'translate(154,0)');
    trend.append('line').attr('x1', 0).attr('x2', 20).attr('y1', 5).attr('y2', 5).attr('stroke', '#26231f').attr('stroke-width', 3);
    trend.append('circle').attr('cx', 10).attr('cy', 5).attr('r', 3).attr('fill', '#26231f');
    trend.append('text').attr('x', 27).attr('y', 9).text('3-month signal');

    const wrap = host.parentElement;
    let tip = wrap.querySelector('.finance-progression-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'finance-progression-tip'; wrap.appendChild(tip); }
    const show = (event, d) => {
      const rect = wrap.getBoundingClientRect(), mark = event.currentTarget.getBoundingClientRect();
      tip.innerHTML = `<strong>${monthName(d.month)}</strong><span>Contribution ${fullMoney(d.contribution)}</span><span>Margin ${Number(d.contribution_margin_pct || 0).toFixed(1)}%</span><span>Sales ${fullMoney(d.net_sales_ex_vat)}</span>`;
      tip.style.left = `${Math.max(78, Math.min(rect.width - 78, mark.left + mark.width / 2 - rect.left))}px`;
      tip.style.top = `${Math.max(58, mark.top - rect.top)}px`; tip.classList.add('show');
    };
    bars.on('pointerenter pointermove focus', show).on('pointerleave blur', () => tip.classList.remove('show'));
  }

  function progression(rows) {
    if (!(rows || []).some(row => row.month)) return null;
    const section = document.createElement('section');
    section.className = 'finance-progression'; section.dataset.financeProgression = '1';
    section.innerHTML = `<div class="finance-progression-head"><div><div class="finance-progression-title">Month-to-month contribution progression</div><div class="finance-progression-sub">Contribution after Amazon deductions, advertising and product cost. The line smooths the direction across three months.</div></div><div class="finance-progression-status">Closed months</div></div><svg class="finance-progression-chart"></svg>`;
    chart(section.querySelector('svg'), rows);
    return section;
  }

  async function mount() {
    try {
      const response = await fetch('/api/finance', {cache: 'no-store'});
      if (!response.ok) return;
      const data = await response.json(), cash = document.getElementById('cashView');
      if (!cash) return;
      cash.querySelector('[data-finance-progression]')?.remove();
      const section = progression(data.closed_months || []);
      if (!section) return;
      const ytd = cash.querySelector('#ytdChart')?.closest('.chart-wrap');
      const current = cash.querySelector('#closedChart')?.closest('.chart-wrap');
      (ytd || current || cash.querySelector('.closed-summary'))?.insertAdjacentElement('afterend', section);
      const currentTitle = current?.querySelector('.chart-title');
      if (currentTitle) currentTitle.textContent = 'Current closed-month contribution bridge';
      const status = current?.querySelector('.chart-status');
      if (status) status.textContent = 'Current closed month';
    } catch (error) {
      console.error('finance progression', error);
    }
  }
  setTimeout(mount, 250);
  setTimeout(mount, 1500);
})();
