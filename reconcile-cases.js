// Reconcile the SET of case numbers: portal (source of truth) vs Supabase.
// Sweeps 2-day windows from --start to now, collecting every case_no the portal shows
// (no deep-scrape), unions them, then diffs against Supabase's case_no set.
// Case numbers are stable (unlike status_date), so this correctly answers
// "what's missing / extra" regardless of status changes.
//
// Usage:  node reconcile-cases.js                         (full history from 01/01/2023)
//         node reconcile-cases.js --start "01/07/2026 00:00"   (from a date)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { listRanges } = require('./scraper');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

function arg(name, fb) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : fb; }
const p2 = (n) => String(n).padStart(2, '0');
const fmtDT = (d) => `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
function parseDMY(str) { const m = String(str).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/); return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]); }

async function fetchSupabaseCaseNos() {
  const set = new Set(); let f = 0;
  while (true) {
    const { data, error } = await s.from('cases').select('case_no').range(f, f + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    data.forEach((r) => set.add(r.case_no));
    if (data.length < 1000) break;
    f += 1000;
  }
  return set;
}

(async () => {
  const start = parseDMY(arg('start', '01/01/2023 00:00'));
  const end = new Date();
  const windows = [];
  let cur = start;
  while (cur < end) { const nx = new Date(Math.min(cur.getTime() + 2 * 86400000, end.getTime())); windows.push([fmtDT(cur), fmtDT(new Date(nx.getTime() - 60000))]); cur = nx; }

  console.log('Fetching Supabase case numbers...');
  const supa = await fetchSupabaseCaseNos();
  console.log(`Supabase has ${supa.size} distinct case numbers.`);
  console.log(`Sweeping portal in ${windows.length} two-day windows from ${fmtDT(start)} to now...\n`);

  const portal = new Set();
  const failed = [];
  let done = 0;
  const logFile = path.join(__dirname, 'logs', 'reconcile-cases.log');
  const compactLog = (m) => { if (/failed|re-login|Logged in OK|Login failed/i.test(m)) console.log('  ' + m); };
  const onResult = (r, i) => {
    r.caseNos.forEach((c) => portal.add(c));
    if (!r.ok) failed.push(`${r.from} -> ${r.to}`);
    done++;
    if (done % 10 === 0 || !r.ok) {
      const line = `  [${done}/${windows.length}] ${r.from} -> ${r.to}: ${r.ok ? r.caseNos.length + ' cases (portal set now ' + portal.size + ')' : 'FAILED all retries'}`;
      console.log(line);
    }
    fs.appendFileSync(logFile, `${done}/${windows.length} ${r.from} ${r.ok ? 'ok ' + r.caseNos.length : 'FAILED'} portalTotal=${portal.size}\n`);
  };

  fs.writeFileSync(logFile, `reconcile-cases started ${new Date().toISOString()}\n`);
  await listRanges(windows, { headless: true, log: compactLog, onResult, reloginEvery: 30, maxTries: 4 });

  const missing = [...portal].filter((c) => !supa.has(c));      // on portal, NOT in Supabase
  const extra = [...supa].filter((c) => !portal.has(c));         // in Supabase, NOT on portal

  console.log('\n================ CASE-NUMBER RECONCILIATION ================');
  console.log(`Portal distinct cases swept : ${portal.size}`);
  console.log(`Supabase distinct cases     : ${supa.size}`);
  console.log(`On portal, MISSING from Supabase : ${missing.length}`);
  console.log(`In Supabase, NOT seen on portal  : ${extra.length}`);
  if (failed.length) console.log(`\n!! ${failed.length} window(s) FAILED every retry - coverage is incomplete, results are a lower bound. Re-run to firm up.`);

  fs.writeFileSync(path.join(__dirname, 'logs', 'missing-from-supabase.txt'), missing.join('\n'));
  fs.writeFileSync(path.join(__dirname, 'logs', 'extra-in-supabase.txt'), extra.join('\n'));
  if (failed.length) fs.writeFileSync(path.join(__dirname, 'logs', 'failed-windows.txt'), failed.join('\n'));
  console.log('\nFull lists written to logs\\missing-from-supabase.txt and logs\\extra-in-supabase.txt');
  if (missing.length) console.log('Sample missing:', missing.slice(0, 10).join(', '));
  if (extra.length) console.log('Sample extra  :', extra.slice(0, 10).join(', '));
  if (!missing.length && !extra.length && !failed.length) console.log('\nPerfect match — Supabase mirrors the portal exactly. ✓');
})().catch((e) => { console.error('reconcile-cases failed:', e.message); process.exit(1); });
