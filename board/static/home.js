import { escapeHtml, fetchJson, integer, money, percent, tone } from './ui-utils.js';

function stateRead(delta, actions) {
  const momentum = Number(delta || 0);
  const decisionCount = Number(actions || 0);
  const decisionCopy = decisionCount
    ? `${decisionCount} operating decision${decisionCount === 1 ? ' needs' : 's need'} attention.`
    : '';

  if (momentum >= 8) return {headline:'Momentum is strong.',copy:decisionCount?`The last four weeks of shopper spend are clearly ahead of the prior four. ${decisionCopy}`:'The last four weeks of shopper spend are clearly ahead of the prior four, with nothing requiring immediate attention.'};
  if (momentum >= 2) return {headline:'The business is growing.',copy:decisionCount?`Recent shopper spend is modestly ahead. ${decisionCopy}`:'Recent shopper spend is modestly ahead and there are no immediate operating exceptions.'};
  if (momentum > -2) return {headline:'The business is steady.',copy:decisionCount?`Recent shopper spend is essentially flat. ${decisionCopy}`:'Recent shopper spend is essentially flat and operations are currently clear.'};
  if (momentum > -8) return {headline:'Momentum has softened.',copy:decisionCount?`The last four weeks of shopper spend are below the prior four. ${decisionCount} operating decision${decisionCount===1?' also needs':'s also need'} attention.`:'The last four weeks of shopper spend are below the prior four, but no immediate operating exception is flagged.'};
  return {headline:'The business is cooling.',copy:decisionCount?`Recent shopper spend is meaningfully below the prior four weeks and ${decisionCopy}`:'Recent shopper spend is meaningfully below the prior four weeks. Operations themselves are currently clear.'};
}

function renderAttention(data, decisionCount) {
  const attention=(data.inventory||[]).filter(item=>['STOCKOUT','PRODUCE','PLAN'].includes(String(item.action||'').toUpperCase()));
  const title=document.getElementById('attentionTitle'); const copy=document.getElementById('attentionCopy'); const container=document.getElementById('attention');
  if(!attention.length){title.textContent='Nothing needs attention';copy.textContent='No stockout, production or planning exception is currently flagged.';container.innerHTML='<div class="attention-clear"><strong>Operations are clear.</strong><p>Use the business rhythm and product drivers to understand performance; there is no immediate inventory action.</p></div>';return;}
  const item=attention[0]; title.textContent=decisionCount===1?'One decision needs attention':`${decisionCount} decisions need attention`;
  copy.textContent=item.action==='STOCKOUT'?'Availability is already constraining demand.':item.action==='PRODUCE'?'Current cover is below the production threshold.':'Stock cover is approaching the planning threshold.';
  container.innerHTML=`<a class="attention-item" href="/inventory"><div><div class="sku">${escapeHtml(item.sku)} · ${escapeHtml(item.action)}</div><div class="name">${escapeHtml(item.product||item.sku)}</div><div class="meta">${integer(item.available)} on hand · ${integer(item.inbound)} inbound</div></div><div class="attention-cover"><strong>${item.days_cover==null?'—':Number(item.days_cover).toFixed(0)}</strong><span>days cover</span></div></a>`;
}

function renderDrivers(data,businessSales){
  const movers=(data.movers||[]).slice(0,3); const container=document.getElementById('movers');
  if(!movers.length){container.innerHTML='<div class="empty"><strong>No product-driver data yet.</strong>Drivers will appear as history builds.</div>';return;}
  container.innerHTML=movers.map((item,index)=>{const deltaTone=tone(item.delta28_pct);const image=item.image_url?`<img src="${escapeHtml(item.image_url)}" alt="" loading="lazy">`:'';const direction=Number(item.delta28_pct)>=8?'accelerating':Number(item.delta28_pct)<=-8?'declining':'stable';const share=businessSales>0?(100*Number(item.sales_t28||0))/businessSales:null;const read=`${index===0?'Largest driver · ':''}${share==null?'share unavailable':`${share.toFixed(0)}% of 28D shopper spend`} · ${direction} ${percent(item.delta28_pct)}`;return `<a class="driver" href="/product?sku=${encodeURIComponent(item.sku)}">${image}<div><div class="sku">${escapeHtml(item.sku)}</div><div class="name">${escapeHtml(item.product||item.sku)}</div><div class="read ${deltaTone}">${read}</div></div><div class="driver-value"><strong>${money(item.sales_t28)}</strong><small>28D shopper spend · incl. IVA</small></div></a>`;}).join('');
}

function render(data){
  const today=data.today||{};const rolling=data.rolling||{};const inventory=data.inventory_summary||{};const decisionCount=Number(inventory.needs_action||0);const read=stateRead(rolling.delta28_pct,decisionCount);
  document.getElementById('clock').textContent=data.local_time||'--:--';document.getElementById('fresh').textContent='Live operating data';document.getElementById('stateHeadline').textContent=read.headline;document.getElementById('stateCopy').textContent=read.copy;
  document.getElementById('sales28').textContent=money(rolling.sales_t28);document.getElementById('sales28Note').textContent='incl. IVA · Sales & Traffic';
  const momentum=document.getElementById('momentum');momentum.textContent=percent(rolling.delta28_pct);momentum.className=`kpi__value ${tone(rolling.delta28_pct)}`;document.getElementById('momentumNote').textContent='vs prior 28 · same gross basis';
  document.getElementById('todaySales').textContent=money(today.sales_today);document.getElementById('todayNote').textContent=`incl. IVA · ${integer(today.orders_today)} orders · ${integer(today.units_today)} units`;document.getElementById('decisionCount').textContent=integer(decisionCount);document.getElementById('decisionNote').textContent=decisionCount===1?'decision needs attention':'decisions need attention';document.getElementById('attentionCount').textContent=integer(decisionCount);
  renderAttention(data,decisionCount);renderDrivers(data,Number(rolling.sales_t28||0));
  if(window.DPPCharts?.homeRhythm){const cutoff=String(rolling.business_date||'').slice(0,10);const reconciledSeries=(data.series||[]).filter(row=>!cutoff||String(row.business_date||'').slice(0,10)<=cutoff);window.DPPCharts.homeRhythm('#spark',reconciledSeries,data.weekly_products);}
}

async function load(){try{render(await fetchJson('/api/home'));}catch(error){document.getElementById('stateHeadline').textContent='Operating feed unavailable';document.getElementById('stateCopy').textContent=error.message;}}
load();setInterval(load,60_000);
