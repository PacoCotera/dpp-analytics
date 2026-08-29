import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl=(process.argv[2]||'http://127.0.0.1:8088').replace(/\/$/,'');
const outDir=process.argv[3]||'/out';
const failures=[];const checks=[];
const connectionStates=['NOT_CONNECTED','AUTHORIZATION_PENDING','BACKFILL_RUNNING','READY','FAILED'];
function numberFromText(value){const n=Number(String(value||'').replace(/−/g,'-').replace(/[^0-9.\-]/g,''));return Number.isFinite(n)?n:null;}
function moneyForQa(value){return `$${Math.round(Number(value||0)).toLocaleString('en-US')}`;}
function check(name,ok,detail=''){checks.push({name,ok,detail});if(!ok)failures.push(`${name}${detail?`: ${detail}`:''}`);}
async function api(page,url){return page.evaluate(async endpoint=>{const r=await fetch(endpoint,{cache:'no-store'});const b=await r.json();if(!r.ok)throw new Error(`${endpoint} HTTP ${r.status}: ${b.error||'error'}`);return b;},url);}
async function chartAssetState(page){return page.evaluate(()=>({
  paths:performance.getEntriesByType('resource').map(entry=>new URL(entry.name).pathname).filter(resourcePath=>['/assets/chart-system.css','/assets/vendor/d3.v7.min.js','/assets/chart-system.js'].includes(resourcePath)),
  revisions:performance.getEntriesByType('resource').map(entry=>new URL(entry.name)).filter(url=>['/assets/chart-system.css','/assets/vendor/d3.v7.min.js','/assets/chart-system.js'].includes(url.pathname)).map(url=>url.searchParams.get('v')),
  pageRevision:document.querySelector('meta[name="dpp-asset-revision"]')?.content||'',
  runtime:Boolean(window.DPPCharts),
  dependencyNodes:document.querySelectorAll('[data-ads-chart-dependency]').length,
}));}

const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
page.on('pageerror',error=>failures.push(`pageerror: ${error.message}`));
try{
  await page.goto(`${baseUrl}/catalog`,{waitUntil:'domcontentloaded',timeout:20000});
  const catalog=await api(page,'/api/catalog');
  await page.waitForTimeout(1200);
  const basis=await page.locator('#portfolioBasis').textContent();
  check('Catalog exposes paid-support context',String(basis||'').includes('Paid support'),String(basis||''));
  const summary=catalog.summary||{};
  if(Number(summary.ad_spend_t28||0)>0){
    check('Catalog paid-support summary uses canonical spend',Math.abs((numberFromText(String(basis).split('Paid support')[1])||0)-Math.round(Number(summary.ad_spend_t28)))<=1,String(basis||''));
    check('Catalog paid-support summary exposes TACOS',String(basis||'').includes('TACOS'),String(basis||''));
    check('Catalog paid-support summary exposes attributed ROAS',String(basis||'').includes('attributed ROAS'),String(basis||''));
  }else{
    check('Catalog empty Ads state is explicit',String(basis||'').includes('awaiting Amazon Ads data'),String(basis||''));
  }

  const product=(catalog.products||[]).find(row=>['SELLABLE_VARIATION','SELLABLE_STANDALONE'].includes(row.product_role)&&row.sku);
  if(product){
    await page.goto(`${baseUrl}/product?sku=${encodeURIComponent(product.sku)}`,{waitUntil:'domcontentloaded',timeout:20000});
    const payload=await api(page,`/api/product?sku=${encodeURIComponent(product.sku)}`);
    await page.waitForTimeout(1200);
    const ads=payload.ads||{};
    const connection=ads.connection||{};
    const state=(await page.locator('#adsState').textContent())||'';
    const decision=(await page.locator('#adsDecision').textContent())||'';
    const read=(await page.locator('#adsRead').textContent())||'';
    check('Product API exposes an explicit Ads connection state',connectionStates.includes(connection.state),connection.state||'missing');
    check('Product Ads badge derives from connection state',state.trim()===connection.badge,state);
    check('Product Ads headline derives from connection state',decision.trim()===connection.headline,decision);
    check('Product Ads detail derives from connection state',read.trim().startsWith(connection.detail||'missing connection detail'),read);
    if(connection.state==='READY'&&ads.through_date&&Number(ads.observed_ads_days||0)>0){
      check('Product Ads read uses canonical spend',read.includes(moneyForQa(ads.spend)),read);
      check('Product Ads read exposes TACOS',read.includes('TACOS'),read);
      check('Product Ads read exposes ROAS',read.includes('ROAS'),read);
      check('Product Ads interpretation rejects residual-organic claim',read.includes('not exact organic sales'),read);
      check('Product Ads interpretation names attribution',read.includes('Amazon-attributed sales'),read);
    }else{
      check('Product unavailable Ads state avoids fake zero efficiency',!read.includes('0.00× ROAS')&&!read.includes('$0.00 spend'),read);
    }

    await page.goto(`${baseUrl}/ads`,{waitUntil:'domcontentloaded',timeout:20000});
    const adsPayload=await api(page,'/api/ads');
    await page.waitForTimeout(700);
    const adsConnection=adsPayload.connection||{};
    const chartState=await chartAssetState(page);
    check('Ads and Product APIs use the same connection state',adsConnection.state===connection.state,`${adsConnection.state} / ${connection.state}`);
    check('Ads and Product APIs use the same headline',adsConnection.headline===connection.headline,`${adsConnection.headline} / ${connection.headline}`);
    check('Ads and Product APIs use the same detail',adsConnection.detail===connection.detail,`${adsConnection.detail} / ${connection.detail}`);
    if(adsConnection.state!=='READY'||adsPayload.status!=='ready'){
      const adsHeadline=((await page.locator('#emptyState h2').textContent())||'').trim();
      const adsDetail=((await page.locator('#emptyState p').textContent())||'').trim();
      const unavailableTabs=await page.locator('[data-ads-view]:not([data-ads-view="overview"])').evaluateAll(tabs=>tabs.map(tab=>({disabled:tab.disabled,ariaDisabled:tab.getAttribute('aria-disabled')})));
      const availability=((await page.locator('#adsViewAvailability').textContent())||'').trim();
      check('Ads empty headline derives from connection state',adsHeadline===adsConnection.headline,adsHeadline);
      check('Ads empty detail derives from connection state',adsDetail===adsConnection.detail,adsDetail);
      check('Ads unavailable drill-down tabs are disabled',unavailableTabs.every(tab=>tab.disabled&&tab.ariaDisabled==='true'),JSON.stringify(unavailableTabs));
      check('Ads unavailable drill-down state is explained once',availability==='Only Overview is available in the current Advertising connection state.'&&!availability.includes(adsConnection.detail),availability);
      check('Ads empty state skips every chart dependency',chartState.paths.length===0,chartState.paths.join(', '));
      check('Ads empty state does not initialize chart runtime',!chartState.runtime,String(chartState.runtime));
    }else{
      const actionReasons=await page.locator('#actionQueue .ads-action-body p').allTextContents();
      const apiReasons=(adsPayload.actions||[]).map(action=>String(action.reason||''));
      const enabledTabs=await page.locator('[data-ads-view]').evaluateAll(tabs=>tabs.every(tab=>!tab.disabled&&tab.getAttribute('aria-disabled')==='false'));
      check('Ads ready state loads every chart dependency',new Set(chartState.paths).size===3,chartState.paths.join(', '));
      check('Ads ready chart dependencies retain the page revision',chartState.revisions.every(revision=>revision===chartState.pageRevision),chartState.revisions.join(', '));
      check('Ads ready state initializes chart runtime',chartState.runtime,String(chartState.runtime));
      check('Ads ready drill-down tabs are enabled',enabledTabs,String(enabledTabs));
      check('Ads operating queue renders only API reasons',JSON.stringify(actionReasons)===JSON.stringify(apiReasons),JSON.stringify({actionReasons,apiReasons}));
    }
  }else{
    check('Catalog supplies a sellable SKU for Product Ads QA',false,'no sellable SKU');
  }

  const readyContext=await browser.newContext({viewport:{width:1440,height:1000}});
  const readyPage=await readyContext.newPage();
  try{
    await readyPage.route('**/api/ads',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      status:'ready',local_time:'2026-08-28T08:00:00-06:00',
      connection:{state:'READY',badge:'Ads ready',headline:'Advertising data is ready.',detail:'Reporting is available.'},
      freshness:{through_date:'2026-08-27',period_observed_days:28,period_expected_days:28,mature_days:28},
      quality:{state:'HEALTHY',trusted_for_operating_decisions:true,issue_days:0,issues:[]},
      summary:{spend:30,attributed_sales:90,total_business_sales:300,acos:1/3,tacos:.1,roas:3,ctr:.02,cpc:2,period_start:'2026-08-26',period_end:'2026-08-27'},
      daily:[{business_date:'2026-08-26',spend:10,attributed_sales:30},{business_date:'2026-08-27',spend:20,attributed_sales:60}],
      campaigns:[{campaign_id:'one',campaign_name:'One',spend:10,attributed_sales:20,clicks:5},{campaign_id:'two',campaign_name:'Two',spend:20,attributed_sales:70,clicks:10}],
      products:[],
      targets:[{target_id:'target-1',target_expression:'notebook',campaign_id:'one',campaign_name:'One',purchases:0,spend:12,attributed_sales:0,acos:null,roas:0,clicks:9}],
      search_terms:[{search_term:'lined journal',campaign_id:'one',campaign_name:'One',purchases:2,spend:10,attributed_sales:30,acos:1/3,roas:3,clicks:5}],
      actions:[{kind:'INSPECT_TARGET_SPEND',priority:2,label:'Review target',title:'notebook',context:'One',spend:12,roas:0,reason:'API-owned review reason.'}],
    })}));
    await readyPage.goto(`${baseUrl}/ads`,{waitUntil:'domcontentloaded',timeout:20000});
    await readyPage.waitForFunction(()=>Boolean(window.DPPCharts)&&document.querySelectorAll('#chart .dpp-bar').length===4,null,{timeout:10000});
    const readyChartState=await chartAssetState(readyPage);
    check('Chart-bearing state loads every dependency on demand',new Set(readyChartState.paths).size===3,readyChartState.paths.join(', '));
    check('Chart-bearing state retains one asset revision',readyChartState.revisions.every(revision=>revision===readyChartState.pageRevision),readyChartState.revisions.join(', '));
    check('Chart-bearing state marks three dynamic dependency nodes',readyChartState.dependencyNodes===3,String(readyChartState.dependencyNodes));
    check('Chart-bearing state renders after dependency load',await readyPage.locator('#readyState').isVisible(),String(await readyPage.locator('#readyState').isVisible()));
    check('Ready tabs expose all report grains',await readyPage.locator('[data-ads-view]').evaluateAll(tabs=>tabs.every(tab=>!tab.disabled&&tab.getAttribute('aria-disabled')==='false')));
    check('Ready operating queue uses the API reason',((await readyPage.locator('#actionQueue .ads-action-body p').textContent())||'').trim()==='API-owned review reason.');
    await readyPage.locator('[data-ads-view="targets"]').click();
    check('Target evidence reports purchases without a browser action label',(await readyPage.locator('#targetRows').textContent()).includes('0')&&await readyPage.locator('#targetRows .ads-action').count()===0);
    await readyPage.locator('[data-ads-view="searchTerms"]').click();
    check('Search-term evidence reports purchases without a browser action label',(await readyPage.locator('#searchTermRows').textContent()).includes('2')&&await readyPage.locator('#searchTermRows .ads-action').count()===0);
  }finally{
    await readyContext.close();
  }

  const disconnectedContext=await browser.newContext({viewport:{width:412,height:915},isMobile:true,hasTouch:true});
  const disconnectedPage=await disconnectedContext.newPage();
  try{
    await disconnectedPage.route('**/api/ads',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({
      status:'not_initialized',local_time:'2026-08-28T08:00:00-06:00',
      connection:{state:'NOT_CONNECTED',badge:'Ads not connected',headline:'Amazon Ads is not connected.',detail:'Connect Amazon Ads before paid-support reporting can start.'},
      freshness:null,quality:{state:'NO_DATA',trusted_for_operating_decisions:false,issues:[]},summary:{},daily:[],campaigns:[],products:[],targets:[],search_terms:[],actions:[],
    })}));
    await disconnectedPage.goto(`${baseUrl}/ads`,{waitUntil:'networkidle',timeout:20000});
    const tabs=await disconnectedPage.locator('[data-ads-view]').evaluateAll(items=>items.map(item=>({view:item.dataset.adsView,disabled:item.disabled,ariaDisabled:item.getAttribute('aria-disabled')})));
    const disconnectedChartState=await chartAssetState(disconnectedPage);
    check('Deterministic disconnected Ads keeps Overview enabled',tabs[0]?.view==='overview'&&!tabs[0].disabled&&tabs[0].ariaDisabled==='false',JSON.stringify(tabs));
    check('Deterministic disconnected Ads disables every drill-down',tabs.slice(1).every(tab=>tab.disabled&&tab.ariaDisabled==='true'),JSON.stringify(tabs));
    const disconnectedAvailability=((await disconnectedPage.locator('#adsViewAvailability').textContent())||'').trim();
    check('Deterministic disconnected Ads explains disabled views once',disconnectedAvailability==='Only Overview is available in the current Advertising connection state.'&&!disconnectedAvailability.includes('Connect Amazon Ads'),disconnectedAvailability);
    check('Deterministic disconnected Ads contains mobile tabs',await disconnectedPage.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth+2));
    check('Deterministic disconnected Ads remains chart-free',disconnectedChartState.paths.length===0&&disconnectedChartState.dependencyNodes===0,JSON.stringify(disconnectedChartState));
  }finally{
    await disconnectedContext.close();
  }
}catch(error){failures.push(`Ads surface QA: ${error.message}`);}finally{await context.close();await browser.close();}
const summary={generatedAt:new Date().toISOString(),baseUrl,status:failures.length?'FAIL':'PASS',checks,failures};
await fs.mkdir(outDir,{recursive:true});
await fs.writeFile(path.join(outDir,'ads-surface-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({status:summary.status,checks:checks.length,failures},null,2));
if(failures.length)process.exitCode=3;
