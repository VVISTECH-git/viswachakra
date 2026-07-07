// One-off diagnostic: login, open Cases Search, open date panel, dump structure
require('dotenv').config();
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'https://app.drntrvaidyaseva.ap.gov.in/ASRI';

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  context.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})));

  const page = await context.newPage();
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(process.env.LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.locator('input[type="text"]:visible').first().fill(process.env.VAIDYA_USERNAME);
  await page.locator('input[type="password"]:visible').first().fill(process.env.VAIDYA_PASSWORD);
  await page.locator('button:has-text("Login"), input[value="Login"]').first().click();
  await page.waitForTimeout(8000);

  let dash = null;
  for (const p of context.pages()) {
    const body = (await p.textContent('body').catch(() => '')) || '';
    if (/Welcome/i.test(body)) { dash = p; break; }
  }
  if (!dash) throw new Error('no dashboard window');

  await dash.goto(BASE + '/authUserViewAction.do?actionVal=CasesSearchView&PersistFlag=N&procType=IP', { waitUntil: 'domcontentloaded' });
  await dash.waitForTimeout(2500);
  await dash.evaluate(() => { if (typeof showSearch === 'function') showSearch(); });
  await dash.waitForTimeout(2000);

  console.log('URL:', dash.url());
  console.log('FRAMES:', dash.frames().map((f) => f.url()));

  const info = await dash.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input')).map((i) => ({
      type: i.type, name: i.name, id: i.id, value: (i.value || '').slice(0, 30),
      visible: !!(i.offsetWidth || i.offsetHeight),
    }));
    const statusEls = Array.from(document.querySelectorAll('*'))
      .filter((el) => /Status Date/i.test(el.textContent || '') && el.children.length === 0)
      .map((el) => ({ tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60),
                      parentHtml: (el.parentElement ? el.parentElement.outerHTML : '').slice(0, 500) }));
    return { inputCount: inputs.length, inputs: inputs.filter((i) => i.type === 'text' || !i.type), statusEls };
  });
  fs.writeFileSync(path.join(__dirname, 'debug', 'inspect.json'), JSON.stringify(info, null, 2));
  console.log('Status Date elements found:', info.statusEls.length);
  console.log('Text inputs:', info.inputs.length);
  console.log('Wrote debug/inspect.json');

  await browser.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
