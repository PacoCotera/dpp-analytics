/* Sales chart period rail v1
   Four stable readouts under the primary chart: sales, volume, pace, benchmark.
   Deeper efficiency metrics belong to Ads / future business-health surfaces. */
(() => {
  'use strict';

  const d3=window.d3;
  if(!d3)return;

  const nf=new Intl.NumberFormat('en-US',{maximumFractionDigits:0});
  const money=value=>'$'+nf.format(Math.round(Number(value||0)));
  const pct=value=>value==null?'—':`${Number(value)>0?'+':Number(value)<0?'−':''}${Math.abs(Number(value)).toFixed(1)}%`;
  const parseDate=value=>value?new Date(`${String(value).slice(0,10)}T12:00:00Z`):null;
  const sum=(rows,key)=>d3.sum(rows||[],d=>Number(d[key]||0));

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

  function weeklyBenchmark(rows){
    const daily=(rows||[]).map(row=>({date:parseDate(row.business_date),sales:Number(row.sales||0)})).filter(d=>d.date).sort((a,b)=>d3.ascending(a.date,b.date));
    const weeks=d3.rollups(
      daily,
      values=>({sales:d3.sum(values,d=>d.sales),days:values.length}),
      d=>+d3.utcMonday.floor(d.date)
    ).map(([week,value])=>({week:new Date(Number(week)),...value})).sort((a,b)=>d3.ascending(a.week,b.week));
    const complete=weeks.filter(d=>d.days>=7);
    if(complete.length<8)return null;
    const recent=sum(complete.slice(-4),'sales');
    const prior=sum(complete.slice(-8,-4),'sales');
    return prior>0?100*(recent-prior)/prior:null;
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
    const weeklyPace=rows.length?sales/rows.length*7:0;
    const benchmark=weeklyBenchmark(rows);
    return [
      {label:'90D sales',value:money(sales),note:'reconciled period'},
      {label:'Orders · units',value:`${nf.format(orders)} · ${nf.format(units)}`,note:'last 90 days'},
      {label:'Pace',value:`${money(weeklyPace)}/week`,note:'90-day average'},
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

  function render(){
    if(!DATA)return;
    const rail=ensureRail();if(!rail)return;
    const range=activeRange();
    const model=range==='90d'?model90d():range==='28d'?model28d():model12m();
    rail.dataset.range=range;
    rail.innerHTML=model.map(item=>`<div class="sales-chart-kpi"><div class="sales-chart-kpi-label">${item.label}</div><div class="sales-chart-kpi-value ${item.tone||''}">${item.value}</div><div class="sales-chart-kpi-note">${item.note}</div></div>`).join('');
  }

  function bindRange(){
    const range=document.querySelector('.sales-range');
    if(!range)return false;
    range.addEventListener('click',event=>{
      if(!event.target.closest('button[data-range]'))return;
      setTimeout(render,0);
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
      .then(data=>{DATA=data;render();setTimeout(render,220);})
      .catch(()=>{});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
