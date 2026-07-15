// Parse the portal's "Cases Search" list pages (saved as .txt files in ./portal-pages)
// and upsert every case straight into Supabase. Bypasses scraping entirely: the list
// view already contains case no, claim no, patient, card, status, dates, amount, txn id.
//
// Usage: save each portal page (all 4, "1000 per page") as portal-pages/page1.txt ... page4.txt
//        then: node parse-portal-list.js            (parse + push)
//              node parse-portal-list.js --dry       (parse + report only, no push)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const DIR = path.join(__dirname, 'portal-pages');
const dry = process.argv.includes('--dry');
const dateRe = /^\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}$/;
const sources = new Set(['Direct', 'PHC', 'CMO', 'Health Camp']);

function parseFile(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
  const records = [];
  let i = 0;
  while (i < lines.length) {
    if (!/^CASE\/5722\/AP\d+/.test(lines[i])) { i++; continue; }
    // collect this record's lines until the next CASE line
    const start = i; i++;
    while (i < lines.length && !/^CASE\/5722\/AP\d+/.test(lines[i])) i++;
    const block = lines.slice(start, i);
    // fixed leading fields (always present, in order)
    const rec = {
      case_no: block[0],
      claim_no: block[1] || '',
      patient_name: block[2] || '',
      card_no: block[3] || '',
      claim_status: block[4] || '',
      source_registration: sources.has(block[5]) ? block[5] : '',
    };
    // status_date = first date-time line in the block
    const sd = block.find((l) => dateRe.test(l));
    rec.status_date = sd || '';
    // ip_registration_dt = first date-time AFTER status_date
    const sdIdx = block.indexOf(sd);
    const dts = block.filter((l, idx) => idx > sdIdx && dateRe.test(l));
    rec.ip_registration_dt = dts[0] || '';
    // claim amount = a bare integer line (0..9 digits) after the dates
    const amt = block.find((l) => /^\d{1,7}$/.test(l));
    rec.claimed_amount = amt ? parseInt(amt, 10) : null;
    // payment markers
    rec.is_paid = /Payment Done/i.test(block.join('\n')) || /Claim Paid/i.test(rec.claim_status);
    records.push(rec);
  }
  return records;
}

(async () => {
  if (!fs.existsSync(DIR)) { console.error('Missing folder', DIR); process.exit(1); }
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort();
  if (!files.length) { console.error('No .txt pages found in', DIR, '- save the portal pages there first.'); process.exit(1); }

  const byCase = new Map();
  for (const f of files) {
    const recs = parseFile(fs.readFileSync(path.join(DIR, f), 'utf8'));
    recs.forEach((r) => byCase.set(r.case_no, r)); // dedupe by case_no across pages
    console.log(`${f}: parsed ${recs.length} records`);
  }
  const all = [...byCase.values()];
  console.log(`\nTotal distinct cases parsed: ${all.length}`);
  console.log('Sample:', JSON.stringify(all[0], null, 0));

  fs.writeFileSync(path.join(__dirname, 'logs', 'parsed-cases.json'), JSON.stringify(all, null, 2));

  if (dry) { console.log('\n--dry: not pushing. Parsed data written to logs/parsed-cases.json'); return; }

  const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const existing = new Set();
  { let f = 0; while (true) { const { data } = await s.from('cases').select('case_no').range(f, f + 999); if (!data || !data.length) break; data.forEach((r) => existing.add(r.case_no)); if (data.length < 1000) break; f += 1000; } }
  const newOnes = all.filter((r) => !existing.has(r.case_no));
  console.log(`Supabase already has ${existing.size}; ${newOnes.length} of the parsed cases are new.`);

  for (let k = 0; k < all.length; k += 400) {
    const { error } = await s.from('cases').upsert(all.slice(k, k + 400), { onConflict: 'case_no' });
    if (error) throw new Error('upsert failed at ' + k + ': ' + error.message);
    process.stdout.write(`  upserted ${Math.min(k + 400, all.length)}/${all.length}\r`);
  }
  console.log('\nDone. Supabase updated from the portal list.');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
