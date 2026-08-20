(() => {
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = value => {
    const n = Number(value || 0);
    return (n < 0 ? '−$' : '$') + fmt.format(Math.abs(Math.round(n)));
  };
  const absMoney = value => '$' + fmt.format(Math.abs(Math.round(Number(value || 0))));
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const style = document.createElement('style');
  style.textContent = `
    /* Finance manager statement: topline -> deductions -> contribution -> cash. */
    #overview .balance-story,#overview .grid.four,#overview .manager-key{display:none!important}
    .finance-statement{margin-top:12px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:4px 0 0}
    .fs-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding:14px 2px 16px}
    .fs-head h2{font-size:clamp(27px,3vw,40px);letter-spacing:-.045em;line-height:1;margin:4px 0 7px}
    .fs-sub{font-size:13px;color:var(--muted);line-height:1.45}
    .fs-source{text-align:right;font-size:11px;color:var(--muted);max-width:330px;line-height:1.4}
    .fs-grid{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(310px,.65fr);gap:26px;border-top:1px solid var(--line);padding:18px 0}
    .fs-lines{min-width:0}
    .fs-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:baseline;padding:8px 2px;border-top:1px solid #e9e2d8}
    .fs-line:first-child{border-top:0}
    .fs-label{font-size:14px;color:#514b44}.fs-label small{display:block;color:var(--muted);font-size:11px;margin-top:2px;line-height:1.35}
    .fs-amount{font-size:18px;font-weight:790;font-variant-numeric:tabular-nums;white-space:nowrap}
    .fs-line.major{padding:11px 2px}.fs-line.major .fs-label{font-weight:820;color:var(--ink);font-size:15px}.fs-line.major .fs-amount{font-size:25px;letter-spacing:-.03em}
    .fs-line.result{border-top:2px solid #bdb3a5;margin-top:5px;padding-top:13px}.fs-line.result .fs-label{font-weight:840;color:var(--ink)}.fs-line.result .fs-amount{font-size:28px;letter-spacing:-.04em}
    .fs-neg{color:var(--bad)}.fs-pos{color:var(--good)}.fs-neutral{color:var(--ink)}
    .fs-side{border-left:1px solid var(--line);padding-left:24px;display:flex;flex-direction:column;justify-content:space-between;gap:18px}
    .fs-side-block{padding-bottom:16px;border-bottom:1px solid var(--line)}.fs-side-block:last-child{border-bottom:0;padding-bottom:0}
    .fs-side-label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;font-weight:820;color:var(--muted)}
    .fs-side-value{font-size:34px;font-weight:850;letter-spacing:-.05em;line-height:1;margin-top:6px}
    .fs-side-note{font-size:12px;color:var(--muted);line-height:1.4;margin-top:6px}
    .fs-answer{font-size:19px;font-weight:820;line-height:1.15;margin-top:5px}
    #overview .section.grid.main-aside{margin-top:18px}
    #overview .section.grid.main-aside .section-sub{max-width:620px}
    @media(max-width:760px){
      .fs-head{display:block}.fs-source{text-align:left;margin-top:8px}
      .fs-grid{grid-template-columns:1fr;gap:14px;padding-top:12px}
      .fs-side{border-left:0;border-top:1px solid var(--line);padding:16px 0 0;display:grid;grid-template-columns:1fr 1fr;gap:14px}
      .fs-side-block{border-bottom:0;padding:0}.fs-side-value{font-size:29px}
      .fs-line{padding:9px 0}.fs-label{font-size:14px}.fs-amount{font-size:17px}
      .fs-line.major .fs-amount{font-size:23px}.fs-line.result .fs-amount{font-size:25px}
    }
    @media(max-width:430px){.fs-side{grid-template-columns:1fr}.fs-side-block+ .fs-side-block{border-top:1px solid var(--line);padding-top:13px}}
  `;
  document.head.appendChild(style);

  function row(label, value, opts={}) {
    const n = Number(value || 0);
    const cls = opts.tone || (n < 0 ? 'fs-neg' : opts.positive ? 'fs-pos' : 'fs-neutral');
    const amount = opts.forceMinus && n > 0 ? `−${absMoney(n)}` : money(n);
    return `<div class="fs-line ${opts.major?'major':''} ${opts.result?'result':''}"><div class="fs-label">${esc(label)}${opts.note?`<small>${esc(opts.note)}</small>`:''}</div><div class="fs-amount ${cls}">${amount}</div></div>`;
  }

  function buildStatement(st) {
    const existing = document.getElementById('financeStatement');
    if (existing) existing.remove();
    const tabs = document.querySelector('.view-tabs');
    if (!tabs) return;

    const period = `${String(st.period_start || '').slice(5)} to ${String(st.through_date || '').slice(5)}`;
    const cogsComplete = !!st.cogs_complete;
    const after = st.after_product_cogs == null ? null : Number(st.after_product_cogs);
    const taxCollected = Number(st.tax_collected || 0);
    const taxWithheld = Number(st.tax_withheld || 0);
    const deductions = [
      ['Promotions', st.promotions, 'Discounts/promotions funded through Amazon'],
      ['Refunds', st.refunds, 'Customer refunds posted in the period'],
      ['Selling fees', st.selling_fees, 'Referral/commission-type charges'],
      ['FBA fees', st.fba_fees, 'Fulfillment-related Amazon charges'],
      ['Other Amazon fees', st.other_amazon_fees, 'Other Amazon operating charges'],
      ['Advertising', st.advertising, 'Amazon advertising charges posted in Finance'],
      ['Tax withheld/remitted', taxWithheld, 'Tax amounts withheld/remitted by Amazon'],
      ['Adjustments', st.adjustments, 'Reimbursements and ledger adjustments, net'],
    ];

    let answer = 'COGS incomplete';
    let answerTone = 'warn';
    if (after != null) {
      answer = after >= 0 ? 'Positive after product COGS' : 'Negative after product COGS';
      answerTone = after >= 0 ? 'fs-pos' : 'fs-neg';
    }

    const node = document.createElement('section');
    node.id = 'financeStatement';
    node.className = 'finance-statement';
    node.innerHTML = `
      <div class="fs-head">
        <div><div class="kicker">Management statement · MTD</div><h2>Where the sales went.</h2><div class="fs-sub">${esc(period)} · ${Number(st.orders || 0)} orders · ${Number(st.units || 0)} units</div></div>
        <div class="fs-source">${esc(st.source_note || '')}</div>
      </div>
      <div class="fs-grid">
        <div class="fs-lines">
          ${row('Product sales', st.sales, {major:true,positive:true,note:'Marketplace sales topline'})}
          ${row('Tax collected from customers', taxCollected, {note:'Shown separately; not operating revenue'})}
          ${deductions.map(([l,v,n]) => row(l,v,{note:n,forceMinus:Number(v)>0})).join('')}
          ${row('Amazon operating contribution', st.amazon_operating_net, {major:true,result:true,tone:Number(st.amazon_operating_net)>=0?'fs-pos':'fs-neg',note:'After Amazon-posted operating events; before product COGS'})}
          ${row('Product COGS', st.product_cogs, {forceMinus:true,note:`Seller-owned unit costs · ${Number(st.cogs_coverage_pct || 0).toFixed(0)}% coverage`})}
          ${after == null ? `<div class="fs-line result"><div class="fs-label">Contribution after product COGS<small>Complete COGS required</small></div><div class="fs-amount">Pending</div></div>` : row('Contribution after product COGS', after, {result:true,tone:after>=0?'fs-pos':'fs-neg',note:'Before payroll, rent, freight-to-FBA and other off-Amazon overhead'})}
        </div>
        <aside class="fs-side">
          <div class="fs-side-block"><div class="fs-side-label">Cash transferred by Amazon · MTD</div><div class="fs-side-value">${money(st.cash_transferred)}</div><div class="fs-side-note">Actual Transfer events posted in the finance ledger. Timing will not equal the P&amp;L period exactly.</div></div>
          <div class="fs-side-block"><div class="fs-side-label">Operating read</div><div class="fs-answer ${answerTone}">${answer}</div><div class="fs-side-note">${cogsComplete ? 'Product cost coverage is complete for shipment-linked units in this period.' : `Product COGS coverage is ${Number(st.cogs_coverage_pct || 0).toFixed(0)}%; do not treat the result as complete.`}</div></div>
        </aside>
      </div>`;
    tabs.insertAdjacentElement('afterend', node);
  }

  fetch('/api/finance', { cache:'no-store' })
    .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
    .then(data => {
      const h1 = document.querySelector('.page-head h1');
      const summary = document.querySelector('.page-summary');
      if (h1) h1.textContent = 'Finance';
      if (summary) summary.textContent = 'Sales, taxes, Amazon charges, product cost and cash. Start with the statement; drill into drivers or raw events only when something needs explaining.';
      buildStatement(data.statement || {});
    })
    .catch(() => {});
})();
