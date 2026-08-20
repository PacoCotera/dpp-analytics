/* today-composition-v3
   One owner for Today composition: compact hero, canonical day control, measured-width rhythm,
   product-first evidence, and a disclosed order ledger. */
(() => {
  'use strict';
  if (!document.body.classList.contains('today-shell')) return;
  if (document.documentElement.classList.contains('wall-mode')) return;
  const d3 = window.d3;
  if (!d3) return;

  const style = document.createElement('style');
  style.textContent = `
    /* Do not stretch the primary sales object to the height of the state rail. */
    html:not(.wall-mode) .today-shell.today-operating-v2 .today-operating-stage{align-items:start!important}
    html:not(.wall-mode) .today-shell.today-operating-v2 .today-operating-main .hero-main{height:auto!important;min-height:0!important;padding:20px 24px 18px!important}
    html:not(.wall-mode) .today-shell.today-operating-v2 .today-operating-main .hero-sales{margin:14px 0 18px!important;font-size:clamp(72px,7vw,104px)!important}
    html:not(.wall-mode) .today-shell.today-operating-v2 .today-operating-main .hero-bottom{margin-top:0!important}

    /* The selector is part of the sales panel. Today is a return-to-live chip; seven closed days form the day grid. */
    html:not(.wall-mode) .today-shell .today-hero-head{display:grid!important;grid-template-columns:auto minmax(315px,390px)!important;align-items:start!important;gap:16px!important;width:100%!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-picker{display:grid!important;grid-template-columns:minmax(54px,auto) repeat(7,minmax(30px,1fr))!important;gap:4px!important;width:100%!important;max-width:390px!important;margin:0!important;padding:0!important;border:0!important;overflow:visible!important;justify-self:end!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice{display:grid!important;place-items:center!important;align-content:center!important;width:100%!important;min-width:0!important;height:38px!important;min-height:38px!important;aspect-ratio:auto!important;padding:2px 3px!important;border:1px solid var(--line)!important;border-radius:10px!important;background:rgba(248,244,237,.72)!important;box-shadow:none!important;overflow:hidden!important;text-align:center!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice.live{padding-inline:8px!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice b{font-size:11px!important;line-height:1!important;font-weight:800!important;letter-spacing:0!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice span{display:block!important;font-size:8px!important;line-height:1!important;margin-top:4px!important;color:var(--muted)!important;font-variant-numeric:tabular-nums}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice.live span{display:none!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice.active{background:var(--ink)!important;border-color:var(--ink)!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice.active b,html:not(.wall-mode) .today-shell .today-hero-head .day-choice.active span{color:#fff8ed!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice.live.active{background:var(--accent)!important;border-color:var(--accent)!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice.live.active b{color:#2b1804!important}
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice:not([data-canonical='1']) b,
    html:not(.wall-mode) .today-shell .today-hero-head .day-choice:not([data-canonical='1']) span{visibility:hidden!important}

    /* Stop the two old picker owners from showing a shell-level copy. */
    html:not(.wall-mode) .today-shell.today-showcase > .app > #dayPicker{display:none!important}

    /* Rhythm and products align to content, not to each other's tallest state. */
    html:not(.wall-mode) .today-shell.today-operating-v2 .content-grid{align-items:start!important;grid-template-columns:minmax(0,1.62fr) minmax(300px,.38fr)!important}
    html:not(.wall-mode) .today-shell.today-operating-v2 .content-grid>.panel:first-child{min-height:0!important;padding-bottom:0!important}
    html:not(.wall-mode) .today-shell.today-operating-v2 .rhythm-chart{height:auto!important;min-height:0!important}
    html:not(.wall-mode) .today-shell.today-operating-v2 .content-grid>.panel:last-child{min-height:0!important}

    /* Orders are technical evidence. Keep a compact summary closed by default. */
    html:not(.wall-mode) .today-shell .wins.today-orders-compact{padding:0!important;overflow:hidden!important}
    .today-orders-summary{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:14px;padding:14px 18px;cursor:pointer;user-select:none}
    .today-orders-summary strong{font-size:13px;font-weight:820}
    .today-orders-summary span{display:block;margin-top:2px;font-size:10.5px;color:var(--muted)}
    .today-orders-summary button{border:0;background:transparent;color:#7b4a0d;font:760 11px Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer;padding:7px 0}
    .today-orders-compact>.panel-head{display:none!important}
    .today-orders-compact>.order-stream{display:none!important;margin:0!important;padding:0 16px 16px!important}
    .today-orders-compact.is-open>.order-stream{display:grid!important}
    .today-orders-compact.is-open .today-orders-summary{border-bottom:1px solid var(--line)}

    @media(max-width:980px){
      html:not(.wall-mode) .today-shell .today-hero-head{grid-template-columns:1fr!important;gap:9px!important}
      html:not(.wall-mode) .today-shell .today-hero-head .day-picker{justify-self:start!important;max-width:390px!important}
      html:not(.wall-mode) .today-shell.today-operating-v2 .content-grid{grid-template-columns:1fr!important}
    }
    @media(max-width:560px){
      html:not(.wall-mode) .today-shell.today-operating-v2 .today-operating-main .hero-main{padding:17px 16px 16px!important}
      html:not(.wall-mode) .today-shell .today-hero-head .day-picker{grid-template-columns:52px repeat(7,minmax(27px,1fr))!important;gap:3px!important;max-width:none!important}
      html:not(.wall-mode) .today-shell .today-hero-head .day-choice{height:35px!important;min-height:35px!important;border-radius:9px!important}
      html:not(.wall-mode) .today-shell .today-hero-head .day-choice b{font-size:10px!important}
      html:not(.wall-mode) .today-shell .today-hero-head .day-choice span{font-size:7.5px!important;margin-top:3px!important}
      .today-orders-summary{padding:13px 15px}
    }
  `;
  document.head.appendChild(style);

  const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const money = v => '$' + nf.format(Math.round(Number(v || 0)));
  const shortMoney = v => {
    const n=Number(v||0),a=Math.abs(n);
    if(a>=1000000)return `${n<0?'−':''}$${(a/1000000).toFixed(a>=10000000?0:1)}m`;
    if(a>=1000)return `${n<0?'−':''}$${(a/1000).toFixed(a>=10000?0:1)}k`;
    return `${n<0?'−':''}$${Math.round(a)}`;
  };
  const parseDate = v => v ? new Date(`${String(v).slice(0,10)}T12:00:00Z`) : null;
  const weekday = d => ['S','M','T','W','T','F','S'][d.getUTCDay()];
  let DATA=null, rendering=false, resizeTimer=null;

  function ensureHeroPicker(){
    const hero=document.querySelector('.hero-main'), picker=document.getElementById('dayPicker'), eyebrow=document.getElementById('salesEyebrow');
    if(!hero||!picker||!eyebrow)return false;
    let head=hero.querySelector('.today-hero-head');
    if(!head){head=document.createElement('div');head.className='today-hero-head';hero.insertBefore(head,hero.firstChild);}
    if(eyebrow.parentElement!==head)head.prepend(eyebrow);
    if(picker.parentElement!==head)head.appendChild(picker);
    return true;
  }

  function canonicalPicker(){
    if(!ensureHeroPicker())return;
    const buttons=[...document.querySelectorAll('#dayPicker .day-choice')];
    buttons.forEach(btn=>{
      const d=parseDate(btn.dataset.date);if(!d)return;
      const label=btn.querySelector('b'), sub=btn.querySelector('span');
      if(label)label.textContent=btn.classList.contains('live')?'Today':weekday(d);
      if(sub)sub.textContent=String(d.getUTCDate());
      btn.dataset.canonical='1';
      const long=new Intl.DateTimeFormat('en-US',{weekday:'long',month:'short',day:'numeric',timeZone:'UTC'}).format(d);
      btn.title=long;btn.setAttribute('aria-label',`${long}${btn.classList.contains('live')?' · live':''}`);
    });
    const active=document.querySelector('#dayPicker .day-choice.active');
    document.body.dataset.dayMode=active?.classList.contains('live')?'live':'closed';
  }

  function selectedDate(){return document.querySelector('#dayPicker .day-choice.active')?.dataset.date||''}
  function activePeriod(){return document.querySelector('.periods .period.active')?.dataset.period||'30'}
  function selectedRows(){
    const rows=(DATA?.recent_daily||[]).map(r=>({...r,date:parseDate(r.business_date),sales:Number(r.sales||0),orders:Number(r.orders||0),units:Number(r.units||0)})).filter(r=>r.date);
    const p=activePeriod();
    if(p==='7')return rows.slice(-7);
    if(p==='mtd'){const target=String(DATA?.selected_date||selectedDate()||rows.at(-1)?.business_date||'').slice(0,7);return rows.filter(r=>String(r.business_date).slice(0,7)===target)}
    return rows.slice(-30);
  }

  function renderRhythm(){
    if(rendering||!DATA)return;
    const svg=d3.select('#rhythm'), rows=selectedRows();if(svg.empty()||!rows.length)return;
    rendering=true;
    const node=svg.node(), host=node.parentElement, rect=host.getBoundingClientRect();
    const width=Math.max(300,Math.round(rect.width));
    const compact=width<560, height=compact?210:width<850?202:194;
    const m={top:14,right:10,bottom:30,left:compact?46:52},iw=width-m.left-m.right,ih=height-m.top-m.bottom;
    svg.selectAll('*').remove();svg.attr('viewBox',`0 0 ${width} ${height}`).attr('preserveAspectRatio','xMidYMid meet').classed('dpp-chart',true);
    const g=svg.append('g').attr('transform',`translate(${m.left},${m.top})`),x=d3.scaleBand().domain(rows.map(r=>r.business_date)).range([0,iw]).padding(rows.length<=8?.2:.26),y=d3.scaleLinear().domain([0,d3.max(rows,r=>r.sales)||1]).nice(4).range([ih,0]);
    g.append('g').attr('class','dpp-grid').call(d3.axisLeft(y).ticks(4).tickSize(-iw).tickFormat(''));
    g.append('g').attr('class','dpp-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8).tickFormat(shortMoney)).call(a=>a.select('.domain').remove());
    const selected=String(DATA.selected_date||selectedDate()||'');
    const bars=g.selectAll('rect.today-rhythm-bar-v3').data(rows).join('rect').attr('class','dpp-bar today-rhythm-bar-v3').attr('x',r=>x(r.business_date)).attr('width',x.bandwidth()).attr('y',r=>y(r.sales)).attr('height',r=>Math.max(1,ih-y(r.sales))).attr('rx',Math.min(4,x.bandwidth()/4)).attr('fill',r=>{const dow=r.date.getUTCDay();if(r.business_date===selected)return '#e58b1f';return dow===0||dow===6?'#d8c09b':'#b78b4d'});
    const div=g.append('g').attr('pointer-events','none');
    rows.forEach((r,i)=>{if(i===0)return;const prev=rows[i-1],xx=x(r.business_date)-(x.step()-x.bandwidth())/2;if(r.date.getUTCMonth()!==prev.date.getUTCMonth())div.append('line').attr('x1',xx).attr('x2',xx).attr('y1',0).attr('y2',ih).attr('stroke','#e58b1f').attr('stroke-width',1.5).attr('opacity',.82);else if(r.date.getUTCDay()===1)div.append('line').attr('x1',xx).attr('x2',xx).attr('y1',0).attr('y2',ih).attr('stroke','#c9c0b4').attr('stroke-width',.8).attr('opacity',.48)});
    const target=rows.length<=8?rows.length:width<520?4:width<820?5:7,step=Math.max(1,Math.ceil(rows.length/target));
    const ticks=rows.filter((r,i)=>rows.length<=8||i===0||i===rows.length-1||i%step===0).map(r=>r.business_date);
    g.append('g').attr('class','dpp-axis').attr('transform',`translate(0,${ih})`).call(d3.axisBottom(x).tickValues(ticks).tickSize(0).tickPadding(9).tickFormat(k=>d3.utcFormat(rows.length<=8?'%a':'%-d')(parseDate(k)))).call(a=>a.select('.domain').attr('stroke','#cfc5b7'));
    rendering=false;
  }

  function compactOrders(){
    const panel=document.querySelector('.wins');if(!panel)return;
    panel.classList.add('today-orders-compact');
    let summary=panel.querySelector('.today-orders-summary');
    if(!summary){
      summary=document.createElement('div');summary.className='today-orders-summary';
      summary.innerHTML='<div><strong>Orders</strong><span id="todayOrdersSummary">Loading transactions…</span></div><button type="button">Show ledger ↓</button>';
      panel.prepend(summary);
      summary.addEventListener('click',()=>{panel.classList.toggle('is-open');const b=summary.querySelector('button');b.textContent=panel.classList.contains('is-open')?'Hide ledger ↑':'Show ledger ↓'});
    }
    const cards=[...panel.querySelectorAll('.order-transaction')];
    const target=document.getElementById('todayOrdersSummary');if(!target)return;
    if(!cards.length){target.textContent=document.body.dataset.dayMode==='live'?'No orders yet today.':'No transactions recorded for this day.';return;}
    let sales=0,units=0;
    cards.forEach(card=>{const amt=card.querySelector('.ot-amount')?.textContent||'';sales+=Number(amt.replace(/[^0-9.-]/g,''))||0;const meta=card.querySelector('.ot-meta')?.textContent||'';const m=meta.match(/(\d+)\s+units?/i);if(m)units+=Number(m[1])||0;});
    target.textContent=`${cards.length} transactions · ${units} units · ${money(sales)}`;
  }

  async function refreshData(){
    try{const d=selectedDate(),live=document.querySelector('#dayPicker .day-choice.live')?.dataset.date||'',q=d&&d!==live?`?date=${encodeURIComponent(d)}`:'';const r=await fetch('/api/today'+q,{cache:'no-store'});if(r.ok){DATA=await r.json();renderRhythm();}}catch(_){ }
  }

  function sync(){canonicalPicker();compactOrders();clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{refreshData();renderRhythm();},35)}
  function init(){
    canonicalPicker();compactOrders();refreshData();
    const picker=document.getElementById('dayPicker');if(picker)new MutationObserver(()=>queueMicrotask(sync)).observe(picker,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
    const stream=document.getElementById('stream');if(stream)new MutationObserver(()=>setTimeout(compactOrders,0)).observe(stream,{childList:true,subtree:true});
    document.querySelectorAll('.period').forEach(b=>b.addEventListener('click',()=>setTimeout(()=>{refreshData();renderRhythm()},45)));
    const host=document.getElementById('rhythm')?.parentElement;if(window.ResizeObserver&&host)new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(renderRhythm,70)}).observe(host);
    else window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(renderRhythm,90)},{passive:true});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
