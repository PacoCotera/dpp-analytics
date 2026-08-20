/* Today showcase v1: business pulse + Sales-grade rhythm + compact day toggle. */
(() => {
  'use strict';
  if(!document.body.classList.contains('today-shell'))return;
  document.body.classList.add('today-showcase');
  const d3=window.d3;if(!d3)return;
  const money=v=>'$'+new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(Math.round(Number(v||0)));
  const shortMoney=v=>{const n=Number(v||0),a=Math.abs(n);if(a>=1000)return `${n<0?'−':''}$${(a/1000).toFixed(a>=10000?0:1)}k`;return `${n<0?'−':''}$${Math.round(a)}`};
  const pct=v=>v==null?'—':`${Number(v)>0?'+':Number(v)<0?'−':''}${Math.abs(Number(v)).toFixed(1)}%`;
  const parseDate=s=>s?new Date(`${String(s).slice(0,10)}T12:00:00Z`):null;
  const sum=(rows,key)=>d3.sum(rows||[],r=>Number(r[key]||0));
  let TODAY=null, INVENTORY=null, timer=null;

  function activeDate(){return document.querySelector('#dayPicker .day-choice.active')?.dataset.date||''}
  function period(){return document.querySelector('.periods .period.active')?.dataset.period||'30'}

  function compactPicker(){
    [...document.querySelectorAll('#dayPicker .day-choice')].forEach(btn=>{
      const d=parseDate(btn.dataset.date);if(!d)return;
      const letter=d3.utcFormat('%a')(d).slice(0,1);
      const label=btn.querySelector('b');if(label)label.textContent=letter;
      const sub=btn.querySelector('span');if(sub)sub.textContent='';
      btn.title=`${d3.utcFormat('%A, %b %-d')(d)}${btn.classList.contains('live')?' · live':''}`;
      btn.setAttribute('aria-label',btn.title);
    });
  }

  function restructureRail(){
    const rail=document.querySelector('.today-state-rail');if(!rail)return;
    if(!rail.querySelector('.today-pulse-title')){const t=document.createElement('div');t.className='today-pulse-title';t.textContent='Business pulse';rail.prepend(t)}
    let grid=rail.querySelector('.today-kpi-grid');
    if(!grid){grid=document.createElement('div');grid.className='today-kpi-grid';const rows=[...rail.querySelectorAll('.today-state-row')];const title=rail.querySelector('.today-pulse-title');title.after(grid);rows.forEach(r=>grid.appendChild(r));}
    const latest=rail.querySelector('.latest');if(latest){const lbl=latest.querySelector('.eyebrow');if(lbl)lbl.textContent='Latest sale';rail.appendChild(latest)}
    if(!rail.querySelector('.today-inventory-strip')){const inv=document.createElement('div');inv.className='today-inventory-strip';inv.innerHTML='<div class="today-inventory-read"><div class="label">FBA available</div><strong id="todayInvAvailable">—</strong><small id="todayInvCover">inventory loading</small></div><div class="today-inventory-read" id="todayInvAttention"><div class="label">Restock</div><strong id="todayInvActions">—</strong><small id="todayInvActionNote">action loading</small></div>';grid.after(inv)}
  }

  function renderInventory(){const s=INVENTORY?.summary||{};const a=document.getElementById('todayInvAvailable'),c=document.getElementById('todayInvCover'),r=document.getElementById('todayInvActions'),n=document.getElementById('todayInvActionNote'),box=document.getElementById('todayInvAttention');if(a)a.textContent=new Intl.NumberFormat('en-US').format(Number(s.available||0));if(c)c.textContent=s.portfolio_days_cover!=null?`${Number(s.portfolio_days_cover).toFixed(1)} days portfolio cover`:'portfolio cover unavailable';if(r)r.textContent=String(Number(s.needs_action||0));if(n)n.textContent=Number(s.stockouts||0)>0?`${s.stockouts} stockout · ${s.produce||0} produce`:`${s.produce||0} produce · ${s.plan||0} plan`;if(box)box.classList.toggle('attention',Number(s.needs_action||0)>0)}

  function selectedRows(){const rows=(TODAY?.recent_daily||[]).map(r=>({...r,date:parseDate(r.business_date),sales:Number(r.sales||0),orders:Number(r.orders||0),units:Number(r.units||0)})).filter(r=>r.date);const p=period();if(p==='7')return rows.slice(-7);if(p==='mtd'){const target=String(TODAY?.selected_date||rows.at(-1)?.business_date||'').slice(0,7);return rows.filter(r=>String(r.business_date).slice(0,7)===target)}return rows.slice(-30)}

  function ensureRhythmRail(){const panel=document.querySelector('.content-grid>.panel:first-child');if(!panel)return null;let rail=panel.querySelector('.today-rhythm-kpi-rail');if(!rail){rail=document.createElement('div');rail.className='today-rhythm-kpi-rail';panel.appendChild(rail)}return rail}
  function renderRhythmRail(rows){const rail=ensureRhythmRail();if(!rail)return;const sales=sum(rows,'sales'),orders=sum(rows,'orders'),units=sum(rows,'units'),days=Math.max(1,rows.length),pace=sales/days;let bench=null,note='';const p=period(),all=(TODAY?.recent_daily||[]);if(p==='7'&&all.length>=14){const prior=sum(all.slice(-14,-7),'sales');if(prior>0)bench=100*(sales-prior)/prior;note='vs prior 7D'}else if(p==='mtd'){bench=TODAY?.context?.mtd_delta_pct;note='vs same days last month'}else{bench=TODAY?.context?.last30_delta_pct;note='vs prior 30D'}const cls=bench>0?'good':bench<0?'bad':'';rail.innerHTML=`<div class="today-rhythm-kpi"><div class="label">Sales</div><strong>${money(sales)}</strong><small>${p==='mtd'?'month to date':p==='7'?'last 7 days':'last 30 days'}</small></div><div class="today-rhythm-kpi"><div class="label">Orders · units</div><strong>${orders} · ${units}</strong><small>volume in period</small></div><div class="today-rhythm-kpi"><div class="label">Daily pace</div><strong>${money(pace)}</strong><small>average per day</small></div><div class="today-rhythm-kpi"><div class="label">Benchmark</div><strong class="${cls}">${bench==null?'—':pct(bench)}</strong><small>${note||'comparison unavailable'}</small></div>`}

  function drawRhythm(){
    if(!TODAY)return;const rows=selectedRows();const svg=d3.select('#rhythm');if(svg.empty()||!rows.length)return;
    svg.selectAll('*').remove();const compact=window.innerWidth<=640,width=compact?520:960,height=278,m={top:18,right:compact?12:24,bottom:38,left:compact?48:58},iw=width-m.left-m.right,ih=height-m.top-m.bottom;
    svg.attr('viewBox',`0 0 ${width} ${height}`).attr('preserveAspectRatio','xMidYMid meet').classed('dpp-chart',true);
    const g=svg.append('g').attr('transform',`translate(${m.left},${m.top})`),x=d3.scaleBand().domain(rows.map(r=>r.business_date)).range([0,iw]).padding(.22),y=d3.scaleLinear().domain([0,d3.max(rows,r=>r.sales)||1]).nice(4).range([ih,0]);
    g.append('g').attr('class','dpp-grid').call(d3.axisLeft(y).ticks(4).tickSize(-iw).tickFormat(''));
    g.append('g').attr('class','dpp-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(9).tickFormat(shortMoney)).call(a=>a.select('.domain').remove());
    const selected=String(TODAY.selected_date||''),live=!!TODAY.is_live;
    const bars=g.selectAll('rect.today-rhythm-bar').data(rows).join('rect').attr('class','dpp-bar today-rhythm-bar').attr('x',r=>x(r.business_date)).attr('width',x.bandwidth()).attr('y',r=>y(r.sales)).attr('height',r=>Math.max(1,ih-y(r.sales))).attr('rx',3.5).attr('fill',r=>{const dow=r.date.getUTCDay();if(r.business_date===selected)return '#e58b1f';if(dow===0||dow===6)return '#d8c09b';return '#b78b4d'}).attr('opacity',r=>r.business_date===selected&&live?1:.94);
    const layer=g.append('g').attr('pointer-events','none');
    rows.forEach((r,i)=>{if(i===0)return;const prev=rows[i-1];if(r.date.getUTCMonth()!==prev.date.getUTCMonth()){const xx=x(r.business_date)-(x.step()-x.bandwidth())/2;layer.append('line').attr('x1',xx).attr('x2',xx).attr('y1',0).attr('y2',ih).attr('stroke','#e58b1f').attr('stroke-width',3).attr('opacity',1)}else if(r.date.getUTCDay()===1){const xx=x(r.business_date)-(x.step()-x.bandwidth())/2;layer.append('line').attr('x1',xx).attr('x2',xx).attr('y1',0).attr('y2',ih).attr('stroke','#c9c0b4').attr('stroke-width',1).attr('stroke-dasharray','3 4').attr('opacity',.7)}});
    const tickValues=rows.filter((r,i)=>rows.length<=8||i===0||i===rows.length-1||r.date.getUTCDay()===1).map(r=>r.business_date);
    g.append('g').attr('class','dpp-axis').attr('transform',`translate(0,${ih})`).call(d3.axisBottom(x).tickValues(tickValues).tickSize(0).tickPadding(10).tickFormat(k=>d3.utcFormat(rows.length<=8?'%a':'%-d')(parseDate(k)))).call(a=>a.select('.domain').attr('stroke','#cfc5b7'));
    const host=svg.node().parentElement;let tip=host.querySelector('.today-rhythm-tip');if(!tip){tip=document.createElement('div');tip.className='dpp-chart-tooltip home-week-tooltip today-rhythm-tip';host.appendChild(tip)}
    bars.attr('tabindex',0).on('pointerenter pointermove focus',function(ev,r){tip.innerHTML=`<strong>${d3.utcFormat('%a, %b %-d')(r.date)}</strong><span class="home-tip-row"><span class="home-tip-label">Sales</span><span class="home-tip-value">${money(r.sales)}</span></span><span class="home-tip-footer">${r.orders} orders · ${r.units} units${r.business_date===selected?' · selected':''}</span>`;const hr=host.getBoundingClientRect(),br=this.getBoundingClientRect();tip.style.left=`${Math.min(hr.width-100,Math.max(100,br.left-hr.left+br.width/2))}px`;tip.style.top=`${Math.max(64,br.top-hr.top+10)}px`;tip.classList.add('show')}).on('pointerleave blur',()=>tip.classList.remove('show'));
    renderRhythmRail(rows);
    const sub=document.getElementById('rhythmSub');if(sub){const p=period();sub.textContent=p==='7'?'Daily sales · last 7 days':p==='mtd'?'Daily sales · month to selected day':'Daily sales · last 30 days'}
  }

  async function refreshData(){
    try{const q=activeDate()&&activeDate()!==document.querySelector('#dayPicker .day-choice.live')?.dataset.date?`?date=${encodeURIComponent(activeDate())}`:'';const [t,i]=await Promise.all([fetch('/api/today'+q,{cache:'no-store'}).then(r=>r.ok?r.json():null),fetch('/api/inventory',{cache:'no-store'}).then(r=>r.ok?r.json():null)]);if(t)TODAY=t;if(i)INVENTORY=i;compactPicker();restructureRail();renderInventory();drawRhythm()}catch(_){ }
  }

  function schedule(){clearTimeout(timer);timer=setTimeout(refreshData,80)}
  const picker=document.getElementById('dayPicker');if(picker)new MutationObserver(schedule).observe(picker,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
  const rhythm=document.getElementById('rhythm');if(rhythm)new MutationObserver(()=>{if(TODAY)schedule()}).observe(rhythm,{childList:true});
  document.querySelectorAll('.period').forEach(b=>b.addEventListener('click',()=>setTimeout(drawRhythm,30)));
  window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(drawRhythm,160)},{passive:true});
  setTimeout(refreshData,180);setInterval(()=>{if(document.hidden)return;refreshData()},60000);
})();
