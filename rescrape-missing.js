// Re-scrape cases whose deep-scrape failed (empty header, or claim-stage status with no workflow)
// Usage: node rescrape-missing.js [--limit N] [--headless]
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { db } = require('./db');
const { rescrapeCases } = require('./scraper');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const affected = db.prepare(`
  SELECT case_no FROM cases
  WHERE case_no NOT IN (SELECT DISTINCT case_no FROM claim_workflow)
    AND (
      -- deep-scraped but header came back empty (page never loaded)
      (deep_synced IS NOT NULL AND (procedure_name = '' OR procedure_name IS NULL))
      -- OR a claim-stage status that must have a workflow
      OR claim_status LIKE '%Claim Paid%'
      OR claim_status LIKE '%Claim Stopped%'
      OR claim_status LIKE '%Claim sent%'
      OR claim_status LIKE '%Claim Doctor%'
      OR claim_status LIKE '%CEO Claim%'
      OR claim_status LIKE '%CPD Pending%'
      OR claim_status LIKE '%Recommend%'
    )
  ORDER BY case_no
`).all().map((r) => r.case_no);

const limit = parseInt(arg('limit', String(affected.length)), 10);
const target = affected.slice(0, limit);

console.log(`Found ${affected.length} cases needing re-scrape; processing ${target.length}.`);
if (!target.length) { console.log('Nothing to do.'); process.exit(0); }

rescrapeCases(target, { headless: process.argv.includes('--headless') })
  .then((r) => console.log(`Done: ${r.fixed} fixed, ${r.stillMissing} still without workflow.`))
  .catch((e) => { console.error('Re-scrape failed:', e.message); process.exit(1); });
