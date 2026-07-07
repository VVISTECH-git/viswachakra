require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');
const BASE = 'https://app.drntrvaidyaseva.ap.gov.in/ASRI';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  ctx.on('page', (p) => p.on('dialog', (d) => d.accept().catch(()=>{})));
  const lp = await ctx.newPage();
  lp.on('dialog', (d) => d.accept().catch(()=>{}));
  await lp.goto(process.env.LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await lp.locator('input[type="text"]:visible').first().fill(process.env.VAIDYA_USERNAME);
  await lp.locator('input[type="password"]:visible').first().fill(process.env.VAIDYA_PASSWORD);
  await lp.locator('button:has-text("Login"), input[value="Login"]').first().click();
  await lp.waitForTimeout(6000);
  let page=null; for (const p of ctx.pages()){const b=(await p.textContent('body').catch(()=>''))||'';if(/Welcome/i.test(b)&&/Signout/i.test(b)){page=p;break;}}
  page.on('dialog',(d)=>d.accept().catch(()=>{}));
  // read the CaseNo field title/hint
  await page.goto(BASE + '/authUserViewAction.do?actionVal=CasesSearchView&PersistFlag=N&procType=IP', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const hint = await page.evaluate(()=>{const f=document.getElementById('CaseNo');return f?{title:f.title,maxlength:f.maxLength,onblur:f.getAttribute('onblur')}:'no field';});
  console.log('CaseNo field hint:', JSON.stringify(hint));
  for (const fmt of ['AP12287160','12287160','5722/AP12287160']) {
    await page.goto(BASE + '/authUserViewAction.do?actionVal=CasesSearchView&PersistFlag=N&procType=IP', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    await page.evaluate((v)=>{document.getElementById('CaseNo').value=v;},fmt);
    await page.evaluate(()=>{if(typeof fnSearch==='function')fnSearch();});
    await page.waitForTimeout(6000);
    const res = await page.evaluate(()=>{const m=(document.body.textContent||'').match(/Results\s+\d+\s*-\s*\d+\s+of\s+(\d+)|No\s+Records/i);return m?m[0]:'(none)';});
    console.log('  format "'+fmt+'" ->', res);
  }
  await browser.close();
})().catch(e=>{console.error(e.message);process.exit(1);});
