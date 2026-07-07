// Reachability test: can a REMOTE (cloud/datacenter) IP log in and run one search?
// Reads credentials from env vars (LOGIN_URL, VAIDYA_USERNAME, VAIDYA_PASSWORD).
// Prints a clear PASS/FAIL and exits accordingly. Stores nothing.
const { chromium } = require('playwright');

const BASE = 'https://app.drntrvaidyaseva.ap.gov.in/ASRI';
const LOGIN_URL = process.env.LOGIN_URL || BASE + '/';

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function main() {
  const user = process.env.VAIDYA_USERNAME;
  const pass = process.env.VAIDYA_PASSWORD;
  if (!user || !pass) { console.error('FAIL: set VAIDYA_USERNAME and VAIDYA_PASSWORD env vars'); process.exit(2); }

  console.log('Public IP of this runner:');
  console.log('----');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  context.on('page', (p) => p.on('dialog', (d) => d.accept().catch(() => {})));

  try {
    // 1) can we even load the login page?
    const page = await context.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    console.log('[1/3] Loading login page...');
    const resp = await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('      HTTP status:', resp ? resp.status() : '(none)');
    const hasForm = await page.locator('input[type="password"]:visible').count();
    if (!hasForm) { console.error('FAIL: login form not found - page may be blocked or changed'); process.exit(1); }
    console.log('      login form present: OK');

    // 2) can we log in?
    console.log('[2/3] Logging in...');
    await page.locator('input[type="text"]:visible').first().fill(user);
    await page.locator('input[type="password"]:visible').first().fill(pass);
    await page.locator('button:has-text("Login"), input[value="Login"]').first().click();
    await page.waitForTimeout(6000);

    let dash = null;
    for (let a = 0; a < 4 && !dash; a++) {
      for (const p of context.pages()) {
        const b = (await p.textContent('body').catch(() => '')) || '';
        if (/Welcome/i.test(b) && /Signout/i.test(b)) { dash = p; break; }
      }
      if (!dash) await page.waitForTimeout(3000);
    }
    if (!dash) { console.error('FAIL: login did not reach the dashboard (blocked, wrong creds, or session limit)'); process.exit(1); }
    dash.on('dialog', (d) => d.accept().catch(() => {}));
    console.log('      dashboard reached: OK');

    // 3) can we run one search?
    console.log('[3/3] Running one Cases Search (last 24h)...');
    await dash.goto(BASE + '/authUserViewAction.do?actionVal=CasesSearchView&PersistFlag=N&procType=IP', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await dash.waitForTimeout(2000);
    await dash.evaluate(() => { if (typeof showSearch === 'function') showSearch(); });
    await dash.waitForTimeout(1500);
    const from = fmt(new Date(Date.now() - 24 * 3600 * 1000));
    const to = fmt(new Date());
    await dash.evaluate(({ from, to }) => {
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) { el.removeAttribute('readonly'); el.value = v; } };
      setVal('StatusFrom', from); setVal('StatusTo', to);
    }, { from, to });
    await dash.evaluate(() => { if (typeof fnSearch === 'function') fnSearch(); });

    let total = null;
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && total === null) {
      await dash.waitForTimeout(5000);
      const m = await dash.evaluate(() => {
        const t = document.body ? document.body.textContent : '';
        const mm = t.match(/Results\s+\d+\s*-\s*\d+\s+of\s+(\d+)/i);
        if (mm) return parseInt(mm[1], 10);
        if (/No\s+Records/i.test(t)) return 0;
        return null;
      }).catch(() => null);
      if (m !== null) total = m;
    }
    if (total === null) { console.error('FAIL: search submitted but results never loaded (possible block/throttle)'); process.exit(1); }

    console.log('      search returned:', total, 'cases');
    console.log('\n==================================');
    console.log('PASS: remote IP can load, log in, and search the portal.');
    console.log('==================================');
  } finally {
    await browser.close();
  }
}

main().catch((e) => { console.error('FAIL: ' + e.message); process.exit(1); });
