/* Today operating layout v2
   Reframes normal Today as live state -> rhythm -> evidence.
   Wall mode intentionally keeps its dedicated live-display composition. */
(() => {
  'use strict';
  if(!document.body.classList.contains('today-shell'))return;
  if(document.documentElement.classList.contains('wall-mode'))return;
  if(document.body.classList.contains('today-operating-v2'))return;
  document.body.classList.add('today-operating-v2');

  const app=document.querySelector('.today-shell>.app');
  const hero=document.querySelector('.hero');
  const heroMain=hero?.querySelector('.hero-main');
  const latest=hero?.querySelector('.latest');
  const context=document.querySelector('.context-strip');
  if(!app||!hero||!heroMain||!latest||!context)return;

  const stage=document.createElement('section');
  stage.className='today-operating-stage';
  stage.setAttribute('aria-label','Current business state');
  const main=document.createElement('div');
  main.className='today-operating-main';
  const rail=document.createElement('aside');
  rail.className='today-state-rail';
  rail.setAttribute('aria-label','Today operating context');

  hero.before(stage);
  stage.append(main,rail);
  main.appendChild(heroMain);
  rail.appendChild(latest);
  [...context.children].forEach(node=>{
    node.classList.add('today-state-row');
    rail.appendChild(node);
  });

  const latestLabel=document.getElementById('latestLabel');
  if(latestLabel)latestLabel.textContent='Latest sale';
  const productsTitle=document.getElementById('productsTitle');
  if(productsTitle)productsTitle.textContent='What sold';
  const productsSub=document.getElementById('productsSub');
  if(productsSub)productsSub.textContent='Product mix for the selected day';
  const rhythmTitle=document.querySelector('.content-grid>.panel:first-child .panel-title');
  if(rhythmTitle)rhythmTitle.textContent='Recent rhythm';
  const ordersTitle=document.querySelector('.wins .panel-title');
  if(ordersTitle)ordersTitle.textContent='Orders';

  function compactStateLabels(){
    const map={weekLabel:'WTD',mtdLabel:'MTD',last30Label:'30D'};
    Object.entries(map).forEach(([id,label])=>{
      const node=document.getElementById(id);if(node)node.textContent=label;
    });
  }

  function compactDatePicker(){
    const buttons=[...document.querySelectorAll('#dayPicker .day-choice')];
    buttons.forEach((button,index)=>{
      const label=button.querySelector('b');
      const sub=button.querySelector('span');
      if(label&&index>1){
        const raw=label.textContent.trim();
        if(raw.length>3)label.textContent=raw.slice(0,3);
      }
      if(sub){
        const raw=sub.textContent.trim();
        sub.textContent=raw.replace(/closed/i,'').replace(/\s+/g,' ').trim();
      }
    });
  }

  function syncSelectedLanguage(){
    const active=document.querySelector('#dayPicker .day-choice.active');
    const live=active?.classList.contains('live');
    const products=document.getElementById('productsTitle');
    if(products)products.textContent=live?'What sold today':'What sold that day';
  }

  const refresh=()=>{
    compactStateLabels();
    compactDatePicker();
    syncSelectedLanguage();
  };
  refresh();
  const picker=document.getElementById('dayPicker');
  if(picker)new MutationObserver(()=>setTimeout(refresh,20)).observe(picker,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
})();

/* Load the Today showcase layer after the structural operating pass. */
(() => {
  if(!document.body.classList.contains('today-shell'))return;
  if(!document.querySelector('link[data-today-showcase]')){
    const link=document.createElement('link');
    link.rel='stylesheet';
    link.href='/assets/today-showcase.css';
    link.dataset.todayShowcase='1';
    document.head.appendChild(link);
  }
  if(!document.querySelector('script[data-today-showcase]')){
    const script=document.createElement('script');
    script.src='/assets/today-showcase.js';
    script.defer=true;
    script.dataset.todayShowcase='1';
    document.body.appendChild(script);
  }
})();
