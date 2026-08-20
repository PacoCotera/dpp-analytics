/* Sales chart extensions v1
   Adds FULL history, weekday-aware weekly run rate, and weekend rhythm cues
   without changing the stable 12M / 90D / 28D base renderer. */
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
  const pct=value=>value==null?'—':`${Number(value)>0?'+':Number(value)<0?'−':''}${Math.abs(Number(value)).toFixed(1)}%`;
  const parseDate=value=>value?new Date(`${String(value).slice(0,10)}T12:00:00Z`):null;
  const esc=value=>String(value||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const sum=(rows,key)=>d3.sum(rows||[],d=>Number(d[key]||0));
  const HISTORICAL_BAR='#b78b4d';
  const WEEKEND_BAR='#d8c09b';
  const CURRENT_BAR='#e58b1f';
  const MUTED='#7b7369';

  let DATA=null;

  function activeRange(){return document.querySelector('.sales-range button.active')?.dataset.range||'12m';}

  function ensureFullButton(){
    const range=document.querySelector('.sales-range');
    if(!range)return false;
    if(!range.querySelector('[data-range="full"]')){
      const button=document.createElement('button');
      button.type='button';
      button.dataset.range='full';
      button.setAttribute('aria-pressed','false');
      button.textContent='FULL';
      range.insertBefore(button,range.firstChild);
    }
    return true;
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

  function shell(label){
    const svg=d3.select('#monthChart');if(svg.empty())return null;
    svg.selectAll('*').remove();
    const node=svg.node(),host=node.parentElement,tip=ensureTip(host);
    const compact=window.innerWidth<=720;
    const width=compact?520:960,height=340;
    const m={top:38,right:compact?14:58,bottom:44,left:compact?54:62};
    const innerW=width-m.left-m.right,innerH=height-m.top-m.bottom;
    svg.classed('dpp-chart',true).attr('viewBox',`0 0 ${width} ${height}`).attr('preserveAspectRatio','xMidYMid meet').attr('role','img').attr('aria-label',label);
    return {svg,node,host,tip,width,height,m,innerW,innerH,compact,plot:svg.append('g').attr('transform',`translate(${m.left},${m.top})`)};
  }

  function drawGrid(ctx,y){
    ctx.plot.append('g').attr('class','dpp-grid').call(d3.axisLeft(y).ticks(4).tickSize(-ctx.innerW).tickFormat(''));
    ctx.plot.append('g').attr('class','dpp-axis').call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(10).tickFormat(shortMoney)).call(g=>g.select('.domain').remove());
  }

  function setChartCopy(title,sub){
    const t=document.getElementById('salesChartTitle'),s=document.getElementById('salesChartSub');
    if(t)t.textContent=title;if(s)s.textContent=sub;
  }

  function drawFull(){
    const rows=DATA?.months_full||[];
    const data=rows.map(row=>({
      ...row,
      key:String(row.month||'').slice(0,7),
      date:parseDate(`${String(row.month||'').slice(0,7)}-01`),
      value:Number(row.sales||0),
      orders:Number(row.orders||0),
      units:Number(row.units||0),
      projected:row.partial?Number(DATA?.headline?.projected_month_sales||0):0
    })).filter(d=>d.key&&d.date).sort((a,b)=>d3.ascending(a.key,b.key));
    if(!data.length)return;

    setChartCopy('Full sales history',`Monthly sales · ${data.length} months · year boundaries${data[data.length-1]?.partial?' · current month partial':''}`);
    const ctx=shell('Full monthly sales history with year boundaries');if(!ctx)return;
    const x=d3.scaleBand().domain(data.map(d=>d.key)).range([0,ctx.innerW]).padding(.30);
    const maxValue=d3.max(data,d=>Math.max(d.value,d.projected||0))||1;
    const y=d3.scaleLinear().domain([0,maxValue]).nice(4).range([ctx.innerH,0]);
    drawGrid(ctx,y);

    const patternId='sales-full-run-rate';
    const pattern=ctx.svg.append('defs').append('pattern').attr('id',patternId).attr('width',7).attr('height',7).attr('patternUnits','userSpaceOnUse').attr('patternTransform','rotate(45)');
    pattern.append('rect').attr('width',7).attr('height',7).attr('fill','#f3dfc4').attr('opacity',.48);
    pattern.append('line').attr('x1',0).attr('y1',0).attr('x2',0).attr('y2',7).attr('stroke',CURRENT_BAR).attr('stroke-width',1.7).attr('opacity',.48);

    const bars=ctx.plot.selectAll('.dpp-bar.sales-full').data(data).join('rect')
      .attr('class','dpp-bar sales-full').attr('x',d=>x(d.key)).attr('width',x.bandwidth())
      .attr('y',d=>y(d.value)).attr('height',d=>Math.max(1,ctx.innerH-y(d.value)))
      .attr('rx',4).attr('fill',d=>d.partial?CURRENT_BAR:HISTORICAL_BAR);

    const projected=data.filter(d=>d.partial&&d.projected>d.value);
    ctx.plot.selectAll('.sales-full-ghost').data(projected).join('rect')
      .attr('class','sales-full-ghost').attr('x',d=>x(d.key)).attr('width',x.bandwidth())
      .attr('y',d=>y(d.projected)).attr('height',d=>Math.max(1,y(d.value)-y(d.projected)))
      .attr('rx',4).attr('fill',`url(#${patternId})`).attr('stroke',CURRENT_BAR).attr('stroke-width',1).attr('stroke-opacity',.72);

    const byYear=d3.groups(data,d=>d.date.getUTCFullYear());
    const yearLayer=ctx.plot.append('g').attr('class','sales-full-years').attr('pointer-events','none');
    byYear.forEach(([year,items],index)=>{
      const first=items[0],last=items[items.length-1];
      const left=x(first.key),right=x(last.key)+x.bandwidth(),center=(left+right)/2;
      if(index>0){
        const divider=left-(x.step()-x.bandwidth())/2;
        yearLayer.append('line').attr('x1',divider).attr('x2',divider).attr('y1',18).attr('y2',ctx.innerH)
          .attr('stroke','#aaa197').attr('stroke-width',1).attr('stroke-dasharray','3 4').attr('opacity',.76);
      }
      yearLayer.append('text').attr('x',center).attr('y',11).attr('text-anchor','middle')
        .attr('fill',MUTED).attr('font-size',8.7).attr('font-weight',760).attr('letter-spacing','.06em').text(String(year));
    });

    if(!ctx.compact&&data.length<=16){
      ctx.plot.selectAll('.sales-full-value').data(data.filter(d=>!d.partial)).join('text')
        .attr('class','dpp-value sales-full-value').attr('x',d=>x(d.key)+x.bandwidth()/2).attr('y',d=>y(d.value)-8)
        .attr('text-anchor','middle').text(d=>shortMoney(d.value));
    }
    ctx.plot.selectAll('.sales-full-runrate-label').data(projected).join('text')
      .attr('class','sales-full-runrate-label').attr('x',d=>x(d.key)+x.bandwidth()/2).attr('y',d=>Math.max(22,y(d.projected)-8))
      .attr('text-anchor','middle').attr('fill',MUTED).attr('font-size',8.5).attr('font-weight',700).text(d=>`Run rate · ${shortMoney(d.projected)}`);

    let ticks=data;
    if(data.length>18)ticks=data.filter((d,i)=>d.date.getUTCMonth()%3===0||i===0||i===data.length-1);
    ctx.plot.append('g').attr('class','dpp-axis').attr('transform',`translate(0,${ctx.innerH})`)
      .call(d3.axisBottom(x).tickValues(ticks.map(d=>d.key)).tickSize(0).tickPadding(12).tickFormat(key=>d3.utcFormat('%b')(parseDate(`${key}-01`))))
      .call(g=>g.select('.domain').attr('stroke','#cfc5b7'));

    bars.attr('tabindex',0).on('pointerenter pointermove focus',function(event,d){
      showTip(ctx.host,ctx.tip,this,d3.utcFormat('%B %Y')(d.date),[{label:'Sales',value:money(d.value)}],`${nf.format(d.orders)} orders · ${nf.format(d.units)} units`);
    }).on('pointerleave blur',()=>hideTip(ctx.tip));
  }

  function weeksFromRows(rows){
    const daily=(rows||[]).map(row=>({date:parseDate(row.business_date),sales:Number(row.sales||0)})).filter(d=>d.date).sort((a,b)=>d3.ascending(a.date,b.date));
    return d3.rollups(
      daily,
      values=>{
        const daySales=Array(7).fill(0);
        values.forEach(v=>{const idx=(v.date.getUTCDay()+6)%7;daySales[idx]+=v.sales;});
        return {sales:d3.sum(values,d=>d.sales),days:values.length,dates:values.map(d=>d.date).sort(d3.ascending),daySales};
      },
      d=>+d3.utcMonday.floor(d.date)
    ).map(([week,value])=>({week:new Date(Number(week)),...value})).sort((a,b)=>d3.ascending(a.week,b.week));
  }

  function currentWeekProjection(){
    const weeks=weeksFromRows((DATA?.series||[]).slice(-90));
    const current=weeks[weeks.length-1];
    if(!current||current.days<=0||current.days>=7||current.sales<=0)return null;
    const prior=weeks.slice(0,-1).filter(w=>w.days>=7&&w.sales>0).slice(-8);
    if(!prior.length)return null;

    const latest=current.dates[current.dates.length-1];
    const elapsedIndex=(latest.getUTCDay()+6)%7;
    const shares=prior.map(w=>d3.sum(w.daySales.slice(0,elapsedIndex+1))/w.sales).filter(v=>Number.isFinite(v)&&v>.04&&v<=1);
    const baselineWeeks=prior.slice(-4);
    const baseline=d3.mean(baselineWeeks,w=>w.sales)||0;
    const historicalShare=d3.mean(shares);
    const paceProjection=historicalShare>0?current.sales/historicalShare:(current.sales/Math.max(current.days,1))*7;
    const confidence=Math.min(1,Math.max(1,current.days)/7);
    const projected=Math.max(current.sales,baseline*(1-confidence)+paceProjection*confidence);
    return {current,latest,projected,baseline,paceProjection,confidence};
  }

  function correctWeeklyRunRate(){
    const svg=d3.select('#monthChart');
    svg.selectAll('.sales-week-runrate,.sales-week-runrate-label').remove();
    svg.select('defs#sales-week-runrate-defs').remove();
    if(activeRange()!=='90d'||!DATA)return;
    const result=currentWeekProjection();if(!result)return;
    const {current,latest,projected}=result;
    if(projected<=current.sales)return;

    const grouped=weeksFromRows((DATA.series||[]).slice(-90)).slice(-13);
    const compact=window.innerWidth<=720,width=compact?520:960;
    const m={top:28,right:compact?14:58,bottom:44,left:compact?54:62};
    const innerW=width-m.left-m.right,innerH=340-m.top-m.bottom;
    const x=d3.scaleBand().domain(grouped.map(d=>+d.week)).range([0,innerW]).padding(.30);
    const y=d3.scaleLinear().domain([0,d3.max(grouped,d=>d.sales)||1]).nice(4).range([innerH,0]);
    const plot=svg.select('g');if(plot.empty())return;

    const patternId='sales-week-runrate-pattern';
    const defs=svg.append('defs').attr('id','sales-week-runrate-defs');
    const pattern=defs.append('pattern').attr('id',patternId).attr('width',7).attr('height',7).attr('patternUnits','userSpaceOnUse').attr('patternTransform','rotate(45)');
    pattern.append('rect').attr('width',7).attr('height',7).attr('fill','#f3dfc4').attr('opacity',.48);
    pattern.append('line').attr('x1',0).attr('y1',0).attr('x2',0).attr('y2',7).attr('stroke',CURRENT_BAR).attr('stroke-width',1.7).attr('opacity',.48);

    const actualY=y(current.sales),projectedY=Math.max(0,y(projected));
    plot.append('rect').attr('class','sales-week-runrate').attr('pointer-events','none')
      .attr('x',x(+current.week)).attr('width',x.bandwidth()).attr('y',projectedY).attr('height',Math.max(1,actualY-projectedY))
      .attr('rx',4).attr('fill',`url(#${patternId})`).attr('stroke',CURRENT_BAR).attr('stroke-width',1).attr('stroke-opacity',.72);
    plot.append('text').attr('class','sales-week-runrate-label').attr('pointer-events','none')
      .attr('x',x(+current.week)+x.bandwidth()/2).attr('y',Math.max(11,projectedY-8)).attr('text-anchor','middle')
      .attr('fill',MUTED).attr('font-size',8.5).attr('font-weight',700).text(`Run rate · ${shortMoney(projected)}`);

    const pace=document.querySelector('#salesChartKpiRail .sales-chart-kpi:nth-child(3)');
    if(pace){
      const value=pace.querySelector('.sales-chart-kpi-value'),note=pace.querySelector('.sales-chart-kpi-note');
      if(value)value.textContent=`${money(projected)}/week`;
      if(note)note.textContent=`weekday-adjusted · through ${d3.utcFormat('%a')(latest)}`;
    }
  }

  function tintWeekends(){
    if(activeRange()!=='28d')return;
    d3.select('#monthChart').selectAll('.dpp-bar').attr('fill',d=>{
      const date=d?.date;
      if(!(date instanceof Date))return HISTORICAL_BAR;
      const day=date.getUTCDay();
      return day===0||day===6?WEEKEND_BAR:HISTORICAL_BAR;
    });
  }

  function updateFullRail(){
    const rail=document.getElementById('salesChartKpiRail');
    const rows=DATA?.months_full||[];
    if(!rail||!rows.length)return;
    const sales=sum(rows,'sales'),orders=sum(rows,'orders'),units=sum(rows,'units');
    const completed=rows.filter(row=>!row.partial);
    const avgMonth=completed.length?sum(completed,'sales')/completed.length:0;
    let benchmark=null;
    if(completed.length>=24){
      const recent=sum(completed.slice(-12),'sales'),prior=sum(completed.slice(-24,-12),'sales');
      if(prior>0)benchmark=100*(recent-prior)/prior;
    }
    const tone=benchmark==null?'':benchmark>0?'good':benchmark<0?'bad':'';
    rail.dataset.range='full';
    rail.innerHTML=`
      <div class="sales-chart-kpi"><div class="sales-chart-kpi-label">Full sales</div><div class="sales-chart-kpi-value">${money(sales)}</div><div class="sales-chart-kpi-note">reconciled history</div></div>
      <div class="sales-chart-kpi"><div class="sales-chart-kpi-label">Orders · units</div><div class="sales-chart-kpi-value">${nf.format(orders)} · ${nf.format(units)}</div><div class="sales-chart-kpi-note">full history</div></div>
      <div class="sales-chart-kpi"><div class="sales-chart-kpi-label">Avg month</div><div class="sales-chart-kpi-value">${money(avgMonth)}</div><div class="sales-chart-kpi-note">completed months</div></div>
      <div class="sales-chart-kpi"><div class="sales-chart-kpi-label">Benchmark</div><div class="sales-chart-kpi-value ${tone}">${benchmark==null?'—':pct(benchmark)}</div><div class="sales-chart-kpi-note">${benchmark==null?'prior 12M not available':'last 12M vs prior 12M'}</div></div>`;
  }

  function renderExtensions(){
    if(!DATA)return;
    const range=activeRange();
    if(range==='full'){
      drawFull();
      updateFullRail();
      return;
    }
    if(range==='90d'){
      correctWeeklyRunRate();
      return;
    }
    if(range==='28d')tintWeekends();
  }

  function bind(){
    const range=document.querySelector('.sales-range');
    if(!range||range.dataset.extensionsBound==='1')return Boolean(range);
    range.dataset.extensionsBound='1';
    range.addEventListener('click',event=>{
      if(!event.target.closest('button[data-range]'))return;
      setTimeout(renderExtensions,90);
    });
    return true;
  }

  function init(){
    let attempts=0;
    const ready=setInterval(()=>{
      attempts+=1;
      if(ensureFullButton()&&bind()||attempts>50)clearInterval(ready);
    },50);
    fetch('/api/sales',{cache:'no-store'})
      .then(response=>response.ok?response.json():Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(data=>{DATA=data;setTimeout(renderExtensions,260);})
      .catch(()=>{});
    let timer;
    window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(renderExtensions,260);},{passive:true});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
