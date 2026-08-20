(() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = v => {
    if (v === null || v === undefined) return '—';
    const n=Number(v); return `${n<0?'−':''}$${new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(Math.abs(Math.round(n)))}`;
  };
  const monthName = s => {
    if(!s) return '—';
    const [y,m]=String(s).slice(0,7).split('-').map(Number);
    return new Intl.DateTimeFormat('en-US',{month:'short',year:'2-digit'}).format(new Date(Date.UTC(y,m-1,1)));
  };
  const cls = v => Number(v||0)<0?'neg':Number(v||0)>0?'pos':'';

  const css=document.createElement('style');
  css.textContent=`
  .fmv2{margin-top:4px}.fmv2-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-end;padding:10px 2px 12px;border-bottom:2px solid var(--ink)}
  .fmv2-head h2{margin:2px 0 0;font-size:29px;letter-spacing:-.04em}.fmv2-basis{text-align:right;font-size:12px;color:var(--muted);line-height:1.45}.fmv2-basis strong{display:block;color:var(--ink);font-size:13px}
  .money-bridge{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid var(--line)}.money-cell{padding:16px 18px 15px 0;min-width:0}.money-cell+.money-cell{border-left:1px solid var(--line);padding-left:18px}.money-label{font-size:10px;text-transform:uppercase;letter-spacing:.1em;font-weight:850;color:var(--muted)}.money-value{font-size:34px;font-weight:870;letter-spacing:-.05em;margin-top:5px}.money-note{font-size:11px;color:var(--muted);line-height:1.4;margin-top:5px}.money-value.pos{color:var(--good)}.money-value.neg{color:var(--bad)}
  .finance-columns{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(260px,.45fr);gap:22px;margin-top:18px}.statement-list{border-top:1px solid var(--line)}.statement-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:11px 0;border-bottom:1px solid var(--line);align-items:start}.statement-line.total{border-top:2px solid var(--ink);border-bottom:2px solid var(--ink);padding:14px 0}.statement-line .name{font-size:14px;font-weight:760}.statement-line .note{font-size:11px;color:var(--muted);line-height:1.35;margin-top:2px}.statement-line .val{font-size:18px;font-weight:830;white-space:nowrap}.statement-line.total .name,.statement-line.total .val{font-size:21px}
  .finance-note{padding:14px 15px;border-radius:16px;background:#efe9df;font-size:12px;line-height:1.5;color:#554e46}.finance-note strong{color:var(--ink)}.finance-note+.finance-note{margin-top:10px}
  .monthly-section{margin-top:30px}.monthly-head{display:flex;justify-content:space-between;gap:14px;align-items:end;margin-bottom:9px}.monthly-head h3{font-size:21px;margin:0}.monthly-head p{font-size:12px;color:var(--muted);margin:2px 0 0}.monthly-grid{border-top:2px solid var(--ink)}.monthly-row{display:grid;grid-template-columns:90px 1.05fr .8fr .85fr .9fr .9fr .95fr .95fr;gap:12px;align-items:center;padding:11px 4px;border-bottom:1px solid var(--line)}.monthly-row.header{padding:8px 4px;font-size:9px;text-transform:uppercase;letter-spacing:.08em;font-weight:850;color:var(--muted)}.monthly-row:not(.header):hover{background:rgba(255,255,255,.42)}.m-month{font-weight:830}.m-month small{display:block;font-size:9px;color:var(--accent-ink);text-transform:uppercase;letter-spacing:.06em}.m-num{text-align:right;font-variant-numeric:tabular-nums}.m-num strong{font-size:14px}.m-num span{display:block;font-size:9px;color:var(--muted);margin-top:2px}.m-num.neg strong{color:var(--bad)}.m-num.pos strong{color:var(--good)}
  .cash-months{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.cash-month{border-top:2px solid var(--ink);padding:13px 2px}.cash-month .month{font-size:11px;font-weight:830}.cash-month .transfer{font-size:31px;font-weight:870;letter-spacing:-.05em;margin:5px 0}.cash-month .meta{font-size:11px;color:var(--muted);line-height:1.4}.cash-month .ads{color:var(--bad);font-weight:760}
  .released-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.released-item{display:flex;justify-content:space-between;gap:12px;padding:11px 12px;border-radius:12px;background:#f7f3ec}.released-item strong{font-size:13px}.released-item span{font-size:13px;font-variant-numeric:tabular-nums}.ledger-warning{font-size:12px;color:var(--muted);line-height:1.5;margin:4px 0 14px;max-width:900px}
  @media(max-width:980px){.finance-columns{grid-template-columns:1fr}.monthly-row{grid-template-columns:72px repeat(7,minmax(86px,1fr));font-size:11px}.cash-months{grid-template-columns:1fr 1fr}}
  @media(max-width:640px){.fmv2-head{display:block}.fmv2-basis{text-align:left;margin-top:5px}.fmv2-head h2{font-size:26px}.money-bridge{grid-template-columns:1fr 1fr}.money-cell{padding:13px 10px 13px 0}.money-cell+.money-cell{padding-left:10px}.money-cell:nth-child(3){grid-column:1/-1;border-left:0;border-top:1px solid var(--line);padding-left:0}.money-value{font-size:28px}.finance-columns{margin-top:14px}.monthly-grid{display:grid;gap:9px;border-top:0}.monthly-row.header{display:none}.monthly-row{display:grid;grid-template-columns:1fr 1fr;gap:9px 14px;border:1px solid var(--line);border-radius:16px;padding:13px 14px;background:rgba(255,253,249,.7)}.m-month{grid-column:1/-1;font-size:16px;padding-bottom:5px;border-bottom:1px solid var(--line)}.m-num{text-align:left}.m-num:before{content:attr(data-label);display:block;font-size:9px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);font-weight:820;margin-bottom:2px}.cash-months,.released-list{grid-template-columns:1fr}.statement-line .name{font-size:15px}.statement-line .note{font-size:12px}}
  `;
  document.head.appendChild(css);

  function renderStatement(d){
    const s=d.statement||{}, months=d.monthly||[];
    const view=document.getElementById('statementView'); if(!view)return;
    const start=String(s.period_start||'').slice(0,10), end=String(s.through_date||'').slice(0,10);
    const fees=s.settled_amazon_fees;
    view.innerHTML=`<div class="fmv2">
      <section class="fmv2-head"><div><div class="kicker">Current month</div><h2>Sales → deductions → contribution</h2></div><div class="fmv2-basis"><strong>${esc(start)} → ${esc(end)}</strong>Sales ex IVA · finance events RELEASED only</div></section>
      <section class="money-bridge">
        <div class="money-cell"><div class="money-label">Net product sales · ex IVA</div><div class="money-value">${money(s.net_sales_ex_vat ?? s.sales)}</div><div class="money-note">The operating sales number used elsewhere in DPP.</div></div>
        <div class="money-cell"><div class="money-label">IVA on those sales · ${(100*Number(s.vat_rate??.16)).toFixed(0)}%</div><div class="money-value">${money(s.iva_on_sales ?? s.tax_collected)}</div><div class="money-note">Included in the shopper price, not revenue we keep.</div></div>
        <div class="money-cell"><div class="money-label">Shopper product spend · incl IVA</div><div class="money-value">${money(s.shopper_product_spend)}</div><div class="money-note">Net sales + IVA. Example: $240 + 16% = $278.40.</div></div>
      </section>
      <div class="finance-columns"><section>
        <div class="statement-list">
          <div class="statement-line"><div><div class="name">Advertising posted by Amazon</div><div class="note">Cash/accounting posting date. This is intentionally not spread across days.</div></div><div class="val ${cls(s.advertising)}">${money(s.advertising)}</div></div>
          <div class="statement-line"><div><div class="name">Amazon fees from closed settlements</div><div class="note">Referral, FBA and other identifiable settlement fees. Current open month may not have a closed settlement yet.</div></div><div class="val ${cls(fees)}">${fees==null?'Awaiting settlement':money(fees)}</div></div>
          <div class="statement-line"><div><div class="name">Refunds posted</div><div class="note">Released Amazon refund transactions.</div></div><div class="val ${cls(s.refunds)}">${money(s.refunds)}</div></div>
          <div class="statement-line"><div><div class="name">Other adjustments / service fees</div><div class="note">Released accounting adjustments outside the lines above.</div></div><div class="val ${cls(Number(s.adjustments||0)+Number(s.service_fees||0))}">${money(Number(s.adjustments||0)+Number(s.service_fees||0))}</div></div>
          <div class="statement-line"><div><div class="name">Amazon operating net · released ledger</div><div class="note">Amazon-side accounting result on its posting clock; do not force it to equal sales for the same calendar dates.</div></div><div class="val ${cls(s.amazon_operating_net)}">${money(s.amazon_operating_net)}</div></div>
          <div class="statement-line"><div><div class="name">Product COGS</div><div class="note">${Number(s.cogs_coverage_pct||0).toFixed(0)}% unit-cost coverage.</div></div><div class="val neg">${money(-Math.abs(Number(s.product_cogs||0)))}</div></div>
          <div class="statement-line total"><div><div class="name">Contribution after product COGS</div><div class="note">Before payroll, rent, freight-to-FBA and other off-Amazon overhead.</div></div><div class="val ${cls(s.after_product_cogs)}">${s.after_product_cogs==null?'Incomplete COGS':money(s.after_product_cogs)}</div></div>
        </div>
      </section><aside>
        <div class="finance-note"><strong>Two clocks, deliberately.</strong><br>Sales are recognized on the business-sales date. Advertising, fees and transfers hit Amazon's finance ledger when Amazon posts/releases them. Monthly history is therefore more useful than forcing MTD lines to reconcile day-for-day.</div>
        <div class="finance-note accounting-note"><strong>Cash transferred this month</strong><br><span style="font-size:30px;font-weight:870;letter-spacing:-.04em;color:var(--ink)">${money(s.cash_transferred)}</span><br>Actual released Transfer events, not estimated profit.</div>
      </aside></div>
      ${monthlyTable(months)}
    </div>`;
  }

  function monthlyTable(months){
    const rows=(months||[]).slice(-10).reverse();
    return `<section class="monthly-section"><div class="monthly-head"><div><h3>Monthly money flow</h3><p>Newest first · current month marked MTD · advertising stays on the month Amazon posts it.</p></div></div><div class="monthly-grid">
      <div class="monthly-row header"><div>Month</div><div class="m-num">Net sales</div><div class="m-num">IVA</div><div class="m-num">Ads posted</div><div class="m-num">Settled fees</div><div class="m-num">Amazon net</div><div class="m-num">COGS</div><div class="m-num">Cash transfer</div></div>
      ${rows.map(m=>`<div class="monthly-row"><div class="m-month">${monthName(m.month)}${m.partial?'<small>MTD</small>':''}</div>
        <div class="m-num" data-label="Net sales"><strong>${money(m.net_sales_ex_vat)}</strong><span>gross ${money(m.shopper_product_spend)}</span></div>
        <div class="m-num" data-label="IVA"><strong>${money(m.iva_on_sales)}</strong><span>${(100*Number(m.vat_rate||.16)).toFixed(0)}%</span></div>
        <div class="m-num ${cls(m.advertising)}" data-label="Ads posted"><strong>${money(m.advertising)}</strong><span>posting month</span></div>
        <div class="m-num ${cls(m.settled_amazon_fees)}" data-label="Settled fees"><strong>${m.settled_amazon_fees==null?'—':money(m.settled_amazon_fees)}</strong><span>${m.settlement_lines?'closed settlement':'not closed'}</span></div>
        <div class="m-num ${cls(m.amazon_operating_net)}" data-label="Amazon net"><strong>${money(m.amazon_operating_net)}</strong><span>released ledger</span></div>
        <div class="m-num neg" data-label="COGS"><strong>${money(-Math.abs(Number(m.product_cogs||0)))}</strong><span>${Number(m.cogs_coverage_pct||0).toFixed(0)}% covered</span></div>
        <div class="m-num ${cls(m.cash_transferred)}" data-label="Cash transfer"><strong>${money(m.cash_transferred)}</strong><span>actual payout</span></div>
      </div>`).join('')}
    </div></section>`;
  }

  function renderCash(d){
    const view=document.getElementById('cashView'); if(!view)return;
    const rows=(d.monthly||[]).slice(-9).reverse();
    view.innerHTML=`<section class="fmv2"><div class="fmv2-head"><div><div class="kicker">Cash flow</div><h2>What Amazon actually moved.</h2></div><div class="fmv2-basis">Monthly view<br>RELEASED events only</div></div>
      <div class="cash-months">${rows.map(m=>`<article class="cash-month"><div class="month">${monthName(m.month)}${m.partial?' · MTD':''}</div><div class="transfer ${cls(m.cash_transferred)}">${money(m.cash_transferred)}</div><div class="meta">Amazon transfers<br><span class="ads">Ads posted ${money(m.advertising)}</span><br>Released operating net ${money(m.amazon_operating_net)}</div></article>`).join('')}</div>
      <div class="finance-note" style="margin-top:18px"><strong>Why this view is monthly.</strong> Advertising charges and Amazon payouts are lumpy settlement events. A daily or current-month-only view hides the cash pattern rather than explaining it.</div>
    </section>`;
  }

  function renderDetail(d){
    const view=document.getElementById('detailView'); if(!view)return;
    const types=d.types||[], recent=d.recent||[];
    view.innerHTML=`<section class="fmv2"><div class="fmv2-head"><div><div class="kicker">Audit trail</div><h2>Released finance events</h2></div><div class="fmv2-basis">Raw accounting evidence<br>not the management topline</div></div>
      <p class="ledger-warning">The previous ProductCharges/Base/Tax card grid has been removed. Those were raw recursive Amazon leaf labels and, because DEFERRED and RELEASED states were being summed together, they could double-count the same economics. This view now starts from released transaction classes and individual events.</p>
      <div class="released-list">${types.map(t=>`<div class="released-item"><strong>${esc(t.transaction_type)}</strong><span class="${cls(t.amount)}">${money(t.amount)} · ${Number(t.transactions||0)} events</span></div>`).join('')}</div>
      <section class="monthly-section"><div class="monthly-head"><div><h3>Recent Amazon events</h3><p>Newest first. Deferred events remain visible here as status evidence but are excluded from finance totals.</p></div></div><div class="list">${recent.map(r=>`<div class="list-row"><div><div class="row-title">${esc(r.transaction_type)} · ${esc(r.transaction_status)}</div><div class="row-sub">${esc(r.local_time)} · ${esc(r.description||'')}</div></div><div class="row-value"><strong class="${cls(r.amount)}">${money(r.amount)}</strong></div></div>`).join('')}</div></section>
    </section>`;
  }

  async function renderV2(){
    try{
      const r=await fetch('/api/finance',{cache:'no-store'}); if(!r.ok) return;
      const d=await r.json();
      document.querySelector('.page-head h1')?.replaceChildren(document.createTextNode('Finance, month by month.'));
      const ps=document.querySelector('.page-summary'); if(ps) ps.textContent='Net sales, IVA, Amazon charges, product cost and actual cash transfers. Current month is useful only when read beside the monthly flow.';
      const asof=document.getElementById('asof'); if(asof) asof.textContent='Finance posted through '+String(d.summary?.latest_posted||d.statement?.through_date||'').slice(0,10);
      renderStatement(d); renderCash(d); renderDetail(d);
      document.body.dataset.financeManagerV2='1';
    }catch(_){ }
  }
  setTimeout(renderV2,120);
  setTimeout(renderV2,1200);
})();
