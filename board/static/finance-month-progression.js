(() => {
  'use strict';
  const MARKER = 'finance-month-progression-v1';
  if (document.documentElement.dataset[MARKER]) return;
  document.documentElement.dataset[MARKER] = '1';

  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthName = s => {
    if (!s) return '—';
    const [y,m] = String(s).slice(0,7).split('-').map(Number);
    return `${months[m-1]} ${String(y).slice(-2)}`;
  };
  const money = v => {
    const n = Number(v || 0), a = Math.abs(n);
    if (a >= 1000) return `${n < 0 ? '−' : ''}$${(a / 1000).toFixed(a >= 10000 ? 0 : 1)}k`;
    return `${n < 0 ? '−' : ''}$${Math.round(a)}`;
  };
  const fullMoney = v => `${Number(v||0)<0?'−':''}$${new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(Math.abs(Math.round(Number(v||0))))}`;
  const pct = v => v == null ? '—' : `${Number(v).toFixed(1)}%`;

  const style = document.createElement('style');
  style.textContent = `
    .finance-progression{margin-top:24px;border-top:2px solid var(--ink);padding-top:13px}
    .finance-progression-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:12px}
    .finance-progression-title{font-size:20px;font-weight:830;letter-spacing:-.02em}
    .finance-progression-sub{font-size:11px;color:var(--muted);line-height:1.45;margin-top:3px;max-width:720px}
    .finance-progression-scale{font-size:10px;color:var(--muted);text-align:right;white-space:nowrap}
    .finance-progression-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
    .finance-mini{border:1px solid var(--line);border-radius:14px;background:rgba(255,253,249,.62);padding:11px 10px 9px;min-width:0}
    .finance-mini-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:5px}
    .finance-mini-month{font-size:13px;font-weight:840}.finance-mini-margin{font-size:10px;font-weight:800;color:var(--muted)}
    .finance-mini svg{display:block;width:100%;height:auto;overflow:visible}
    .finance-mini-labels{display:grid;grid-template-columns:repeat(5,1fr);gap:2px;margin-top:3px;font-size:8px;color:var(--muted);text-align:center;line-height:1.15}
    .finance-mini-foot{display:flex;justify-content:space-between;gap:8px;margin-top:7px;padding-top:7px;border-top:1px solid var(--line);font-size:10px;color:var(--muted)}
    .finance-mini-foot strong{font-size:12px;color:var(--ink)}
    @media(max-width:980px){.finance-progression-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:640px){.finance-progression-head{display:block}.finance-progression-scale{text-align:left;margin-top:5px}.finance-progression-grid{grid-template-columns:1fr}.finance-mini{padding:12px}.finance-mini-labels{font-size:9px}}
  `;
  document.head.appendChild(style);

  function series(row){
    const sales = Number(row.net_sales_ex_vat || 0);
    const amazon = Number(row.amazon_order_effect || 0);
    const ads = Number(row.advertising || 0);
    const cogs = -Math.abs(Number(row.product_cogs || 0));
    const contribution = Number(row.contribution_after_product_cogs || 0);
    let running = sales;
    return [
      {name:'Sales', value:sales, start:0, end:sales, kind:'sales'},
      {name:'Amazon', value:amazon, start:running, end:(running += amazon), kind:'change'},
      {name:'Ads', value:ads, start:running, end:(running += ads), kind:'change'},
      {name:'COGS', value:cogs, start:running, end:(running += cogs), kind:'change'},
      {name:'Contribution', value:contribution, start:0, end:contribution, kind:'total'}
    ];
  }

  function renderMini(host,row,domain){
    const data = series(row);
    const W = 250, H = 152, L = 5, R = 5, T = 20, B = 7, innerH = H-T-B;
    const lo = domain[0], hi = domain[1], span = Math.max(1,hi-lo);
    const y = v => T + (hi-v)/span*innerH;
    const zero = y(0), barW = 34, gap = 12;
    const totalW = data.length*barW + (data.length-1)*gap;
    const x0 = (W-totalW)/2;
    const line = getComputedStyle(document.documentElement).getPropertyValue('--line').trim() || '#ddd5c9';
    const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#26231f';
    const good = getComputedStyle(document.documentElement).getPropertyValue('--good').trim() || '#2f7d4f';
    const bad = getComputedStyle(document.documentElement).getPropertyValue('--bad').trim() || '#c94b43';
    const salesColor = '#b78b4d';
    const parts = [`<line x1="0" y1="${zero}" x2="${W}" y2="${zero}" stroke="${ink}" stroke-width="1" opacity=".6"/>`];
    const ticks = [hi,0,lo].filter((v,i,a)=>a.indexOf(v)===i);
    ticks.forEach(v=>{const yy=y(v);parts.push(`<line x1="0" y1="${yy}" x2="${W}" y2="${yy}" stroke="${line}" stroke-width="1" opacity=".7"/><text x="2" y="${yy-3}" font-size="8" fill="#746c62">${money(v)}</text>`)});
    data.forEach((d,i)=>{
      const x=x0+i*(barW+gap), top=y(Math.max(d.start,d.end)), bottom=y(Math.min(d.start,d.end)), h=Math.max(2,bottom-top);
      const fill=d.kind==='sales'?salesColor:d.kind==='total'?(d.value>=0?good:bad):(d.value>=0?good:bad);
      if(i>0 && i<4){const prev=data[i-1], yy=y(prev.end);parts.push(`<line x1="${x-gap}" y1="${yy}" x2="${x}" y2="${yy}" stroke="${line}" stroke-width="1.2"/>`)}
      parts.push(`<rect x="${x}" y="${top}" width="${barW}" height="${h}" rx="3" fill="${fill}"><title>${d.name}: ${fullMoney(d.value)}</title></rect>`);
      const labelY=d.value>=0?top-5:bottom+11;
      parts.push(`<text x="${x+barW/2}" y="${labelY}" text-anchor="middle" font-size="8.5" font-weight="700" fill="${ink}">${money(d.value)}</text>`);
    });
    host.innerHTML = `<div class="finance-mini-head"><div class="finance-mini-month">${monthName(row.month)}</div><div class="finance-mini-margin">Margin ${pct(row.contribution_margin_pct)}</div></div><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${monthName(row.month)} contribution waterfall">${parts.join('')}</svg><div class="finance-mini-labels"><span>Sales</span><span>Amazon</span><span>Ads</span><span>COGS</span><span>Keep</span></div><div class="finance-mini-foot"><span>Contribution</span><strong>${fullMoney(row.contribution_after_product_cogs)}</strong></div>`;
  }

  function progression(rows){
    const ordered=(rows||[]).slice().filter(r=>r.month).sort((a,b)=>String(a.month).localeCompare(String(b.month)));
    if(!ordered.length) return null;
    const all=ordered.flatMap(r=>series(r).flatMap(d=>[d.start,d.end]));
    let lo=Math.min(0,...all), hi=Math.max(0,...all);
    const pad=Math.max(500,(hi-lo)*.10); lo-=pad; hi+=pad;
    const section=document.createElement('section');section.className='finance-progression';section.dataset.financeProgression='1';
    section.innerHTML=`<div class="finance-progression-head"><div><div class="finance-progression-title">Month-by-month contribution progression</div><div class="finance-progression-sub">Every closed month uses the same vertical scale and the same accounting bridge: sales → Amazon order deductions → advertising → product cost → contribution. That makes direction visible instead of hiding it inside a YTD total.</div></div><div class="finance-progression-scale">Shared scale<br>${money(lo)} to ${money(hi)}</div></div><div class="finance-progression-grid"></div>`;
    const grid=section.querySelector('.finance-progression-grid');
    ordered.forEach(r=>{const card=document.createElement('article');card.className='finance-mini';grid.appendChild(card);renderMini(card,r,[lo,hi]);});
    return section;
  }

  async function mount(){
    try{
      const r=await fetch('/api/finance',{cache:'no-store'});if(!r.ok)return;
      const d=await r.json();
      const cash=document.getElementById('cashView');if(!cash)return;
      cash.querySelector('[data-finance-progression]')?.remove();
      const section=progression(d.closed_months||[]);if(!section)return;
      const summary=cash.querySelector('.closed-summary');
      if(summary) summary.insertAdjacentElement('afterend',section);
      else cash.prepend(section);
    }catch(e){console.error('finance progression',e)}
  }
  setTimeout(mount,250);setTimeout(mount,1500);
})();
