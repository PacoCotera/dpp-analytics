(() => {
  const money = value => {
    const n = Number(value || 0);
    return (n < 0 ? '−$' : '$') + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(n)));
  };
  const pct = value => value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(1)}%`;

  function redrawScale(rows) {
    const svg = document.getElementById('chart');
    if (!svg || !rows?.length) return;
    const W = 900, H = 280, L = 70, R = 12, T = 16, B = 32;
    const w = W - L - R, h = H - T - B;
    const vals = rows.map(r => Number(r.operating_balance || 0));
    const raw = Math.max(...vals.map(Math.abs), 100);
    const step = raw > 10000 ? 5000 : raw > 5000 ? 2500 : raw > 2000 ? 1000 : raw > 1000 ? 500 : 250;
    const abs = Math.ceil(raw / step) * step;
    const mid = T + h / 2;
    const x = i => L + (i + .5) * w / vals.length;
    const y = v => mid - (v / abs) * (h / 2 - 5);
    const bw = Math.max(2, w / vals.length * .62);
    const out = [];
    [1, .5, 0, -.5, -1].forEach(fr => {
      const value = abs * fr;
      const yy = y(value);
      out.push(`<line class="${fr === 0 ? 'zero' : 'gline'}" x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}"/>`);
      out.push(`<text class="axis" x="${L-8}" y="${yy+4}" text-anchor="end">${money(value)}</text>`);
    });
    vals.forEach((v, i) => {
      const yy = y(v), top = Math.min(mid, yy), height = Math.max(1, Math.abs(mid - yy));
      out.push(`<rect class="${v >= 0 ? 'bar-pos' : 'bar-neg'}" x="${x(i)-bw/2}" y="${top}" width="${bw}" height="${height}" rx="2"><title>${String(rows[i].business_date).slice(5)} · ${money(v)}</title></rect>`);
    });
    [0, Math.floor((vals.length - 1) / 2), vals.length - 1].forEach(i => {
      out.push(`<text class="axis" x="${x(i)}" y="${H-7}" text-anchor="middle">${String(rows[i].business_date).slice(5)}</text>`);
    });
    svg.innerHTML = out.join('');
  }

  function addProfitTest(summary) {
    const story = document.querySelector('.story');
    if (!story || document.getElementById('profitTest')) return;
    const balance = Number(summary.operating_ledger_balance_28 || 0);
    const rate = summary.amazon_contribution_rate_28;
    const room = Math.max(balance, 0);
    const prior = Number(summary.operating_ledger_balance_prior_28 || 0);
    let answer, copy, tone;
    if (balance <= 0) {
      answer = 'No, not on the Amazon ledger.';
      copy = `The 28-day Amazon-side contribution is ${money(balance)} before product COGS and other off-Amazon costs. The period is already below zero on the costs we can see.`;
      tone = 'bad';
    } else {
      answer = 'Possibly, but COGS decides it.';
      copy = `Amazon leaves ${money(balance)} after the operating events recorded here${rate == null ? '' : `, equal to ${pct(rate)} of shipment-event value`}. DPP is profitable for this period only if product COGS plus all other off-Amazon costs are below ${money(room)}.`;
      tone = 'good';
    }
    const comparison = prior === 0 ? '' : ` Prior 28-day Amazon-side contribution: ${money(prior)}.`;
    const node = document.createElement('section');
    node.id = 'profitTest';
    node.className = 'card card-pad';
    node.style.marginTop = '14px';
    node.innerHTML = `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center"><div><div class="kicker">Can we call it profit?</div><div class="section-title ${tone}" style="font-size:24px;margin:5px 0 6px">${answer}</div><div class="section-sub" style="font-size:14px;max-width:820px">${copy}${comparison}</div></div><div style="text-align:right"><div class="metric-label">Break-even room</div><div class="metric-value ${tone}" style="margin:6px 0">${money(room)}</div><div class="metric-note">maximum COGS + off-Amazon cost before this 28D period turns negative</div></div></div>`;
    story.insertAdjacentElement('afterend', node);
  }

  fetch('/api/finance', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(data => {
      const s = data.summary || {};
      const h1 = document.querySelector('.page-head h1');
      const summary = document.querySelector('.page-summary');
      if (h1) h1.textContent = 'Are we making money?';
      if (summary) summary.textContent = 'Start with what Amazon can prove, then make the missing cost side explicit. True profit needs product COGS and off-Amazon operating costs.';
      const title = document.getElementById('storyTitle');
      const copy = document.getElementById('storyCopy');
      const caption = document.querySelector('.story-caption');
      const balance = Number(s.operating_ledger_balance_28 || 0);
      if (title) title.textContent = balance > 0 ? 'Amazon-side contribution is positive.' : 'Amazon-side contribution is negative.';
      if (copy) copy.textContent = balance > 0
        ? 'After the Amazon-recorded operating events included here, money remains. Whether that becomes actual profit depends on product COGS and every cost outside Amazon.'
        : 'The Amazon-recorded operating ledger is already below zero before product COGS and other off-Amazon costs are added.';
      if (caption) caption.textContent = `28-day Amazon-side contribution${s.amazon_contribution_rate_28 == null ? '' : ` · ${pct(s.amazon_contribution_rate_28)} of shipment-event value`}`;
      addProfitTest(s);
      window.setTimeout(() => redrawScale(data.daily || []), 450);
    })
    .catch(() => {});
})();
