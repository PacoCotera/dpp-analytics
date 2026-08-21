import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl=(process.argv[2]||'http://127.0.0.1:8088').replace(/\/$/,'');
const outDir=process.argv[3]||'/out';
await fs.mkdir(outDir,{recursive:true});
const browser=await chromium.launch({headless:true});
const cases=[
  {name:'home-desktop',url:'/',width:1600,height:1000,active:'Home',visiblePrimary:['Today','Home','Sales','Products','Inventory','Finance'],visibleMore:['Trajectory','Ads','Data Health']},
  {name:'product-mobile',url:'/product?sku=PNC-001',width:412,height:915,active:'Products',visiblePrimary:['Today','Home','Sales','Products'],visibleMore:['Inventory','Finance','Trajectory','Ads','Data Health']},
  {name:'trajectory-mobile',url:'/trajectory',width:412,height:915,moreActive:true,visiblePrimary:['Today','Home','Sales','Products'],visibleMore:['Inventory','Finance','Trajectory','Ads','Data Health']},
  {name:'inventory-mobile',url:'/inventory',width:412,height:915,moreActive:true,visiblePrimary:['Today','Home','Sales','Products'],visibleMore:['Inventory','Finance','Trajectory','Ads','Data Health']},
];
const allPrimary=['Today','Home','Sales','Products','Inventory','Finance'];
const results=[];
for(const c of cases){
  const mobile=c.width<700;
  const context=await browser.newContext({viewport:{width:c.width,height:c.height},hasTouch:mobile,isMobile:mobile});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  try{
    const response=await page.goto(baseUrl+c.url,{waitUntil:'networkidle',timeout:20000});if(!response?.ok())throw new Error(`navigation ${response?.status()}`);
    await page.locator('.primary-nav.app-navigation').waitFor({timeout:5000});
    const primary=await page.locator('.nav-primary-set>a').allTextContents();
    if(JSON.stringify(primary)!==JSON.stringify(allPrimary))throw new Error(`primary DOM ${JSON.stringify(primary)}`);
    const visiblePrimary=await page.locator('.nav-primary-set>a:visible').allTextContents();
    if(JSON.stringify(visiblePrimary)!==JSON.stringify(c.visiblePrimary))throw new Error(`visible primary ${JSON.stringify(visiblePrimary)}`);
    if(c.active){const active=(await page.locator('.nav-primary-set>a.active:visible').textContent())?.trim();if(active!==c.active)throw new Error(`active ${active} != ${c.active}`)}
    const more=page.locator('.nav-more');
    if(c.moreActive && !(await more.evaluate(el=>el.classList.contains(mobile?'mobile-active':'active'))))throw new Error('More not marked active for viewport');
    await more.locator('summary').click();
    const moreLabels=(await more.locator('.nav-more-menu>a:visible strong').allTextContents()).map(x=>x.trim());
    if(JSON.stringify(moreLabels)!==JSON.stringify(c.visibleMore))throw new Error(`visible more nav ${JSON.stringify(moreLabels)}`);
    const box=await more.locator('.nav-more-menu').boundingBox();if(!box||box.x<0||box.x+box.width>c.width||box.y<0||box.y+box.height>c.height)throw new Error(`More menu clipped ${JSON.stringify(box)}`);
    const navBox=await page.locator('.primary-nav.app-navigation').boundingBox();
    const primaryBox=await page.locator('.nav-primary-set').boundingBox();
    if(!navBox||!primaryBox||primaryBox.x<navBox.x-1||primaryBox.x+primaryBox.width>navBox.x+navBox.width+1)throw new Error('primary navigation exceeds shell bounds');
    await page.screenshot({path:path.join(outDir,`nav-${c.name}.png`),fullPage:false});
  }catch(e){errors.push(e.message)}
  results.push({...c,errors,ok:errors.length===0});await context.close();
}
await browser.close();
await fs.writeFile(path.join(outDir,'nav-summary.json'),JSON.stringify({baseUrl,results},null,2));
console.log(JSON.stringify({navigationQA:results.map(x=>({name:x.name,ok:x.ok,errors:x.errors}))},null,2));
if(results.some(x=>!x.ok))process.exitCode=3;
