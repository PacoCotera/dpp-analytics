(() => {
  const money = value => {
    const n = Number(value || 0);
    return (n < 0 ? '−$' : '$') + new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(Math.round(n)));
  };
  const pct = value => value == null ? '—' : `${Number(value) > 0 ? '+' : ''}${Number(value).toFixed(1)}%`;

  const style = document.createElement('style');
  style.textContent = `
    /* Finance should read like a compact P&L bridge, not a stack of hero cards. */
    #overview .balance-story{
      background:transparent!important;
      color:var(--ink)!important;
      box-shadow:none!important;
      border:0!important;
      border-radius:0!important;
      padding:10px 3px 8px!important;
      grid-template-columns:minmax(0,1fr) auto!important;
      align-items:end!important;
      gap:26px!important;
      overflow:visible!important;
    }
    #overview .balance-story:after{display:none!important}
    #overview .balance-story .kicker{color:var(--accent-ink)!important}
    #overview .balance-story h2{color:var(--ink)!important;font-size:clamp(28px,3vw,42px)!important;margin:5px 0 7px!important}
    #overview .balance-story p{color:var(--muted)!important;font-size:14px!important;line-height:1.5!important;max-width:760px!important}
    #overview .balance-story .story-side{text-align:right;min-width:220px}
    #overview .balance-story .story-number{font-size:48px!important;line-height:.95!important}
    #overview .balance-story .story-caption{color:var(--muted)!important;font-size:12px!important}
    #overview .balance-explain{display:none!important}

    .profit-bridge{
      margin-top:12px;
      background:rgba(255,253,249,.78);
      border:1px solid var(--line);
      border-radius:18px;
      padding:15px 17px;
    }
    .profit-answer{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:13px}
    .profit-answer .answer{font-size:21px;font-weight:830;letter-spacing:-.025em;line-height:1.15}
    .profit-answer .answer-copy{font-size:13px;color:var(--muted);line-height:1.45;margin-top:4px;max-width:760px}
    .cost-coverage{font-size:11px;color:var(--muted);white-space:nowrap;padding-top:3px}
    .bridge-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0;border-top:1px solid var(--line)}
    .bridge-step{padding:12px 14px 3px 0;min-width:0}
    .bridge-step+ .bridge-step{border-left:1px solid var(--line);padding-left:14px}
    .bridge-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:800;color:var(--muted)}
    .bridge-value{font-size:25px;font-weight:840;letter-spacing:-.04em;margin-top:4px;line-height:1}
    .bridge-note{font-size:11px;color:var(--muted);line-height:1.35;margin-top:5px}
    .bridge-op{font-weight:500;color:var(--faint);margin-right:4px}

    @media(max-width:640px){
      #overview .balance-story{grid-template-columns:1fr!important;padding-top:4px!important;gap:10px!important}
      #overview .balance-story .story-side{text-align:left!important;min-width:0!important;display:flex!important;flex-direction:row!important;align-items:baseline!important;gap:9px!important}
      #overview .balance-story .story-number{font-size:38px!important}
      #overview .balance-story h2{font-size:29px!important}
      #overview .balance-story p{font-size:14px!important}
      .profit-answer{display:block}
      .cost-coverage{margin-top:6px;white-space:normal}
      .bridge-row{grid-template-columns:1fr!important}
      .bridge-step{padding:10px 0!important;border-left:0!important;border-top:1px solid var(--line)}
      .bridge-step:first-child{border-top:0}
      .bridge-value{font-size:24px}
      #overview .grid.four{grid-template-columns:1fr 1fr!important;gap:8px!important}
      #overview .grid.four .metric{min-height:104px!important;padding:13px 14px!important}
      #overview .grid.four .metric-value{font-size:28px!important;margin:7px 0!important}
      #overview .grid.four .metric-note{font-size:11px!important;line-height:1.35!important}
    }
  `;
  document.head.appendChild(style);

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

  function addProfitBridge(summary, cogsRows) {
    const story = document.querySelector('.balance-story');
    if (!story || document.getElementById('profitBridge')) return;
    const amazon = Number(summary.operating_ledger_balance_28 || 0);
    const complete = !!summary.product_cogs_complete_28;
    const knownCogs = Number(summary.product_cogs_known_28 || 0);
    const coverage = Number(summary.product_cogs_coverage_pct_28 ?? 0);
    const after = summary.contribution_after_product_cogs_28 == null ? null : Number(summary.contribution_after_product_cogs_28);
    const missing = (cogsRows || []).filter(x => !x.configured);

    let answer, copy, tone;
    if (!complete) {
      answer = 'We cannot answer yet.';
      copy = `Amazon leaves ${money(amazon)} over the latest 28-day finance window, but product COGS is missing for ${missing.length || 'some'} shipped SKU${missing.length === 1 ? '' : 's'}. Add unit costs and this becomes a contribution-after-COGS read.`;
      tone = 'warn';
    } else if (after > 0) {
      answer = 'Positive after product COGS.';
      copy = `${money(after)} remains after Amazon-recorded operating events and configured product COGS. This is still before payroll, rent, freight-to-FBA and other off-Amazon overhead.`;
      tone = 'good';
    } else {
      answer = 'Negative after product COGS.';
      copy = `Configured product COGS takes the latest 28-day contribution to ${money(after)} before other off-Amazon overhead.`;
      tone = 'bad';
    }

    const cogsValue = complete ? money(knownCogs) : `${money(knownCogs)} known`;
    const afterValue = after == null ? 'Pending COGS' : money(after);
    const node = document.createElement('section');
    node.id = 'profitBridge';
    node.className = 'profit-bridge';
    node.innerHTML = `
      <div class="profit-answer">
        <div><div class="kicker">Are we making money?</div><div class="answer ${tone}">${answer}</div><div class="answer-copy">${copy}</div></div>
        <div class="cost-coverage">COGS coverage · ${coverage.toFixed(0)}% of shipped units</div>
      </div>
      <div class="bridge-row">
        <div class="bridge-step"><div class="bridge-label">Amazon-side contribution</div><div class="bridge-value ${amazon >= 0 ? 'good' : 'bad'}">${money(amazon)}</div><div class="bridge-note">After Amazon-recorded fees, ads, refunds and operating events.</div></div>
        <div class="bridge-step"><div class="bridge-label">Product COGS</div><div class="bridge-value"><span class="bridge-op">−</span>${cogsValue}</div><div class="bridge-note">Seller-owned unit costs applied to shipment-linked orders.</div></div>
        <div class="bridge-step"><div class="bridge-label">After product COGS</div><div class="bridge-value ${after == null ? '' : after >= 0 ? 'good' : 'bad'}">${afterValue}</div><div class="bridge-note">Contribution before other off-Amazon operating overhead.</div></div>
      </div>`;
    story.insertAdjacentElement('afterend', node);
  }

  fetch('/api/finance', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(data => {
      const s = data.summary || {};
      const h1 = document.querySelector('.page-head h1');
      const summary = document.querySelector('.page-summary');
      if (h1) h1.textContent = 'Are we making money?';
      if (summary) summary.textContent = 'Follow the money from Amazon contribution to product COGS. Only costs we can support are included; off-Amazon overhead remains separate.';
      const title = document.getElementById('storyTitle');
      const copy = document.getElementById('storyCopy');
      const caption = document.querySelector('.story-caption');
      const balance = Number(s.operating_ledger_balance_28 || 0);
      if (title) title.textContent = balance > 0 ? 'Amazon contribution is positive.' : 'Amazon contribution is negative.';
      if (copy) copy.textContent = balance > 0
        ? 'This is what remains after Amazon-recorded fees, advertising, refunds and other operating events in the latest 28-day finance window.'
        : 'Amazon-recorded operating events already take the latest 28-day finance window below zero.';
      if (caption) caption.textContent = `28 days${s.amazon_contribution_rate_28 == null ? '' : ` · ${pct(s.amazon_contribution_rate_28)} of shipment-event value`}`;
      addProfitBridge(s, data.cogs || []);
      window.setTimeout(() => redrawScale(data.daily || []), 450);
    })
    .catch(() => {});
})();
