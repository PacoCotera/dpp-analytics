/* Sales operating layout v5
   Primary canvas + signal rail.
   One chart grammar across 12M monthly, 90D weekly and 28D daily.
   Short windows keep benchmark math in hover instead of weak visible trendlines. */
(() => {
  'use strict';

  const d3=window.d3;
  if(!d3)return;

  const nf=new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
  const money=value=>'$'+nf.format(Math.round(Number(value||0)));
  const shortMoney=value=>{
    const n=Number(value||0),a=Math.abs(n);
    if(a>=1e6)return `${n<0?'−':''}$${(a/1e6).toFixed(a>=1e7?0:1)}m`;
    if(a>=1e3)return `${n<0?'−':''}$${(a/1e3).toFixed(a>=1e4?0:1)}k`;
    return `${n<0?'−':''}$${Math.round(a)}`;
  };
  const pct=value=>value==null?'—':`${Number(value)>0?'+':Number(value)<0?'−':''}${Math.abs(Number(value)).toFixed(0)}%`;
  const parseDate=value=>value?new Date(`${String(value).slice(0,10)}T12:00:00Z`):null;
  const esc=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const HISTORICAL_BAR='#b78b4d';
  const CURRENT_BAR='#e58b1f';
  const PAPER='#f8f5ef';

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
    volume.innerHTML=`<strong>${nf.format(Number(orders||0))}</strong> orders · <strong>${nf.format(Number(units||0))}</strong> units`;
  }

  function sum(rows,key){return d3.sum(rows||[],d=>Number(d[key]||0));}

  function buildLayout(){
    const overview=document.getElementById('overview');
    if(!overview||overview.dataset.operatingV5==='1')return;
    overview.dataset.operatingV5='1';
    document.body.classList.add('sales-operating-v2');

    document.querySelectorAll('.tabs button').forEach(btn=>{if(btn.dataset.view==='skus')btn.textContent='Products';});

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
    if(live){live.classList.add('sales-today-card');live.dataset.window='today';}

    const mainAside=overview.querySelector('.grid.main-aside');
    const chartCard=mainAside?.children?.[0]||null;
    if(chartCard){
      const title=chartCard.querySelector('.section-title');
      const sub=chartCard.querySelector('.section-sub');
      if(title){title.id='salesChartTitle';title.textContent='Monthly sales';}
      if(sub){sub.id='salesChartSub';sub.textContent='12 months · current month actual + momentum run rate';}
      const head=chartCard.querySelector('.section-head');
      if(head&&!head.querySelector('.sales-range')){
        const range=document.createElement('div');
        range.className='sales-range';
        range.setAttribute('role','group');
        range.setAttribute('aria-label','Sales chart time window');
        range.innerHTML='<button class="active" type="button" data-range="12m" aria-pressed="true">12M</button><button type="button" data-range="90d" aria-pressed="false">90D</button><button type="button" data-range="28d" aria-pressed="false">28D</button>';
        head.appendChild(range);
        range.addEventListener('click',event=>{
          const button=event.target.closest('button[data-range]');
          if(!button||button.dataset.range===RANGE)return;
          RANGE=button.dataset.range;
          range.querySelectorAll('button').forEach(b=>{
            const active=b===button;
            b.classList.toggle('active',active);
            b.setAttribute('aria-pressed',active?'true':'false');
          });
          renderChart();
        });
      }
    }

    const grid=document.createElement('section');grid.className='sales-operating-grid';
    const main=document.createElement('div');main.className='sales-main';
    const rail=document.createElement('aside');rail.className='sales-signal-rail';rail.setAttribute('aria-label','Current sales signals');
    if(chartCard)main.appendChild(chartCard);
    [mtd,t7,t28,live,ytd].forEach(node=>{if(node)rail.appendChild(node);});
    grid.append(main,rail);overview.prepend(grid);
  }

  function ensureTip(host){
    host.classList.add('dpp-chart-host');
    let tip=host.querySelector('.dpp-chart-tooltip.sales-period-tooltip');
    if(!tip){
      host.querySelectorAll('.dpp-chart-tooltip').forEach(node=>node.remove());
      tip=document.createElement('div');
      tip.className='dpp-chart-tooltip home-week-tooltip sales-period-tooltip';
      tip.setAttribute('role','status');
      host.appendChild(tip);
    }
    return tip;
  }

  function showTip(host,tip,target,title,rows,footer){
    const hostRect=host.getBoundingClientRect(),targetRect=target.getBoundingClientRect();
    tip.innerHTML=`<strong>${esc(title)}</strong>${rows.map(row=>`<span class="home-tip-row"><span class="home-tip-label">${esc(row.label)}</span><span class="home-tip-value">${esc(row.value)}</span></span>`).join('')}${footer?`<span class="home-tip-footer">${esc(footer)}</span>`:''}`;
    tip.style.visibility='hidden';tip.classList.add('show');
    const tipW=tip.offsetWidth||190,tipH=tip.offsetHeight||120;
    const targetCenter=targetRect.left-hostRect.left+targetRect.width/2;
    const placeRight=targetCenter<hostRect.width/2,gap=12;
    let left;
    if(placeRight){
      left=Math.min(targetRect.right-hostRect.left+gap,hostRect.width-tipW-8);
      tip.style.transform='translate(0,-50%)';
    }else{
      left=Math.max(targetRect.left-hostRect.left-gap,tipW+8);
      tip.style.transform='translate(-100%,-50%)';
    }
    const desiredY=targetRect.top-hostRect.top+Math.max(18,targetRect.height*.42);
    const y=Math.max(tipH/2+8,Math.min(hostRect.height-tipH/2-8,desiredY));
    tip.style.left=`${left}px`;tip.style.top=`${y}px`;tip.style.visibility='visible';
  }
  function hideTip(tip){tip.classList.remove('show');}

  function shell(label,top=28){
    const svg=d3.select('#monthChart');if(svg.empty())return null;
    svg.selectAll('*').remove();
    const node=svg.node(),host=node.parentElement,tip=ensureTip(host);
    const compact=window.innerWidth<=720;
    const width=compact?520:960,height=340;
    const m={top,right:compact?14:58,bottom:44,left:compact?54:62};
    svg.classed('dpp-chart',true).attr('viewBox',`0 0 ${width} ${height}`).attr('preserveAspectRatio','xMidYMid meet').attr('role','img').attr('aria-label',label);
    return {svg,node,host,tip,width,height,m,innerW:width-m.left-m.right,innerH:height-m.top-m.bottom,plot:svg.append('g').attr('transform',`translate(${m.left},${m.top})`),compact};
  }

  function drawGrid(ctx,y){
    ctx.plot.append('g').attr('class','dpp-grid').call(d3.axisLeft(y).ticks(4).tickSize(-ctx.innerW).tickFormat(''));
    ctx.plot.append('g').attr('class','dpp-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(10).tickFormat(shortMoney)).call(g=>g.select('.domain').remove());
  }

  function setChartCopy(title,sub){
    const t=document.getElementById('salesChartTitle'),s=document.getElementById('salesChartSub');
    if(t)t.textContent=title;if(s)s.textContent=sub;
  }

  function bottomBandAxis(ctx,x,values,formatter){
    ctx.plot.append('g').attr('class','dpp-axis').attr('transform',`translate(0,${ctx.innerH})`)
      .call(d3.axisBottom(x).tickValues(values).tickSize(0).tickPadding(12).tickFormat(formatter))
      .call(g=>g.select('.domain').attr('stroke','#cfc5b7'));
  }

  function drawMonthly(rows){
    const data=(rows||[]).map(row=>({
      ...row,
      key:String(row.month||'').slice(0,7),
      date:parseDate(`${String(row.month||'').slice(0,7)}-01`),
      value:Number(row.sales||0),
      orders:Number(row.orders||0),
      units:Number(row.units||0),
      projected:row.partial?Number(DATA?.headline?.projected_month_sales||0):0
    })).filter(d=>d.key&&d.date).sort((a,b)=>d3.ascending(a.key,b.key));
    if(!data.length)return;

    setChartCopy('Monthly sales','12 months · current month actual + momentum run rate');
    const ctx=shell('Twelve months of monthly sales with current-month momentum run rate',38);if(!ctx)return;
    const x=d3.scaleBand().domain(data.map(d=>d.key)).range([0,ctx.innerW]).padding(.30);
    const y=d3.scaleLinear().domain([0,d3.max(data,d=>Math.max(d.value,d.projected||0))||1]).nice(4).range([ctx.innerH,0]);
    drawGrid(ctx,y);

    const patternId='sales-run-rate-v5';
    const pattern=ctx.svg.append('defs').append('pattern').attr('id',patternId).attr('width',7).attr('height',7).attr('patternUnits','userSpaceOnUse').attr('patternTransform','rotate(45)');
    pattern.append('rect').attr('width',7).attr('height',7).attr('fill','#f3dfc4').attr('opacity',.62);
    pattern.append('line').attr('x1',0).attr('y1',0).attr('x2',0).attr('y2',7).attr('stroke',CURRENT_BAR).attr('stroke-width',2).attr('opacity',.6);

    const bars=ctx.plot.selectAll('.dpp-bar.sales-month').data(data).join('rect')
      .attr('class','dpp-bar sales-month').attr('x',d=>x(d.key)).attr('width',x.bandwidth())
      .attr('y',d=>y(d.value)).attr('height',d=>Math.max(1,ctx.innerH-y(d.value)))
      .attr('rx',4).attr('fill',d=>d.partial?CURRENT_BAR:HISTORICAL_BAR);

    const projected=data.filter(d=>d.partial&&d.projected>d.value);
    const ghosts=ctx.plot.selectAll('.dpp-ghost-bar').data(projected).join('rect')
      .attr('class','dpp-bar dpp-ghost-bar').attr('x',d=>x(d.key)).attr('width',x.bandwidth())
      .attr('y',d=>y(d.projected)).attr('height',d=>Math.max(1,y(d.value)-y(d.projected)))
      .attr('rx',4).attr('fill',`url(#${patternId})`).attr('stroke',CURRENT_BAR).attr('stroke-width',1.25);

    if(!ctx.compact&&data.length<=12){
      ctx.plot.selectAll('.dpp-value.sales-month-value').data(data).join('text').attr('class','dpp-value sales-month-value')
        .attr('x',d=>x(d.key)+x.bandwidth()/2).attr('y',d=>y(d.value)-8).attr('text-anchor','middle')
        .text(d=>d.partial&&d.projected>d.value?`Actual ${shortMoney(d.value)}`:shortMoney(d.value));
      ctx.plot.selectAll('.dpp-projection-value').data(projected).join('text').attr('class','dpp-value dpp-projection-value')
        .attr('x',d=>x(d.key)+x.bandwidth()/2).attr('y',d=>y(d.projected)-9).attr('text-anchor','middle').text(d=>`Run rate ${shortMoney(d.projected)}`);
    }

    bottomBandAxis(ctx,x,data.map(d=>d.key),key=>d3.utcFormat('%b')(parseDate(`${key}-01`)));

    if(projected.length){
      const legend=ctx.plot.append('g').attr('class','dpp-legend').attr('transform','translate(0,-25)');
      const actual=legend.append('g');
      actual.append('rect').attr('width',10).attr('height',10).attr('rx',2).attr('fill',CURRENT_BAR);
      actual.append('text').attr('x',16).attr('y',9).text('Current actual');
      const run=legend.append('g').attr('transform','translate(112,0)');
      run.append('rect').attr('width',10).attr('height',10).attr('rx',2).attr('fill',`url(#${patternId})`).attr('stroke',CURRENT_BAR);
      run.append('text').attr('x',16).attr('y',9).text('Momentum run rate');
    }

    bars.attr('tabindex',0).on('pointerenter pointermove focus',function(event,d){
      const rows=[{label:'Sales',value:money(d.value)}];
      if(d.partial)rows.push({label:'MTD',value:'partial'});
      showTip(ctx.host,ctx.tip,this,d3.utcFormat('%B %Y')(d.date),rows,`${nf.format(d.orders)} orders · ${nf.format(d.units)} units`);
    }).on('pointerleave blur',()=>hideTip(ctx.tip));

    ghosts.attr('tabindex',0).on('pointerenter pointermove focus',function(event,d){
      showTip(ctx.host,ctx.tip,this,d3.utcFormat('%B %Y')(d.date),[
        {label:'Actual',value:money(d.value)},
        {label:'Run rate',value:money(d.projected)}
      ],'Directional · not a forecast');
    }).on('pointerleave blur',()=>hideTip(ctx.tip));
  }

  function drawWeekly(rows){
    const daily=(rows||[]).map(row=>({date:parseDate(row.business_date),value:Number(row.sales||0),orders:Number(row.orders||0),units:Number(row.units||0)})).filter(d=>d.date).sort((a,b)=>d3.ascending(a.date,b.date));
    const grouped=d3.rollups(daily,v=>({value:d3.sum(v,x=>x.value),orders:d3.sum(v,x=>x.orders),units:d3.sum(v,x=>x.units),days:v.length}),d=>+d3.utcMonday.floor(d.date))
      .map(([k,v])=>({week:new Date(Number(k)),...v})).sort((a,b)=>d3.ascending(a.week,b.week)).slice(-13);
    grouped.forEach((d,i)=>{
      d.complete=d.days>=7;
      const priorComplete=grouped.slice(0,i).filter(x=>x.complete).slice(-4);
      d.benchmark=d.complete&&priorComplete.length===4?d3.mean(priorComplete,x=>x.value):null;
      d.previous=i>0?grouped[i-1]:null;
    });
    const current=grouped[grouped.length-1];
    setChartCopy('Weekly sales',`90 days · weekly sales${current&&!current.complete?' · current week partial':''}`);
    const ctx=shell('Ninety days of weekly sales');if(!ctx)return;
    const x=d3.scaleBand().domain(grouped.map(d=>+d.week)).range([0,ctx.innerW]).padding(.30);
    const y=d3.scaleLinear().domain([0,d3.max(grouped,d=>d.value)||1]).nice(4).range([ctx.innerH,0]);
    drawGrid(ctx,y);

    const bars=ctx.plot.selectAll('.dpp-bar').data(grouped).join('rect').attr('class','dpp-bar')
      .attr('x',d=>x(+d.week)).attr('width',x.bandwidth()).attr('y',d=>y(d.value)).attr('height',d=>Math.max(1,ctx.innerH-y(d.value)))
      .attr('rx',4).attr('fill',d=>d===current&&!d.complete?CURRENT_BAR:HISTORICAL_BAR);

    if(current&&!current.complete){
      ctx.plot.append('text').attr('x',x(+current.week)+x.bandwidth()/2).attr('y',Math.max(12,y(current.value)-8)).attr('text-anchor','middle').attr('fill',CURRENT_BAR).attr('font-size',10).attr('font-weight',800).text('WTD');
    }

    const ticks=grouped.filter((d,i)=>i===0||i===grouped.length-1||i%3===0).map(d=>+d.week);
    bottomBandAxis(ctx,x,ticks,v=>d3.utcFormat('%b %-d')(new Date(Number(v))));

    bars.attr('tabindex',0).on('pointerenter pointermove focus',function(event,d){
      const tipRows=[{label:'Sales',value:money(d.value)}];
      if(d.complete){
        if(d.previous?.complete&&d.previous.value>0)tipRows.push({label:'LW',value:pct(100*(d.value-d.previous.value)/d.previous.value)});
        if(d.benchmark>0)tipRows.push({label:'4W',value:pct(100*(d.value-d.benchmark)/d.benchmark)});
      }else if(d===current)tipRows.push({label:'WTD',value:'partial'});
      showTip(ctx.host,ctx.tip,this,`Week of ${d3.utcFormat('%b %-d')(d.week)}`,tipRows,`${nf.format(d.orders)} orders · ${nf.format(d.units)} units`);
    }).on('pointerleave blur',()=>hideTip(ctx.tip));
  }

  function drawMonthBoundary(ctx,x,data){
    if(data.length<2)return;
    const last=data[data.length-1].date;
    const monthStart=d3.utcMonth.floor(last);
    if(+data[0].date>=+monthStart)return;
    const firstCurrent=data.find(d=>+d.date>=+monthStart);
    if(!firstCurrent)return;

    const divider=x(+firstCurrent.date)-(x.step()-x.bandwidth())/2;
    ctx.plot.append('line').attr('x1',divider).attr('x2',divider).attr('y1',0).attr('y2',ctx.innerH)
      .attr('stroke','#aaa197').attr('stroke-width',1).attr('stroke-dasharray','3 4').attr('opacity',.88);

    const currentLabel=d3.utcFormat('%b')(monthStart).toUpperCase();
    ctx.plot.append('text').attr('x',divider+7).attr('y',11).attr('class','dpp-muted').attr('font-size',9).attr('font-weight',820).attr('letter-spacing','.06em').text(currentLabel);

    const priorStart=d3.utcMonth.offset(monthStart,-1);
    const priorKey=d3.utcFormat('%Y-%m')(priorStart);
    const closed=(DATA?.months||[]).find(row=>String(row.month||'').slice(0,7)===priorKey&&!row.partial);
    if(closed){
      const priorMonth=d3.utcFormat('%b')(priorStart).toUpperCase();
      const label=ctx.compact?`${priorMonth} · ${shortMoney(closed.sales)}`:`${priorMonth} CLOSED · ${shortMoney(closed.sales)}`;
      ctx.plot.append('text').attr('x',divider-7).attr('y',11).attr('text-anchor','end').attr('class','dpp-muted').attr('font-size',9).attr('font-weight',760).attr('letter-spacing','.035em').text(label);
    }
  }

  function drawDaily(rows){
    const data=(rows||[]).slice(-28).map(row=>({date:parseDate(row.business_date),value:Number(row.sales||0),orders:Number(row.orders||0),units:Number(row.units||0)})).filter(d=>d.date).sort((a,b)=>d3.ascending(a.date,b.date));
    data.forEach((d,i)=>{d.benchmark=i>=7?d3.mean(data.slice(i-7,i),x=>x.value):null;d.previous=i>0?data[i-1]:null;});
    setChartCopy('Daily sales','28 days · daily sales · month boundary marked');
    const ctx=shell('Twenty-eight days of daily sales with month boundary');if(!ctx)return;
    const x=d3.scaleBand().domain(data.map(d=>+d.date)).range([0,ctx.innerW]).padding(.30);
    const y=d3.scaleLinear().domain([0,d3.max(data,d=>d.value)||1]).nice(4).range([ctx.innerH,0]);
    drawGrid(ctx,y);

    const bars=ctx.plot.selectAll('.dpp-bar').data(data).join('rect').attr('class','dpp-bar')
      .attr('x',d=>x(+d.date)).attr('width',x.bandwidth()).attr('y',d=>y(d.value)).attr('height',d=>Math.max(1,ctx.innerH-y(d.value)))
      .attr('rx',4).attr('fill',HISTORICAL_BAR);

    drawMonthBoundary(ctx,x,data);

    const ticks=data.filter((d,i)=>i===0||i===data.length-1||i%7===0).map(d=>+d.date);
    bottomBandAxis(ctx,x,ticks,v=>d3.utcFormat('%b %-d')(new Date(Number(v))));

    bars.attr('tabindex',0).on('pointerenter pointermove focus',function(event,d){
      const tipRows=[{label:'Sales',value:money(d.value)}];
      if(d.previous?.value>0)tipRows.push({label:'PD',value:pct(100*(d.value-d.previous.value)/d.previous.value)});
      if(d.benchmark>0)tipRows.push({label:'7D',value:pct(100*(d.value-d.benchmark)/d.benchmark)});
      showTip(ctx.host,ctx.tip,this,d3.utcFormat('%a, %b %-d')(d.date),tipRows,`${nf.format(d.orders)} orders · ${nf.format(d.units)} units`);
    }).on('pointerleave blur',()=>hideTip(ctx.tip));
  }

  function renderChart(){
    if(!DATA)return;
    if(RANGE==='90d'){drawWeekly(DATA.series||[]);return;}
    if(RANGE==='28d'){drawDaily(DATA.series||[]);return;}
    drawMonthly(DATA.months||[]);
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

    const notes={mtd:`${pct(h.delta_mtd_pct)} vs same days last month`,t7:`${pct(h.delta7_pct)} vs prior 7 · ${money(h.daily_avg_t7)}/day`,t28:`${pct(h.delta28_pct)} vs prior 28 · ${money(h.daily_avg_t28)}/day`,ytd:'Year to date'};
    Object.entries(panels).forEach(([key,panel])=>{const note=panel?.querySelector('.metric-note');if(note)note.textContent=notes[key];});
    const run=document.getElementById('salesRunRate');if(run)run.textContent=money(h.projected_month_sales);

    const live=document.querySelector('.sales-today-card');
    if(live){
      const meta=live.querySelector('.live-meta');
      if(meta)meta.innerHTML=`<strong>${nf.format(Number(t.orders_today||0))}</strong> orders · <strong>${nf.format(Number(t.units_today||0))}</strong> units`;
    }
  }

  function renderAll(){renderRail();renderChart();}
  function loadEnhanced(){
    fetch('/api/sales',{cache:'no-store'}).then(r=>r.ok?r.json():Promise.reject(new Error(`HTTP ${r.status}`))).then(data=>{
      DATA=data;renderAll();setTimeout(renderAll,180);setTimeout(renderAll,420);
      let timer;window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(renderChart,140);},{passive:true});
    }).catch(()=>{});
  }
  function init(){buildLayout();loadEnhanced();}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
