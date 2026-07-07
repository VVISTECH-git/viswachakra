// Dr NTR Vaidya Seva portal automation
// Step 1: open sign-in page and click "Dr NTR Vaidya Seva Login"

const { chromium } = require('playwright');

async function run() {
  const browser = await chromium.launch({
    channel: 'chrome',   // use installed Google Chrome
    headless: false,
  });
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();

  console.log('Opening sign-in page...');
  await page.goto('https://drntrvaidyaseva.ap.gov.in/web/guest/signin', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  console.log('Clicking "Dr NTR Vaidya Seva Login"...');
  const link = page.getByText('Dr NTR Vaidya Seva Login', { exact: false }).first();

  // the link may open in a new tab — log every page that appears
  context.on('page', (p) => {
    console.log('New tab opened:', p.url());
    p.on('close', () => console.log('A tab closed:', p.url()));
  });

  await link.click();
  await page.waitForTimeout(8000); // give the site time to open/redirect tabs

  // pick the newest tab that is still open
  const pages = context.pages();
  console.log('Open tabs now:', pages.map((p) => p.url()));
  const target = pages[pages.length - 1];

  await target.waitForLoadState('domcontentloaded');
  await target.screenshot({ path: 'after-step1.png', fullPage: false });
  console.log('Done. Screenshot saved to after-step1.png');
  console.log('Current URL:', target.url());

  await browser.close();
}

run().catch((err) => {
  console.error('Flow failed:', err.message);
  process.exit(1);
});
