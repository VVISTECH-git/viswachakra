// One-off patch for the 34 "Claim Paid" cases still missing paid_amount after refresh-paid.
// Step 1: re-scrape the ones whose workflow came back empty (rule out a transient failure).
// Step 2: for every paid case STILL missing paid_amount, fall back to the final workflow
//         row's amount as the settled amount (legacy cases whose paid row is labeled "-").
// Only writes paid_amount/paid_date/settlement_days/deduction/is_paid. Never touches
// claimed_amount, claim_status, status_date, patient fields, etc.
//
// Usage: node patch-paid-legacy.js
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { scrapeCaseWorkflows } = require('./scraper');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
process.on('unhandledRejection', (e) => { console.error('unhandledRejection:', (e && e.message) || e); process.exit(1); });

const paidRe = /paid|payment done/i;
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function parseWfDate(str) { const m = String(str || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i); if (!m) return null; let h = +m[4]; const ap = (m[6] || '').toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; return new Date(+m[3], MON[m[2].toLowerCase()], +m[1], h, +m[5]); }
function parseAmt(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; }

async function fetchAllCases() {
  const out = []; let f = 0;
  while (true) { const { data, error } = await s.from('cases').select('case_no,claim_status,is_paid,paid_amount,claimed_amount').range(f, f + 999); if (error) throw new Error(error.message); if (!data || !data.length) break; out.push(...data); if (data.length < 1000) break; f += 1000; }
  return out;
}
async function getWf(caseNo) {
  const { data, error } = await s.from('claim_workflow').select('row_index,date_time,role_name,remarks,action,amount').eq('case_no', caseNo).order('row_index');
  if (error) throw new Error(error.message);
  return data || [];
}
async function pushWorkflow(caseNo, rows) {
  await s.from('claim_workflow').delete().eq('case_no', caseNo);
  if (rows.length) {
    const recs = rows.map((r, i) => ({ case_no: caseNo, row_index: i, date_time: r.date_time, role_name: r.role_name, remarks: r.remarks, action: r.action, amount: r.amount }));
    const { error } = await s.from('claim_workflow').upsert(recs, { onConflict: 'case_no,row_index' });
    if (error) throw new Error('wf upsert ' + caseNo + ': ' + error.message);
  }
}
// Derive settled amount for a paid case from its workflow rows, using the last row that
// carries a positive amount as the settled figure. Returns null if nothing usable.
function deriveFromLastRow(rows, claimedFromCase) {
  rows = rows.slice().sort((a, b) => a.row_index - b.row_index);
  if (!rows.length) return null;
  const withAmt = rows.filter(r => parseAmt(r.amount) > 0);
  if (!withAmt.length) return null;
  const lastAmtRow = withAmt[withAmt.length - 1];
  const paid = parseAmt(lastAmtRow.amount);
  const initiated = rows.find(r => /initiated/i.test(r.action || '')) || rows[0];
  const claimed = claimedFromCase != null ? claimedFromCase : parseAmt(initiated.amount);
  const initAt = parseWfDate(initiated.date_time);
  const paidAt = parseWfDate(lastAmtRow.date_time);
  let settlement = null; if (initAt && paidAt) { const d = Math.round((paidAt - initAt) / 864e5); if (d >= 0) settlement = d; }
  const deduction = claimed > 0 ? Math.max(0, claimed - paid) : null;
  return { paid_amount: paid, paid_date: lastAmtRow.date_time || null, settlement_days: settlement, deduction, is_paid: true };
}
async function applyFallback(caseNo, claimed) {
  const rows = await getWf(caseNo);
  const d = deriveFromLastRow(rows, claimed);
  if (!d) return false;
  const { error } = await s.from('cases').upsert({ case_no: caseNo, ...d }, { onConflict: 'case_no' });
  if (error) throw new Error('detail upsert ' + caseNo + ': ' + error.message);
  return true;
}

(async () => {
  const all = await fetchAllCases();
  const missing = all.filter(r => (r.is_paid || paidRe.test(r.claim_status || '')) && r.paid_amount == null);
  console.log('paid cases still missing amount:', missing.length);

  // classify by current workflow row count
  const empties = [], hasRows = [];
  for (const m of missing) { const wf = await getWf(m.case_no); (wf.length ? hasRows : empties).push(m); }
  console.log('  empty workflows to re-scrape:', empties.length, '| has-rows to fallback:', hasRows.length);

  // Step 1: re-scrape the empties once
  const claimedBy = Object.fromEntries(all.map(r => [r.case_no, r.claimed_amount]));
  if (empties.length) {
    console.log('\n--- Step 1: re-scraping', empties.length, 'empty-workflow cases ---');
    const onResult = async (r) => {
      if (r.ok && r.rows.length) {
        await pushWorkflow(r.case_no, r.rows);
        console.log('  rescraped', r.case_no, '->', r.rows.length, 'rows');
      } else {
        console.log('  rescraped', r.case_no, '-> still', r.ok ? 'empty' : 'FAILED ' + (r.note || ''));
      }
    };
    await scrapeCaseWorkflows(empties.map(e => e.case_no), { headless: true, onResult, reloginEvery: 20, maxTries: 3, log: (m) => { if (/Logged in OK|Login failed|re-login/i.test(m)) console.log('  ' + m); } });
  }

  // Step 2: fallback for everything still missing an amount
  console.log('\n--- Step 2: last-row fallback ---');
  const stillMissing = [];
  for (const m of missing) { const { data } = await s.from('cases').select('paid_amount').eq('case_no', m.case_no).single(); if (!data || data.paid_amount == null) stillMissing.push(m); }
  let filled = 0, empty = 0;
  for (const m of stillMissing) {
    const ok = await applyFallback(m.case_no, claimedBy[m.case_no]);
    if (ok) { filled++; console.log('  filled', m.case_no); } else { empty++; console.log('  no usable amount (genuinely empty):', m.case_no); }
  }
  console.log(`\nDone. Filled ${filled} via fallback. ${empty} genuinely empty (no workflow amount) left as-is.`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
