/* sales-current-state-rail-js-v1
   Stable operating-state rail: MTD hero, grouped momentum, Today and YTD utility rows.
   The rail meaning does not change with the analytical chart window. */
(() => {
  'use strict';

  function cleanMomentumNote(node, period){
    if(!node)return;
    const raw=(node.textContent||'').trim();
    if(!raw)return;
    const benchmark=raw.split('·')[0].trim();
    if(benchmark && node.dataset.compactBenchmark!==benchmark){
      node.dataset.compactBenchmark=benchmark;
      node.textContent=benchmark;
    }
    node.setAttribute('aria-label', period==='7d' ? `${benchmark}; seven day comparison` : `${benchmark}; twenty-eight day comparison`);
  }

  function refine(){
    const rail=document.querySelector('.sales-signal-rail');
    if(!rail)return false;

    const primary=rail.querySelector('.sales-signal.primary');
    const t7=rail.querySelector('.sales-signal[data-window="t7"]');
    const t28=rail.querySelector('.sales-signal[data-window="t28"]');
    const today=rail.querySelector('.sales-today-card');
    const ytd=rail.querySelector('.sales-signal.ytd');
    if(!primary||!t7||!t28||!today||!ytd)return false;

    rail.classList.add('sales-state-rail');

    const runLabel=primary.querySelector('.sales-run-rate span');
    if(runLabel)runLabel.textContent='Run rate';

    let momentum=rail.querySelector('.sales-momentum-card');
    if(!momentum){
      momentum=document.createElement('section');
      momentum.className='sales-momentum-card';
      momentum.setAttribute('aria-label','Recent sales momentum');
      momentum.innerHTML='<div class="sales-momentum-title">Momentum</div>';
      primary.insertAdjacentElement('afterend',momentum);
      momentum.append(t7,t28);
    }

    [[t7,'7D','7d'],[t28,'28D','28d']].forEach(([panel,label,key])=>{
      panel.classList.add('sales-momentum-row');
      const metricLabel=panel.querySelector('.metric-label');
      if(metricLabel)metricLabel.textContent=label;
      cleanMomentumNote(panel.querySelector('.metric-note'),key);
    });

    today.classList.add('sales-utility-row','sales-utility-today');
    ytd.classList.add('sales-utility-row','sales-utility-ytd');
    return true;
  }

  function init(){
    let attempts=0;
    const timer=setInterval(()=>{
      attempts+=1;
      if(refine()||attempts>60)clearInterval(timer);
    },50);

    const observer=new MutationObserver(()=>{
      const rail=document.querySelector('.sales-state-rail');
      if(!rail)return;
      const t7=rail.querySelector('.sales-signal[data-window="t7"]');
      const t28=rail.querySelector('.sales-signal[data-window="t28"]');
      cleanMomentumNote(t7?.querySelector('.metric-note'),'7d');
      cleanMomentumNote(t28?.querySelector('.metric-note'),'28d');
      const runLabel=rail.querySelector('.sales-run-rate span');
      if(runLabel&&runLabel.textContent!=='Run rate')runLabel.textContent='Run rate';
    });
    observer.observe(document.body,{subtree:true,childList:true,characterData:true});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
  else init();
})();
