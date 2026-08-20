/* Sales operating layout v3
   One analytical canvas + a temporal signal rail.
   The chart explores 12M monthly, 13W weekly and 28D daily without changing screens.
   The rail reads live -> MTD -> 7D -> 28D -> YTD, with Sales / Orders / Units kept visible.
   Legacy renderer nodes stay in the DOM until its async render completes; CSS hides them. */
(() => {
  'use strict';
  const d3=window.d3;
  if(!d3) return;

  const nf=new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
  const money=value=>'$'+nf.format(Math.round(Number(value||0)));
  const shortMoney=value=>{const n=Number(value||0),a=Math.abs(n);if(a>=1000)return `${n<0?'−':''}$${(a/1000).toFixed(a>=10000?0:1)}k`;return `${n<0?'−':''}$${Math.round(a)}`};
  const pct=value=>value==null?'—':`${Number(value)>0?'+':Number(value)<0?'−':''}${Math.abs(Number(value)).toFixed(0)}%`;
  const parse=value=>value?new Date(`${String(value).slice(0,10)}T12:00:00Z`):null;
  let DATA=null;
  let RANGE='12m';

  function metricToPanel(el,extraClass=''){
    if(!el)return null;
    const panel=document.createElement('div');
    panel.className=`sales-signal ${extraClass}`.trim();
    panel.dataset.window=el.dataset.insight||'';
    while(el.firstChild)panel.appendChild(el.firstChild);
    el.replaceWith(panel);
    return panel;
  }

  function ensureVolume(panel){
    if(!panel)return null;
    let volume=panel.querySelector('.sales-volume');
    if(!volume){
      volume=document.createElement('div');
      volume.className='sales-volume';
      const note=panel.querySelector('.metric-note');
      note?panel.insertBefore(volume,note):panel.appendChild(volume);
    }
    return volume;
  }
  function setVolume(panel,orders,units){
    const volume=ensureVolume(panel);if(!volume)return;
    volume.innerHTML=`<span><strong>${nf.format(Number(orders||0))}</strong> orders</span><span><strong>${nf.format(Number(units||0))}</strong> units</span>`;
  }
  function sum(rows,key){return d3.sum(rows||[],d=>Number(d[key]||0))}

  function buildLayout(){
    const overview=document.getElementById('overview');
    if(!overview||overview.dataset.operatingV3==='1')return;
    overview.dataset.operatingV3='1';
    document.body.classList.add('sales-operating-v2');

    // Keep legacy renderer targets alive. The stylesheet hides the old shell/story/context.
    document.querySelectorAll('.tabs button').forEach(btn=>{if(btn.dataset.view==='skus')btn.textContent='Products'});

    const metricGrid=overview.querySelector('.grid.four');
    const mtd=metricToPanel(metricGrid?.querySelector('[data-insight="mtd"]'),'primary');
    const ytd=metricToPanel(metricGrid?.querySelector('[data-insight="ytd"]'),'ytd');
    const t7=metricToPanel(metricGrid?.querySelector('[data-insight="t7"]'));
    const t28=metricToPanel(metricGrid?.querySelector('[data-insight="t28"]'));

    if(mtd){
      const run=document.createElement('div');
      run.className='sales-run-rate';
      run.innerHTML='<div><span>Momentum run rate</span><strong id="salesRunRate">—</strong></div><small>Directional<br>not a forecast</small>';
      mtd.appendChild(run);
    }

    const live=overview.querySelector('.live-strip');
    if(live){live.classList.add('sales-today-card');live.dataset.window='today'}

    const mainAside=overview.querySelector('.grid.main-aside');
    const chartCard=mainAside?.children?.[0]||null;
    if(chartCard){
      const head=chartCard.querySelector('.section-head');
      if(head&&!head.querySelector('.sales-range')){
        const range=document.createElement('div');
        range.className='sales-range';
        range.setAttribute('aria-label','Sales chart time window');
        range.innerHTML='<button class="active" data-range="12m">12M</button><button data-range="13w">13W</button><button data-range="28d">28D</button>';
        head.appendChild(range);
        range.addEventListener('click',event=>{
          const btn=event.target.closest('button[data-range]');if(!btn)return;
          RANGE=btn.dataset.range;
          range.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===btn));
          renderChart();
        });
      }
    }

    const grid=document.createElement('section');grid.className='sales-operating-grid';
    const main=document.createElement('div');main.className='sales-main';
    const rail=document.createElement('aside');rail.className='sales-signal-rail';rail.setAttribute('aria-label','Sales by operating window');
    if(chartCard)main.appendChild(chartCard);
    [live,mtd,t7,t28,ytd].forEach(node=>{if(node)rail.appendChild(node)});
    grid.append(main,rail);overview.prepend(grid);
  }

  function signalTip(host,tip,event,title,lines){
    const rect=host.getBoundingClientRect();
    const mark=event.currentTarget.getBoundingClientRect();
    const markX=mark.left+mark.width/2-rect.left;
    const preferRight=markX<rect.width/2;
    tip.innerHTML=`<strong>${title}</strong>${lines.map(([label,value])=>`<span class="tip-row"><em>${label}</em><b>${value}</b></span>`).join('')}`;
    tip.classList.add('sales-window-tip');
    tip.style.left=preferRight?`${Math.min(rect.width-12,mark.right-rect.left+12)}px`:`${Math.max(12,mark.left-rect.left-12)}px`;
    tip.style.top=`${Math.max(54,mark.top-rect.top+mark.height/2)}px`;
    tip.style.transform=preferRight?'translate(0,-50%)':'translate(-100%,-50%)';
    tip.style.maxWidth='220px';tip.style.minWidth='178px';
    tip.querySelectorAll('.tip-row').forEach(row=>{row.style.display='grid';row.style.gridTemplateColumns='48px minmax(0,1fr)';row.style.gap='10px';row.style.alignItems='baseline';const em=row.querySelector('em'),b=row.querySelector('b');if(em){em.style.fontStyle='normal';em.style.color='#aaa197';em.style.fontWeight='700'}if(b){b.style.color='#fffaf1';b.style.fontWeight='820'}});
    tip.classList.add('show');
  }

  function renderWindowBars(rows,{title,sub,signalWindow,signalLabel,periodLabel}){
    const svg=d3.select('#monthChart');if(svg.empty())return;
    svg.selectAll('*').remove();
    const node=svg.node(),host=node.parentElement;host.classList.add('dpp-chart-host');
    let tip=host.querySelector('.dpp-chart-tooltip');if(!tip){tip=document.createElement('div');tip.className='dpp-chart-tooltip';host.appendChild(tip)}
    const compact=window.innerWidth<=720;
    const width=Math.max(compact?520:760,Math.round(node.getBoundingClientRect().width||960));
    const height=Math.max(compact?250:330,Math.round(node.getBoundingClientRect().height||360));
    const m={top:26,right:compact?16:56,bottom:42,left:compact?54:64},innerW=width-m.left-m.right,innerH=height-m.top-m.bottom;
    svg.attr('viewBox',`0 0 ${width} ${height}`).attr('preserveAspectRatio','xMidYMid meet').classed('dpp-chart',true);
    const plot=svg.append('g').attr('transform',`translate(${m.left},${m.top})`);
    rows.forEach((d,i)=>{const history=rows.slice(Math.max(0,i-signalWindow+1),i+1);d.signal=history.length===signalWindow?d3.mean(history,x=>x.sales):null;d.prev=i?rows[i-1]:null});
    const x=d3.scaleBand().domain(rows.map(d=>d.key)).range([0,innerW]).padding(rows.length>20?.24:.28);
    const ymax=d3.max(rows,d=>Math.max(d.sales,d.signal||0))||1;
    const y=d3.scaleLinear().domain([0,ymax]).nice(4).range([innerH,0]);
    plot.append('g').attr('class','dpp-grid').call(d3.axisLeft(y).ticks(4).tickSize(-innerW).tickFormat(''));
    plot.append('g').attr('class','dpp-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(10).tickFormat(shortMoney)).call(g=>g.select('.domain').remove());

    const bars=plot.selectAll('.dpp-bar').data(rows).join('rect').attr('class','dpp-bar')
      .attr('x',d=>x(d.key)).attr('width',x.bandwidth()).attr('y',d=>y(d.sales)).attr('height',d=>Math.max(1,innerH-y(d.sales))).attr('rx',3)
      .attr('fill','#d8bd95').attr('opacity',.84);

    const signal=rows.filter(d=>d.signal!=null);
    if(signal.length>1){
      const line=d3.line().x(d=>x(d.key)+x.bandwidth()/2).y(d=>y(d.signal)).curve(d3.curveMonotoneX);
      plot.append('path').datum(signal).attr('d',line).attr('fill','none').attr('stroke','#f8f5ef').attr('stroke-width',7).attr('stroke-linecap','round');
      plot.append('path').datum(signal).attr('d',line).attr('fill','none').attr('stroke','#26231f').attr('stroke-width',3.2).attr('stroke-linecap','round');
      if(!compact){const last=signal[signal.length-1];plot.append('text').attr('x',x(last.key)+x.bandwidth()/2+8).attr('y',Math.max(12,y(last.signal)-9)).attr('class','dpp-muted').attr('font-weight',750).text(signalLabel)}
    }

    const step=Math.max(1,Math.ceil(rows.length/6));
    const ticks=rows.filter((d,i)=>i===0||i===rows.length-1||i%step===0).map(d=>d.key);
    plot.append('g').attr('class','dpp-axis').attr('transform',`translate(0,${innerH})`).call(d3.axisBottom(x).tickValues(ticks).tickSize(0).tickPadding(12).tickFormat(k=>rows.find(d=>d.key===k)?.axis||k)).call(g=>g.select('.domain').attr('stroke','#cfc5b7'));

    bars.attr('tabindex',0).on('pointerenter pointermove focus',function(event,d){
      const deltaPrev=d.prev&&d.prev.sales>0?100*(d.sales-d.prev.sales)/d.prev.sales:null;
      const deltaSignal=d.signal&&d.signal>0?100*(d.sales-d.signal)/d.signal:null;
      const lines=[['Sales',money(d.sales)]];
      if(deltaPrev!=null)lines.push([periodLabel,pct(deltaPrev)]);
      if(deltaSignal!=null)lines.push([signalLabel.replace(' avg',''),pct(deltaSignal)]);
      lines.push(['Volume',`${nf.format(d.orders)} orders · ${nf.format(d.units)} units`]);
      signalTip(host,tip,event,d.label,lines);
    }).on('pointerleave blur',()=>tip.classList.remove('show'));

    const head=host.querySelector('.section-head');
    const titleEl=head?.querySelector('.section-title'),subEl=head?.querySelector('.section-sub');
    if(titleEl)titleEl.textContent=title;if(subEl)subEl.textContent=sub;
  }

  function renderChart(){
    if(!DATA)return;
    const h=DATA.headline||{};
    if(RANGE==='12m'){
      const rows=(DATA.months||[]).map(r=>({...r,projected_sales:r.partial?Number(h.projected_month_sales||0):0}));
      const visible=window.innerWidth<=720?rows.slice(-6):rows;
      if(window.DPPCharts?.monthlySales)window.DPPCharts.monthlySales('#monthChart',visible);
      const host=document.getElementById('monthChart')?.parentElement;
      const title=host?.querySelector('.section-title'),sub=host?.querySelector('.section-sub');
      if(title)title.textContent='Monthly sales';if(sub)sub.textContent='12 months · current month actual + momentum run rate';
      return;
    }
    const daily=(DATA.series||[]).map(d=>({date:parse(d.business_date),sales:Number(d.sales||0),orders:Number(d.orders||0),units:Number(d.units||0)})).filter(d=>d.date).sort((a,b)=>d3.ascending(a.date,b.date));
    if(RANGE==='28d'){
      const rows=daily.slice(-28).map(d=>({key:d3.utcFormat('%Y-%m-%d')(d.date),axis:d3.utcFormat('%b %-d')(d.date),label:d3.utcFormat('%b %-d, %Y')(d.date),sales:d.sales,orders:d.orders,units:d.units}));
      renderWindowBars(rows,{title:'Daily sales',sub:'28 days · daily sales · 7-day average',signalWindow:7,signalLabel:'7D avg',periodLabel:'Prev'});
      return;
    }
    const weekly=d3.rollups(daily,v=>({sales:sum(v,'sales'),orders:sum(v,'orders'),units:sum(v,'units')}),d=>+d3.utcMonday.floor(d.date))
      .map(([key,v])=>({date:new Date(Number(key)),...v})).sort((a,b)=>d3.ascending(a.date,b.date)).slice(-13)
      .map(d=>({key:d3.utcFormat('%Y-%m-%d')(d.date),axis:d3.utcFormat('%b %-d')(d.date),label:`Week of ${d3.utcFormat('%b %-d')(d.date)}`,sales:d.sales,orders:d.orders,units:d.units}));
    renderWindowBars(weekly,{title:'Weekly sales',sub:'13 weeks · weekly sales · 4-week average',signalWindow:4,signalLabel:'4W avg',periodLabel:'LW'});
  }

  function renderRail(){
    if(!DATA)return;
    const h=DATA.headline||{},t=DATA.today||{},series=DATA.series||[];
    const panels={
      mtd:document.querySelector('.sales-signal[data-window="mtd"]'),
      t7:document.querySelector('.sales-signal[data-window="t7"]'),
      t28:document.querySelector('.sales-signal[data-window="t28"]'),
      ytd:document.querySelector('.sales-signal[data-window="ytd"]')
    };
    setVolume(panels.mtd,h.orders_mtd,h.units_mtd);
    setVolume(panels.t7,h.orders_t7,sum(series.slice(-7),'units'));
    setVolume(panels.t28,h.orders_t28,h.units_t28);
    setVolume(panels.ytd,h.orders_ytd,h.units_ytd);

    const notes={mtd:`${pct(h.delta_mtd_pct)} vs same days last month`,t7:`${pct(h.delta7_pct)} vs prior 7`,t28:`${pct(h.delta28_pct)} vs prior 28`,ytd:'Year to date'};
    Object.entries(panels).forEach(([key,panel])=>{const note=panel?.querySelector('.metric-note');if(note)note.textContent=notes[key]});
    const run=document.getElementById('salesRunRate');if(run)run.textContent=money(h.projected_month_sales);

    const live=document.querySelector('.sales-today-card');
    if(live){
      const meta=live.querySelector('.live-meta');
      if(meta)meta.innerHTML=`<strong>${nf.format(Number(t.orders_today||0))}</strong> orders <span>·</span> <strong>${nf.format(Number(t.units_today||0))}</strong> units`;
    }
  }

  function renderAll(){renderRail();renderChart()}
  function loadEnhanced(){
    fetch('/api/sales',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject(new Error(`HTTP ${r.status}`))).then(data=>{
      DATA=data;renderAll();setTimeout(renderAll,180);setTimeout(renderAll,420);
      let timer;window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(renderChart,140)},{passive:true});
    }).catch(()=>{});
  }
  function init(){buildLayout();loadEnhanced()}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
