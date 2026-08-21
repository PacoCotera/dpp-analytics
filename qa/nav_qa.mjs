import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl=(process.argv[2]||'http://127.0.0.1:8088').replace(/\/$/,'');
const outDir=process.argv[3]||'/out';
await fs.mkdir(outDir,{recursive:true});
const browser=await chromium.launch({headless:true});
const cases=[
  {name:'home-desktop',url:'/',width:1600,height:1000,active:'Home'},
  {name:'product-mobile',url:'/product?sku=PNC-001',width:412,height:915,active:'Products'},
  {name:'trajectory-mobile',url:'/trajectory',width:412,height:915,moreActive:true},
];
const expectedPrimary=['Today','Home','Sales','Products','Inventory','Finance'];
const expectedMore=['Trajectory','Ads','Data Health'];
const results=[];
for(const c of cases){
  const context=await browser.newContext({viewport:{width:c.width,height:c.height},hasTouch:c.width<700,isMobile:c.width<700});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  try{
    const response=await page.goto(baseUrl+c.url,{waitUntil:'networkidle',timeout:20000});if(!response?.ok())throw new Error(`navigation ${response?.status()}`);
    await page.locator('.primary-nav.app-navigation').waitFor({timeout:5000});
    const primary=await page.locator('.nav-primary-set>a').allTextContents();
    if(JSON.stringify(primary)!==JSON.stringify(expectedPrimary))throw new Error(`primary nav ${JSON.stringify(primary)}`);
    if(c.active){const active=(await page.locator('.nav-primary-set>a.active').textContent())?.trim();if(active!==c.active)throw new Error(`active ${active} != ${c.active}`)}
    const more=page.locator('.nav-more');if(c.moreActive && !(await more.evaluate(el=>el.classList.contains('active'))))throw new Error('More not marked active');
    await more.locator('summary').click();
    const moreLabels=(await more.locator('.nav-more-menu>a strong').allTextContents()).map(x=>x.trim());
    if(JSON.stringify(moreLabels)!==JSON.stringify(expectedMore))throw new Error(`more nav ${JSON.stringify(moreLabels)}`);
    const box=await more.locator('.nav-more-menu').boundingBox();if(!box||box.x<0||box.x+box.width>c.width||box.y<0||box.y+box.height>c.height)throw new Error(`More menu clipped ${JSON.stringify(box)}`);
    await page.screenshot({path:path.join(outDir,`nav-${c.name}.png`),fullPage:false});
  }catch(e){errors.push(e.message)}
  results.push({...c,errors,ok:errors.length===0});await context.close();
}
await browser.close();
await fs.writeFile(path.join(outDir,'nav-summary.json'),JSON.stringify({baseUrl,results},null,2));
console.log(JSON.stringify({navigationQA:results.map(x=>({name:x.name,ok:x.ok,errors:x.errors}))},null,2));
if(results.some(x=>!x.ok))process.exitCode=3;
