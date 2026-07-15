// Compare Supabase case_no set against the parsed portal master list (logs/parsed-cases.json).
// Reports orphans (in Supabase, NOT in portal) and missing (in portal, NOT in Supabase).
// Does NOT delete anything - run orphan-delete.js after reviewing.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

(async () => {
  const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, 'logs', 'parsed-cases.json'), 'utf8'));
  const portal = new Set(parsed.map((r) => r.case_no));
  console.log('Portal master list:', portal.size, 'distinct case numbers');

  const supa = [];
  let f = 0;
  while (true) {
    const { data, error } = await s.from('cases').select('case_no,claim_status,status_date,patient_name').range(f, f + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    supa.push(...data);
    if (data.length < 1000) break;
    f += 1000;
  }
  console.log('Supabase:', supa.length, 'cases');

  const orphans = supa.filter((r) => !portal.has(r.case_no));
  const missing = [...portal].filter((c) => !supa.some((r) => r.case_no === c));

  console.log('\nOrphans (in Supabase, NOT in portal master list):', orphans.length);
  console.log('Missing (in portal, NOT in Supabase):', missing.length);
  console.log('\nAfter removing orphans, Supabase would be:', supa.length - orphans.length);

  fs.writeFileSync(path.join(__dirname, 'logs', 'orphans.txt'), orphans.map((r) => r.case_no).join('\n'));
  console.log('\nFull orphan list written to logs\\orphans.txt');
  console.log('\nSample orphans (case_no | status | status_date | patient):');
  orphans.slice(0, 20).forEach((r) => console.log(`  ${r.case_no} | ${r.claim_status} | ${r.status_date} | ${r.patient_name}`));
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
