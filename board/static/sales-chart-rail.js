/* Sales chart period rail v4
   Four stable readouts under the primary chart: sales, volume, pace, benchmark.
   28D adds quiet weekly structure using dividers only.
   Run-rate rendering is owned by sales-chart-extensions.js so the visual treatment cannot drift. */
(() => {
  'use strict';

  const d3=window.d3;
  if(!d3)return;

  const nf=new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
  const money=value=>'$'+nf.format(Math.round(Number(value||0)));
  const pct=value=>value==null?'—':`${Number(value)>0?'+':Number(value)<0?'−':''}${Math.abs(Number(value)).toFixed(1)}%`;
  const parseDate=value=>value?new Date(`${String(value).slice(0,10)}T12:00:00Z`):null;
  const sum=(rows,key)=>d3.sum(rows||[],d=>Number(d[key]||0));
  const MUTED='#7b7369';

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

  function activeRange(){return document.querySelector('.sales-range button.active')?.dataset.range||'12m';}

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
      values=>({sales:d3.sum(values,d=>d.sales),orders:d3.sum(values,d=>d.orders),units:d3.sum(values,d=>d.units),days:values.length,dates:values.map(d=>d.date).sort(d3.ascending)}),
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

  function currentWeek(rows){
    const weeks=weeksFromRows(rows);
    return weeks[weeks.length-1]||null;
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
    const current=currentWeek(rows);
    const benchmark=weeklyBenchmark(rows);
    return [
      {label:'90D sales',value:money(sales),note:'reconciled period'},
      {label:'Orders · units',value:`${nf.format(orders)} · ${nf.format(units)}`,note:'last 90 days'},
      {label:'Pace',value:current?`${money(current.sales)}/week`:'—',note:current&&current.days<7?'WTD · calculating run rate':'latest completed week'},
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

  function renderDailyWeekStructure(){
    const svg=d3.select('#monthChart');
    svg.selectAll('.sales-day-week-structure').remove();
    if(activeRange()!=='28d'||!DATA)return;

    const daily=(DATA.series||[]).slice(-28).map(row=>({date:parseDate(row.business_date)})).filter(d=>d.date).sort((a,b)=>d3.ascending(a.date,b.date));
    if(daily.length<2)return;

    const compact=window.innerWidth<=720;
    const width=compact?520:960;
    const m={top:28,right:compact?14:58,bottom:44,left:compact?54:62};
    const innerW=width-m.left-m.right,innerH=340-m.top-m.bottom;
    const x=d3.scaleBand().domain(daily.map(d=>+d.date)).range([0,innerW]).padding(.30);
    const plot=svg.select('g');if(plot.empty())return;
    const layer=plot.append('g').attr('class','sales-day-week-structure').attr('pointer-events','none');

    daily.forEach((day,index)=>{
      if(index===0||day.date.getUTCDay()!==1)return;
      const divider=x(+day.date)-(x.step()-x.bandwidth())/2;
      layer.append('line')
        .attr('x1',divider).attr('x2',divider).attr('y1',24).attr('y2',innerH)
        .attr('stroke','#bfb7ac').attr('stroke-width',.8).attr('opacity',.38);
    });
  }

  function polishBaseChart(){
    const svg=d3.select('#monthChart');
    if(activeRange()!=='12m')return;
    svg.selectAll('.sales-month-value').each(function(){
      const node=d3.select(this);
      if(/^Actual\s/i.test(node.text()))node.text('');
    });
    svg.selectAll('.dpp-projection-value')
      .style('fill',MUTED).style('font-size','8.5px').style('font-weight','650').style('letter-spacing','.015em')
      .each(function(){
        const node=d3.select(this);
        const value=node.text().replace(/^Run rate\s*(?:·\s*)?/i,'');
        node.text(`Run rate · ${value}`);
      });
    svg.selectAll('.dpp-legend text')
      .style('fill',MUTED).style('font-weight','650')
      .each(function(){if(d3.select(this).text()==='Momentum run rate')d3.select(this).text('Run rate');});
  }

  function render(){
    renderRail();
    setTimeout(()=>{renderDailyWeekStructure();polishBaseChart();},28);
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
      if(bindRange()||attempts>40)clearInterval(ready);
    },50);
    fetch('/api/sales',{cache:'no-store'})
      .then(response=>response.ok?response.json():Promise.reject(new Error(`HTTP ${response.status}`)))
      .then(data=>{DATA=data;render();setTimeout(render,240);setTimeout(render,520);})
      .catch(()=>{});
    let timer;
    window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(render,180);},{passive:true});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
