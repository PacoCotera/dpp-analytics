import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl=(process.argv[2]||'http://127.0.0.1:8088').replace(/\/$/,'');
const outDir=process.argv[3]||'/out';
const failures=[];const checks=[];
function numberFromText(value){const n=Number(String(value||'').replace(/−/g,'-').replace(/[^0-9.\-]/g,''));return Number.isFinite(n)?n:null;}
function check(name,ok,detail=''){checks.push({name,ok,detail});if(!ok)failures.push(`${name}${detail?`: ${detail}`:''}`);}
async function api(page,url){return page.evaluate(async endpoint=>{const r=await fetch(endpoint,{cache:'no-store'});const b=await r.json();if(!r.ok)throw new Error(`${endpoint} HTTP ${r.status}: ${b.error||'error'}`);return b;},url);}

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
    const state=(await page.locator('#adsState').textContent())||'';
    const decision=(await page.locator('#adsDecision').textContent())||'';
    const read=(await page.locator('#adsRead').textContent())||'';
    if(ads.through_date&&Number(ads.observed_ads_days||0)>0){
      check('Product Ads state reflects trust contract',state.includes(ads.trusted_for_operating_decisions?'Decision-grade':'Review'),state);
      check('Product Ads decision uses canonical spend',Math.abs((numberFromText(decision)||0)-Math.round(Number(ads.spend||0)))<=1,decision);
      check('Product Ads decision exposes TACOS',decision.includes('TACOS'),decision);
      check('Product Ads decision exposes ROAS',decision.includes('ROAS'),decision);
      check('Product Ads interpretation rejects residual-organic claim',read.includes('not exact organic sales'),read);
      check('Product Ads interpretation names attribution',read.includes('Amazon-attributed sales'),read);
    }else{
      check('Product empty Ads state is explicit',state.includes('No Ads data'),state);
      check('Product empty Ads state avoids fake zero efficiency',decision.includes('pending'),decision);
    }
  }else{
    check('Catalog supplies a sellable SKU for Product Ads QA',false,'no sellable SKU');
  }
}catch(error){failures.push(`Ads surface QA: ${error.message}`);}finally{await context.close();await browser.close();}
const summary={generatedAt:new Date().toISOString(),baseUrl,status:failures.length?'FAIL':'PASS',checks,failures};
await fs.mkdir(outDir,{recursive:true});
await fs.writeFile(path.join(outDir,'ads-surface-summary.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify({status:summary.status,checks:checks.length,failures},null,2));
if(failures.length)process.exitCode=3;
