/* Sales chart period rail v2
   Four stable readouts under the primary chart: sales, volume, pace, benchmark.
   90D also extends the current partial week to a directional seven-day run rate.
   Deeper efficiency metrics belong to Ads / future business-health surfaces. */
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
  const sum=(rows,key)=>d3.sum(rows||[],d=>Number(d[key]||0));
  const CURRENT_BAR='#e58b1f';

  let DATA=null;

  function ensureRail(){
    const chart=document.getElementById('monthChart');
    if(!chart)return null;
    let rail=document.getElementById('salesChartKpiRail');
    if(!rail){
      rail=document.createElement('div');
      rail.id='salesChartKpiRail';
      rail.className='sales-chart-kpi-rail';
      rail.setAttribute('aria-label','Selected sales period key metrics');
      chart.insertAdjacentElement('afterend',rail);
    }
    return rail;
  }

  function activeRange(){
    return document.querySelector('.sales-range button.active')?.dataset.range||'12m';
  }

  function comparisonClass(value){
    const n=Number(value);
    return !Number.isFinite(n)||n===0?'':n>0?'good':'bad';
  }

  function monthNames(businessDate){
    const date=parseDate(businessDate);
    if(!date)return {current:'Month',prior:'prior month'};
    return {
      current:new Intl.DateTimeFormat('en-US',{month:'short'}).format(date),
      prior:new Intl.DateTimeFormat('en-US',{month:'short'}).format(d3.utcMonth.offset(date,-1))
    };
  }

  function weeksFromRows(rows){
    const daily=(rows||[]).map(row=>({date:parseDate(row.business_date),sales:Number(row.sales||0),orders:Number(row.orders||0),units:Number(row.units||0)})).filter(d=>d.date).sort((a,b)=>d3.ascending(a.date,b.date));
    return d3.rollups(
      daily,
      values=>({sales:d3.sum(values,d=>d.sales),orders:d3.sum(values,d=>d.orders),units:d3.sum(values,d=>d.units),days:values.length}),
      d=>+d3.utcMonday.floor(d.date)
    ).map(([week,value])=>({week:new Date(Number(week)),...value})).sort((a,b)=>d3.ascending(a.week,b.week));
  }

  function weeklyBenchmark(rows){
    const complete=weeksFromRows(rows).filter(d=>d.days>=7);
    if(complete.length<8)return null;
    const recent=sum(complete.slice(-4),'sales');
    const prior=sum(complete.slice(-8,-4),'sales');
    return prior>0?100*(recent-prior)/prior:null;
  }

  function currentWeekRunRate(rows){
    const weeks=weeksFromRows(rows);
    const current=weeks[weeks.length-1];
    if(!current||current.days<=0)return null;
    return {
      ...current,
      complete:current.days>=7,
      projected:current.days>=7?current.sales:(current.sales/current.days)*7
    };
  }

  function model12m(){
    const h=DATA?.headline||{};
    const names=monthNames(h.business_date);
    return [
      {label:`${names.current} MTD sales`,value:money(h.sales_mtd),note:'current open month'},
      {label:'Orders · units',value:`${nf.format(Number(h.orders_mtd||0))} · ${nf.format(Number(h.units_mtd||0))}`,note:'month to date'},
      {label:'Pace',value:`${money(h.daily_avg_mtd)}/day`,note:`run rate ${money(h.projected_month_sales)}`},
      {label:'Benchmark',value:pct(h.delta_mtd_pct),note:`vs same days ${names.prior}`,tone:comparisonClass(h.delta_mtd_pct)}
    ];
  }

  function model90d(){
    const rows=(DATA?.series||[]).slice(-90);
    const sales=sum(rows,'sales'),orders=sum(rows,'orders'),units=sum(rows,'units');
    const current=currentWeekRunRate(rows);
    const benchmark=weeklyBenchmark(rows);
    const pace=current?.projected||0;
    return [
      {label:'90D sales',value:money(sales),note:'reconciled period'},
      {label:'Orders · units',value:`${nf.format(orders)} · ${nf.format(units)}`,note:'last 90 days'},
      {label:'Pace',value:`${money(pace)}/week`,note:current&&!current.complete?`WTD run rate · ${current.days}/7 days`:'latest completed week'},
      {label:'Benchmark',value:pct(benchmark),note:'last 4W vs prior 4W',tone:comparisonClass(benchmark)}
    ];
  }

  function model28d(){
    const h=DATA?.headline||{};
    return [
      {label:'28D sales',value:money(h.sales_t28),note:'reconciled period'},
      {label:'Orders · units',value:`${nf.format(Number(h.orders_t28||0))} · ${nf.format(Number(h.units_t28||0))}`,note:'last 28 days'},
      {label:'Pace',value:`${money(h.daily_avg_t28)}/day`,note:'28-day average'},
      {label:'Benchmark',value:pct(h.delta28_pct),note:'vs prior 28 days',tone:comparisonClass(h.delta28_pct)}
    ];
  }

  function renderRail(){
    if(!DATA)return;
    const rail=ensureRail();if(!rail)return;
    const range=activeRange();
    const model=range==='90d'?model90d():range==='28d'?model28d():model12m();
    rail.dataset.range=range;
    rail.innerHTML=model.map(item=>`<div class="sales-chart-kpi"><div class="sales-chart-kpi-label">${item.label}</div><div class="sales-chart-kpi-value ${item.tone||''}">${item.value}</div><div class="sales-chart-kpi-note">${item.note}</div></div>`).join('');
  }

  function renderWeeklyRunRate(){
    const svg=d3.select('#monthChart');
    svg.selectAll('.sales-week-runrate,.sales-week-runrate-label').remove();
    svg.select('defs#sales-week-runrate-defs').remove();
    if(activeRange()!=='90d'||!DATA)return;

    const grouped=weeksFromRows((DATA.series||[]).slice(-90)).slice(-13);
    const current=grouped[grouped.length-1];
    if(!current||current.days<=0||current.days>=7||current.sales<=0)return;
    const projected=current.sales/current.days*7;
    if(projected<=current.sales)return;

    const compact=window.innerWidth<=720;
    const width=compact?520:960;
    const m={top:28,right:compact?14:58,bottom:44,left:compact?54:62};
    const innerW=width-m.left-m.right,innerH=340-m.top-m.bottom;
    const domain=grouped.map(d=>+d.week);
    const x=d3.scaleBand().domain(domain).range([0,innerW]).padding(.30);
    const y=d3.scaleLinear().domain([0,d3.max(grouped,d=>d.sales)||1]).nice(4).range([innerH,0]);
    const plot=svg.select('g');
    if(plot.empty())return;

    const patternId='sales-week-runrate-pattern';
    const defs=svg.append('defs').attr('id','sales-week-runrate-defs');
    const pattern=defs.append('pattern').attr('id',patternId).attr('width',7).attr('height',7).attr('patternUnits','userSpaceOnUse').attr('patternTransform','rotate(45)');
    pattern.append('rect').attr('width',7).attr('height',7).attr('fill','#f3dfc4').attr('opacity',.55);
    pattern.append('line').attr('x1',0).attr('y1',0).attr('x2',0).attr('y2',7).attr('stroke',CURRENT_BAR).attr('stroke-width',2).attr('opacity',.58);

    const actualY=y(current.sales);
    const projectedY=Math.max(0,y(projected));
    plot.append('rect').attr('class','sales-week-runrate').attr('pointer-events','none')
      .attr('x',x(+current.week)).attr('width',x.bandwidth())
      .attr('y',projectedY).attr('height',Math.max(1,actualY-projectedY))
      .attr('rx',4).attr('fill',`url(#${patternId})`).attr('stroke',CURRENT_BAR).attr('stroke-width',1.15);
    plot.append('text').attr('class','sales-week-runrate-label').attr('pointer-events','none')
      .attr('x',x(+current.week)+x.bandwidth()/2).attr('y',Math.max(11,projectedY-8)).attr('text-anchor','middle')
      .attr('fill','#6e430b').attr('font-size',9).attr('font-weight',820).text(`Run rate ${shortMoney(projected)}`);
  }

  function render(){
    renderRail();
    setTimeout(renderWeeklyRunRate,24);
  }

  function bindRange(){
    const range=document.querySelector('.sales-range');
    if(!range||range.dataset.chartRailBound==='1')return Boolean(range);
    range.dataset.chartRailBound='1';
    range.addEventListener('click',event=>{
      if(!event.target.closest('button[data-range]'))return;
      setTimeout(render,20);
    });
    return true;
  }

  function init(){
    let attempts=0;
    const ready=setInterval(()=>{
      attempts+=1;
      if(bindRange()||attempts>40){clearInterval(ready);}
    },50);
    fetch('/api/sales',{cache:'no-store'})
      .then(response=>response.ok?response.json():Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(data=>{DATA=data;render();setTimeout(render,240);})
      .catch(()=>{});
    let timer;
    window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(render,180);},{passive:true});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
