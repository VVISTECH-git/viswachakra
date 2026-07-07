// Diagnostic: open specific cases by Case No and inspect the Claim tab
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { chromium } = require('playwright');

const BASE = 'https://app.drntrvaidyaseva.ap.gov.in/ASRI';
const CASES = process.argv.slice(2).filter((a) => a.startsWith('CASE'));

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  context.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})));

  const login = await context.newPage();
  login.on('dialog', (d) => d.accept().catch(() => {}));
  await login.goto(process.env.LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await login.locator('input[type="text"]:visible').first().fill(process.env.VAIDYA_USERNAME);
  await login.locator('input[type="password"]:visible').first().fill(process.env.VAIDYA_PASSWORD);
  await login.locator('button:has-text("Login"), input[value="Login"]').first().click();
  await login.waitForTimeout(6000);

  let page = null;
  for (const p of context.pages()) {
    const b = (await p.textContent('body').catch(() => '')) || '';
    if (/Welcome/i.test(b) && /Signout/i.test(b)) { page = p; break; }
  }
  page.on('dialog', (d) => d.accept().catch(() => {}));
  console.log('Logged in.\n');

  for (const caseNo of CASES) {
    console.log('===== ' + caseNo + ' =====');
    await page.goto(BASE + '/authUserViewAction.do?actionVal=CasesSearchView&PersistFlag=N&procType=IP', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const fieldSet = await page.evaluate((cn) => {
      const f = document.getElementById('CaseNo');
      if (!f) return 'no CaseNo field';
      f.value = cn;
      return 'set to ' + f.value;
    }, caseNo);
    console.log('  CaseNo field:', fieldSet);
    await page.evaluate(() => { if (typeof fnSearch === 'function') fnSearch(); });
    await page.waitForTimeout(8000);

    const results = await page.evaluate(() => {
      const m = (document.body.textContent || '').match(/Results\s+\d+\s*-\s*\d+\s+of\s+(\d+)|No\s+records/i);
      const links = Array.from(document.querySelectorAll('a')).filter((a) => /^CASE\//i.test((a.textContent || '').trim())).map((a) => (a.textContent || '').trim());
      return { summary: m ? m[0] : '(no results text)', caseLinks: links.slice(0, 5) };
    });
    console.log('  search result:', results.summary, '| case links:', JSON.stringify(results.caseLinks));

    // open the case
    const opened = await page.locator(`a:has-text("${caseNo}")`).first().click().then(() => true).catch(() => false);
    if (!opened) { console.log('  could not open case link\n'); continue; }
    await page.waitForTimeout(4000);

    // dump tab-like elements
    const info = await page.evaluate(() => {
      const isVis = (el) => !!(el.offsetWidth || el.offsetHeight);
      const claimExact = Array.from(document.querySelectorAll('a, td, li, span, div'))
        .filter((el) => (el.textContent || '').trim() === 'Claim' && isVis(el))
        .map((el) => ({ tag: el.tagName, html: el.outerHTML.slice(0, 120) }));
      const claimish = Array.from(document.querySelectorAll('a, td, li'))
        .filter((el) => /claim/i.test((el.textContent || '').trim()) && (el.textContent || '').trim().length < 25 && isVis(el))
        .map((el) => ({ tag: el.tagName, text: (el.textContent || '').trim(), onclick: el.getAttribute('onclick') || (el.getAttribute('href') || '').slice(0, 60) }));
      return { bodyLen: document.body.innerHTML.length, claimExactCount: claimExact.length, claimExact, claimish };
    });
    console.log('  body len:', info.bodyLen, '| exact "Claim" matches:', info.claimExactCount);
    console.log('  claim-like tabs:', JSON.stringify(info.claimish));

    // try clicking Claim and see if the workflow table appears
    await page.evaluate(() => {
      const isVis = (el) => !!(el.offsetWidth || el.offsetHeight);
      const els = Array.from(document.querySelectorAll('a, td, li, span, div')).filter((el) => (el.textContent || '').trim() === 'Claim' && isVis(el));
      if (els.length) els[els.length - 1].click();
    });
    await page.waitForTimeout(5000);
    const wf = await page.evaluate(() => {
      const tables = Array.from(document.querySelectorAll('table')).filter((t) => t.rows && t.rows[0] && /Date\s*&\s*Time/i.test(t.rows[0].textContent || ''));
      return { workflowTables: tables.length, rowCount: tables.length ? tables[tables.length - 1].rows.length - 1 : 0 };
    });
    console.log('  after Claim click -> workflow tables:', wf.workflowTables, '| rows:', wf.rowCount, '\n');
  }

  console.log('Done. Leaving browser open 8s...');
  await page.waitForTimeout(8000);
  await browser.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
