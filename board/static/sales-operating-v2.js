/* Sales operating layout v2
   Primary canvas + signal rail, matching the Home operating architecture.
   Existing data contracts and drilldown tabs remain intact. */
(() => {
  'use strict';

  const money = value => '$' + new Intl.NumberFormat('en-US',{maximumFractionDigits:0}).format(Math.round(Number(value||0)));

  function metricToPanel(el, extraClass=''){
    if(!el) return null;
    const panel=document.createElement('div');
    panel.className=`sales-signal ${extraClass}`.trim();
    while(el.firstChild) panel.appendChild(el.firstChild);
    el.replaceWith(panel);
    return panel;
  }

  function buildLayout(){
    const overview=document.getElementById('overview');
    if(!overview || overview.dataset.operatingV2==='1') return;
    overview.dataset.operatingV2='1';
    document.body.classList.add('sales-operating-v2');

    const pageHead=document.querySelector('.page-head');
    if(pageHead) pageHead.remove();
    const story=overview.querySelector(':scope > .story');
    if(story) story.remove();

    document.querySelectorAll('.tabs button').forEach(btn=>{
      if(btn.dataset.view==='skus') btn.textContent='Products';
    });

    const metricGrid=overview.querySelector('.grid.four');
    const metricSection=metricGrid?.parentElement;
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
    if(live) live.classList.add('sales-today-card');

    const mainAside=overview.querySelector('.grid.main-aside');
    const chartCard=mainAside?.children?.[0] || null;
    if(chartCard){
      const title=chartCard.querySelector('.section-title');
      const sub=chartCard.querySelector('.section-sub');
      if(title) title.textContent='Monthly sales';
      if(sub) sub.textContent='12 months · current month actual + momentum run rate';
    }

    const grid=document.createElement('section');
    grid.className='sales-operating-grid';
    const main=document.createElement('div');
    main.className='sales-main';
    const rail=document.createElement('aside');
    rail.className='sales-signal-rail';
    rail.setAttribute('aria-label','Current sales signals');

    if(chartCard) main.appendChild(chartCard);
    [mtd,t7,t28,live,ytd].forEach(node=>{ if(node) rail.appendChild(node); });
    grid.append(main,rail);
    overview.prepend(grid);

    if(metricSection && metricSection.isConnected) metricSection.remove();
    if(mainAside && mainAside.isConnected) mainAside.remove();
    const insight=document.getElementById('insight');
    if(insight) insight.remove();
  }

  function renderEnhanced(data){
    const h=data?.headline||{};
    const run=document.getElementById('salesRunRate');
    if(run) run.textContent=money(h.projected_month_sales);

    const chartRows=(data?.months||[]).map(row=>({
      ...row,
      projected_sales: row.partial ? Number(h.projected_month_sales||0) : 0
    }));
    const rows=window.innerWidth<=720 ? chartRows.slice(-6) : chartRows;
    if(window.DPPCharts?.monthlySales) window.DPPCharts.monthlySales('#monthChart',rows);
  }

  function loadEnhanced(){
    fetch('/api/sales',{cache:'no-store'})
      .then(r=>r.ok?r.json():Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(data=>{
        renderEnhanced(data);
        setTimeout(()=>renderEnhanced(data),180);
        let timer;
        window.addEventListener('resize',()=>{
          clearTimeout(timer);
          timer=setTimeout(()=>renderEnhanced(data),140);
        },{passive:true});
      })
      .catch(()=>{});
  }

  function init(){buildLayout();loadEnhanced();}
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
