import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = (process.argv[2] || 'http://127.0.0.1:8088').replace(/\/$/, '');
const outDir = process.argv[3] || '/out';

const viewports = {
  mobile: { width: 412, height: 915, isMobile: true, hasTouch: true, deviceScaleFactor: 1 },
  tablet: { width: 1024, height: 768, isMobile: false, hasTouch: true, deviceScaleFactor: 1 },
  desktop: { width: 1600, height: 1000, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
};

async function verifyAds(page, view = 'overview') {
  const status = await page.evaluate(async () => {
    const response = await fetch('/api/ads', { cache: 'no-store' });
    return (await response.json()).status;
  });
  if (status !== 'ready') {
    await page.locator('#emptyState').waitFor({ state: 'visible', timeout: 5000 });
    return;
  }
  if (view === 'campaigns') {
    await page.locator('button[data-view="campaigns"]').click();
    await page.locator('#campaignQuadrant .dpp-bubble').first().waitFor({ timeout: 5000 });
    return;
  }
  await page.locator('#chart .dpp-bar').first().waitFor({ timeout: 5000 });
}

async function verifySalesOverview(page) {
  await page.locator('#monthChart .dpp-bar').first().waitFor({ timeout: 5000 });
  await page.locator('button[data-range="90d"]').click();
  await page.locator('#monthChart .sales-week').first().waitFor({ timeout: 5000 });
  await page.locator('button[data-range="28d"]').click();
  await page.locator('#monthChart .sales-day').first().waitFor({ timeout: 5000 });
  await page.locator('button[data-range="full"]').click();
  await page.locator('#monthChart .sales-month').first().waitFor({ timeout: 5000 });
  await page.locator('button[data-range="12m"]').click();
}

async function catalogSemantic(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/catalog', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) return { errors: [`catalog API ${response.status}`] };
    const errors = [];
    const close = (a, b, tolerance = 0.02) => Math.abs(Number(a || 0) - Number(b || 0)) <= tolerance;
    for (const family of data.families || []) {
      const members = (family.members || []).filter(x => ['SELLABLE_VARIATION', 'SELLABLE_STANDALONE'].includes(x.product_role));
      if (!members.length) continue;
      const sales = members.reduce((n, x) => n + Number(x.sales_t28 || 0), 0);
      const units = members.reduce((n, x) => n + Number(x.units_t28 || 0), 0);
      const sessions = members.reduce((n, x) => n + Number(x.sessions_t28 || 0), 0);
      const available = members.reduce((n, x) => n + Number(x.available || 0), 0);
      const inbound = members.reduce((n, x) => n + Number(x.inbound || 0), 0);
      if (!close(family.sales_t28, sales)) errors.push(`${family.family_asin}: family sales != child rollup`);
      if (Number(family.units_t28 || 0) !== units) errors.push(`${family.family_asin}: family units != child rollup`);
      if (Number(family.sessions_t28 || 0) !== sessions) errors.push(`${family.family_asin}: family sessions != child rollup`);
      if (Number(family.available || 0) !== available || Number(family.inbound || 0) !== inbound) errors.push(`${family.family_asin}: family inventory != child rollup`);
      const expectedCvr = sessions > 0 ? Math.round((10000 * units / sessions)) / 100 : null;
      if (expectedCvr === null ? family.conversion_t28_pct != null : !close(family.conversion_t28_pct, expectedCvr)) errors.push(`${family.family_asin}: family CVR not recomputed from units/sessions`);
      if (family.parent && family.primary_state === 'STRUCTURAL_PARENT') errors.push(`${family.family_asin}: structural parent incorrectly used as family diagnosis`);
      if ((family.members || []).some(x => x.product_role === 'STRUCTURAL_PARENT')) errors.push(`${family.family_asin}: structural parent leaked into sellable members`);
    }
    const dimensions = Object.keys(data.dimensions || {});
    if ((data.summary?.amazon_dimension_coverage || 0) > 0 && !dimensions.length) errors.push('Amazon variation metadata exists but dimensional rollups are empty');
    for (const [dimension, rows] of Object.entries(data.dimensions || {})) {
      for (const row of rows || []) {
        const expected = Number(row.sessions_t28 || 0) > 0 ? Math.round(10000 * Number(row.units_t28 || 0) / Number(row.sessions_t28 || 0)) / 100 : null;
        if (expected === null ? row.conversion_t28_pct != null : !close(row.conversion_t28_pct, expected)) errors.push(`${dimension}/${row.value}: dimensional CVR not recomputed from units/sessions`);
      }
    }
    return { errors, familyCount: (data.families || []).length, dimensionNames: dimensions, pairCount: (data.dimension_pairs || []).length };
  });
}

async function verifyCatalog(page) {
  await page.locator('.family').first().waitFor({ timeout: 5000 });
  const semantic = await catalogSemantic(page);
  if (semantic.errors?.length) throw new Error(`Catalog semantic QA: ${semantic.errors.join('; ')}`);
  const openCount = await page.locator('.family[open]').count();
  if (openCount !== 0) throw new Error(`Catalog default comparison view has ${openCount} family expansions open`);
}

async function verifyCatalogMode(page, mode) {
  await page.locator('.family').first().waitFor({ timeout: 5000 });
  const semantic = await catalogSemantic(page);
  if (semantic.errors?.length) throw new Error(`Catalog semantic QA: ${semantic.errors.join('; ')}`);
  if (mode.startsWith('dimension:')) {
    const dimension = mode.split(':')[1];
    if (!semantic.dimensionNames?.includes(dimension)) throw new Error(`Catalog dimension ${dimension} unavailable in production data`);
  }
  if (mode === 'pair' && !semantic.pairCount) throw new Error('Catalog variation-combination rollups unavailable in production data');
  const button = page.locator(`button[data-mode="${mode}"]`);
  await button.waitFor({ state: 'visible', timeout: 5000 });
  await button.click();
  await page.locator('.analysis-row').first().waitFor({ timeout: 5000 });
}

async function verifyFinanceReport(page) {
  await page.locator('#currentLines .line').first().waitFor({ timeout: 5000 });
  await page.locator('#currentBridge .bridge-step').first().waitFor({ timeout: 5000 });
  await page.locator('#ytdBridge .bridge-step').first().waitFor({ timeout: 5000 });
  await page.locator('#progression .month-bar:visible').first().waitFor({ timeout: 5000 });
  await page.locator('#history .history-row:visible').first().waitFor({ timeout: 5000 });
}

async function verifyFinanceEvidence(page) {
  await verifyFinanceReport(page);
  const evidence = page.locator('.evidence details').first();
  await evidence.waitFor({ state: 'visible', timeout: 5000 });
  await evidence.locator('summary').click();
  await page.locator('#events .event-row').first().waitFor({ timeout: 5000 });
}

const scenarios = [
  { name: 'today', url: '/today', views: ['mobile', 'desktop'], action: async page => { await page.locator('#rhythm .dpp-bar').first().waitFor({ timeout: 5000 }); await page.locator('#dayPicker .day-choice').first().waitFor({ timeout: 5000 }); } },
  { name: 'today-wall', url: '/today?wall=1', views: ['desktop'] },
  { name: 'home', url: '/', views: ['mobile', 'tablet', 'desktop'] },
  { name: 'sales-overview', url: '/sales', views: ['mobile', 'tablet', 'desktop'], action: verifySalesOverview },
  { name: 'sales-products', url: '/sales', views: ['mobile', 'desktop'], action: async page => { await page.locator('button[data-view="products"]').click(); await page.locator('#skuRows tr').first().waitFor({ timeout: 5000 }); } },
  { name: 'sales-orders', url: '/sales', views: ['mobile', 'desktop'], action: async page => { await page.locator('button[data-view="orders"]').click(); await page.locator('#orderRows tr').first().waitFor({ timeout: 5000 }); } },
  { name: 'catalog', url: '/catalog', views: ['mobile', 'tablet', 'desktop'], action: verifyCatalog },
  { name: 'catalog-design', url: '/catalog', views: ['mobile', 'desktop'], action: async page => verifyCatalogMode(page, 'dimension:design') },
  { name: 'catalog-ruling', url: '/catalog', views: ['mobile', 'desktop'], action: async page => verifyCatalogMode(page, 'dimension:ruling') },
  { name: 'catalog-combinations', url: '/catalog', views: ['mobile', 'desktop'], action: async page => verifyCatalogMode(page, 'pair') },
  { name: 'catalog-sku', url: '/catalog', views: ['mobile', 'desktop'], action: async page => verifyCatalogMode(page, 'sku') },
  { name: 'product-pnc-001', url: '/product?sku=PNC-001', views: ['mobile', 'desktop'] },
  { name: 'inventory', url: '/inventory', views: ['mobile', 'tablet', 'desktop'] },
  { name: 'ads-overview', url: '/ads', views: ['mobile', 'tablet', 'desktop'], action: async page => verifyAds(page) },
  { name: 'ads-campaigns', url: '/ads', views: ['mobile', 'desktop'], action: async page => verifyAds(page, 'campaigns') },
  { name: 'finance-overview', url: '/finance', views: ['mobile', 'desktop'], action: verifyFinanceReport },
  { name: 'finance-closed', url: '/finance', views: ['mobile', 'tablet', 'desktop'], action: verifyFinanceReport },
  { name: 'finance-ledger', url: '/finance', views: ['mobile', 'desktop'], action: verifyFinanceEvidence },
  { name: 'trajectory', url: '/trajectory', views: ['mobile', 'desktop'] },
  { name: 'data-health', url: '/data-health', views: ['mobile', 'desktop'] },
];

await fs.mkdir(outDir, { recursive: true });
for (const entry of await fs.readdir(outDir)) await fs.rm(path.join(outDir, entry), { recursive: true, force: true });

const browser = await chromium.launch({ headless: true });
const results = [];
function safeName(value) { return value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase(); }

for (const scenario of scenarios) {
  for (const viewportName of scenario.views) {
    const viewport = viewports[viewportName];
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.isMobile, hasTouch: viewport.hasTouch, deviceScaleFactor: viewport.deviceScaleFactor });
    const page = await context.newPage();
    const errors = [], warnings = [], failedResponses = [];
    page.on('pageerror', err => errors.push(`pageerror: ${err.message}`));
    page.on('console', msg => { if (msg.type() === 'error') errors.push(`console: ${msg.text()}`); if (msg.type() === 'warning') warnings.push(`console: ${msg.text()}`); });
    page.on('response', async response => { if (response.status() >= 400 && response.url().startsWith(baseUrl)) { let body=''; try { body=(await response.text()).replace(/\s+/g,' ').slice(0,500); } catch {} failedResponses.push(`${response.status()} ${response.request().method()} ${response.url()}${body?` :: ${body}`:''}`); } });
    const result={scenario:scenario.name,viewport:viewportName,width:viewport.width,height:viewport.height,url:`${baseUrl}${scenario.url}`,screenshot:null,metrics:null,errors,warnings,failedResponses,ok:false};
    try {
      const response=await page.goto(result.url,{waitUntil:'domcontentloaded',timeout:20000}); if(!response||!response.ok())throw new Error(`navigation returned ${response?response.status():'no response'}`);
      await page.waitForLoadState('networkidle',{timeout:8000}).catch(()=>{}); await page.waitForTimeout(1000); if(scenario.action){await scenario.action(page);await page.waitForTimeout(500);}
      result.metrics=await page.evaluate(({viewportName})=>{const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&Number(s.opacity||1)>0};const textEls=[...document.querySelectorAll('body *')].filter(el=>visible(el)&&!el.children.length&&(el.textContent||'').trim().length>0);const minFont=viewportName==='mobile'?11.5:viewportName==='tablet'?10.5:9.5;const smallText=textEls.map(el=>({text:(el.textContent||'').trim().replace(/\s+/g,' ').slice(0,80),size:Number.parseFloat(getComputedStyle(el).fontSize||'0'),color:getComputedStyle(el).color})).filter(x=>x.size>0&&x.size<minFont).slice(0,40);const clickables=[...document.querySelectorAll('a,button,[role="button"],input,select,textarea')].filter(visible);const smallTargets=clickables.map(el=>{const r=el.getBoundingClientRect();return{label:((el.getAttribute('aria-label')||el.textContent||el.getAttribute('title')||el.tagName)+'').trim().replace(/\s+/g,' ').slice(0,70),width:Math.round(r.width),height:Math.round(r.height)}}).filter(x=>x.width<36||x.height<36).slice(0,40);const doc=document.documentElement,body=document.body,bodyStyle=getComputedStyle(body),scrollWidth=Math.max(doc.scrollWidth,body.scrollWidth);return{title:document.title,bodyTextLength:(body.innerText||'').length,bodyBackgroundColor:bodyStyle.backgroundColor,bodyBackgroundImage:bodyStyle.backgroundImage,themeColor:document.querySelector('meta[name="theme-color"]')?.content||null,activeTab:document.querySelector('.tabs button.active,.view-tabs button.active,.analysis-modes button.active')?.textContent?.trim()||null,scrollWidth,scrollHeight:Math.max(doc.scrollHeight,body.scrollHeight),horizontalOverflowPx:Math.max(0,scrollWidth-doc.clientWidth),smallTextCount:smallText.length,smallTextExamples:smallText,smallTapTargetCount:smallTargets.length,smallTapTargetExamples:smallTargets};},{viewportName});
      const fileName=`${safeName(scenario.name)}-${viewportName}.png`;await page.screenshot({path:path.join(outDir,fileName),fullPage:true});result.screenshot=fileName;result.ok=errors.length===0&&failedResponses.length===0;
    } catch(err){errors.push(`qa: ${err.message}`);try{const fileName=`${safeName(scenario.name)}-${viewportName}-error.png`;await page.screenshot({path:path.join(outDir,fileName),fullPage:true});result.screenshot=fileName}catch{}}
    results.push(result);await context.close();
  }
}
await browser.close();
const summary={generatedAt:new Date().toISOString(),baseUrl,captures:results.length,successfulCaptures:results.filter(x=>x.ok).length,navigationFailures:results.filter(x=>!x.ok).length,consoleErrorCount:results.reduce((n,x)=>n+x.errors.length,0),failedResponseCount:results.reduce((n,x)=>n+x.failedResponses.length,0),horizontalOverflowCaptures:results.filter(x=>(x.metrics?.horizontalOverflowPx||0)>2).length,smallTextSignals:results.reduce((n,x)=>n+(x.metrics?.smallTextCount||0),0),smallTapTargetSignals:results.reduce((n,x)=>n+(x.metrics?.smallTapTargetCount||0),0),results};
await fs.writeFile(path.join(outDir,'summary.json'),JSON.stringify(summary,null,2));
const lines=['# DPP Visual QA','',`Generated: ${summary.generatedAt}`,`Base URL: ${baseUrl}`,'',`**${summary.successfulCaptures}/${summary.captures} captures succeeded.**`,'','| Screen | Viewport | Active tab | Overflow | Small text | Small tap targets | Browser errors |','|---|---:|---|---:|---:|---:|---:|'];
for(const r of results)lines.push(`| ${r.scenario} | ${r.viewport} ${r.width}×${r.height} | ${r.metrics?.activeTab??'—'} | ${r.metrics?.horizontalOverflowPx??'—'}px | ${r.metrics?.smallTextCount??'—'} | ${r.metrics?.smallTapTargetCount??'—'} | ${r.errors.length} |`);
lines.push('','## Signals','',`- Horizontal overflow: ${summary.horizontalOverflowCaptures} capture(s)`,`- Small-text signals: ${summary.smallTextSignals}`,`- Small tap-target signals: ${summary.smallTapTargetSignals}`,`- Failed local HTTP responses: ${summary.failedResponseCount}`,`- Browser/page errors: ${summary.consoleErrorCount}`);const failures=results.flatMap(r=>r.failedResponses.map(x=>`${r.scenario}/${r.viewport}: ${x}`));if(failures.length)lines.push('','## Failed local responses','',...failures.map(x=>`- ${x}`));lines.push('','_Theme/background values and active tab are recorded in summary.json. Screenshots remain the source of truth for visual judgment._','');await fs.writeFile(path.join(outDir,'report.md'),lines.join('\n'));
console.log(JSON.stringify({captures:summary.captures,successful:summary.successfulCaptures,navigationFailures:summary.navigationFailures,overflowCaptures:summary.horizontalOverflowCaptures,smallTextSignals:summary.smallTextSignals,smallTapTargetSignals:summary.smallTapTargetSignals,failedResponses:summary.failedResponseCount,browserErrors:summary.consoleErrorCount},null,2));
if(summary.navigationFailures>0||summary.consoleErrorCount>0||summary.failedResponseCount>0)process.exitCode=2;