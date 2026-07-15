// Reliable portal-vs-Supabase reconciliation.
// Counts the portal in 2-day windows (the size the portal tolerates), with retries
// and periodic re-login (handled in scraper.countRanges), then aggregates by month and
// compares against Supabase. Windows that fail every retry are flagged so no silent
// undercount is mistaken for a real discrepancy.
//
// Usage:  node reconcile.js             (all months present in Supabase)
//         node reconcile.js --months 3  (only the most recent 3 real months)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { countRanges } = require('./scraper');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

function arg(name, fb) { const i = process.argv.indexOf('--' + name); return i > -1 ? process.argv[i + 1] : fb; }
const p2 = (n) => String(n).padStart(2, '0');
const fmtDT = (d) => `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
const ymOf = (status) => { const m = String(status || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? { y: +m[3], mo: +m[2] } : null; };

const NOW = new Date();
const capEnd = (d) => (d > NOW ? NOW : d);
const isFutureMonth = (y, mo) => new Date(y, mo - 1, 1, 0, 0) > NOW;

// 2-day windows that stay WITHIN a single month (clean month aggregation), capped at now.
function monthSubWindows(y, mo) {
  const end = capEnd(new Date(y, mo, 1, 0, 0));
  const out = []; let cur = new Date(y, mo - 1, 1, 0, 0);
  while (cur < end) {
    const nx = new Date(Math.min(cur.getTime() + 2 * 86400000, end.getTime()));
    out.push([fmtDT(cur), fmtDT(new Date(nx.getTime() - 60000))]);
    cur = nx;
  }
  return out;
}

async function fetchAllStatusDates() {
  const out = []; let f = 0;
  while (true) {
    const { data, error } = await s.from('cases').select('case_no,status_date').range(f, f + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < 1000) break;
    f += 1000;
  }
  return out;
}

(async () => {
  const monthsLimit = parseInt(arg('months', '0'), 10);
  console.log('Fetching Supabase cases...');
  const rows = await fetchAllStatusDates();
  const buckets = {}; let unparsed = 0;
  for (const r of rows) { const ym = ymOf(r.status_date); if (!ym) { unparsed++; continue; } const k = `${ym.y}-${p2(ym.mo)}`; buckets[k] = (buckets[k] || 0) + 1; }

  const allKeys = Object.keys(buckets).sort();
  const futureKeys = allKeys.filter((k) => { const [y, mo] = k.split('-').map(Number); return isFutureMonth(y, mo); });
  let realKeys = allKeys.filter((k) => !futureKeys.includes(k));
  if (monthsLimit > 0) realKeys = realKeys.slice(-monthsLimit);
  console.log(`Supabase: ${rows.length} cases total, ${unparsed} without a usable status_date.`);
  console.log(`Reconciling ${realKeys.length} month(s); ${futureKeys.length} future-dated month(s) reported separately.\n`);

  // build all 2-day windows, tagged with their month key
  const tagged = [];
  for (const k of realKeys) { const [y, mo] = k.split('-').map(Number); for (const w of monthSubWindows(y, mo)) tagged.push({ k, win: w }); }
  const TOTAL = tagged.length;
  console.log(`Counting portal in ${TOTAL} two-day windows (with retries + periodic re-login). This takes a while...\n`);

  const compactLog = (m) => { if (/failed|re-login|Logged in OK|Login failed/i.test(m)) console.log('  ' + m); };
  const portalByMonth = {}; const failedByMonth = {}; let done = 0;
  const onResult = (r, i) => {
    const k = tagged[i].k;
    portalByMonth[k] = (portalByMonth[k] || 0) + (r.ok ? r.portal : 0);
    if (!r.ok) failedByMonth[k] = (failedByMonth[k] || 0) + 1;
    done++;
    if (done % 10 === 0 || !r.ok) console.log(`  [${done}/${TOTAL}] ${r.from} -> ${r.to} = ${r.portal}${r.ok ? '' : '  <== FAILED (all retries)'}`);
  };

  await countRanges(tagged.map((t) => t.win), { headless: true, log: compactLog, onResult, reloginEvery: 40, maxTries: 4 });

  console.log('\n================ RECONCILIATION (portal vs Supabase) ================');
  console.log('Month      Portal  Supabase  Result   Failed windows');
  let tP = 0, tS = 0, totalFailed = 0;
  for (const k of realKeys) {
    const portal = portalByMonth[k] || 0; const sup = buckets[k]; const fw = failedByMonth[k] || 0;
    tP += portal; tS += sup; totalFailed += fw;
    const res = fw ? 'UNSURE' : (portal === sup ? 'OK' : 'DIFF');
    console.log(`${k}   ${String(portal).padStart(6)}   ${String(sup).padStart(7)}   ${res.padEnd(7)}  ${fw ? fw + ' window(s) failed' : ''}`);
  }
  console.log('--------------------------------------------------------------------');
  console.log(`TOTAL      ${String(tP).padStart(6)}   ${String(tS).padStart(7)}   ${totalFailed ? 'UNSURE' : (tP === tS ? 'OK' : 'DIFF')}`);
  if (unparsed) console.log(`(+${unparsed} Supabase cases have no status_date)`);
  for (const k of futureKeys) console.log(`(future: ${k} has ${buckets[k]} Supabase cases — portal sentinel date, not queryable)`);

  const diffs = realKeys.filter((k) => !(failedByMonth[k]) && (portalByMonth[k] || 0) !== buckets[k]);
  if (totalFailed) console.log(`\n${totalFailed} window(s) failed every retry — those months are UNSURE; re-run to firm them up.`);
  if (diffs.length) {
    console.log(`\n${diffs.length} month(s) genuinely differ:`);
    diffs.forEach((k) => { const p = portalByMonth[k] || 0; const sup = buckets[k]; console.log(`  ${k}: portal ${p}, Supabase ${sup}  (${p > sup ? (p - sup) + ' MISSING from Supabase' : (sup - p) + ' extra in Supabase'})`); });
  } else if (!totalFailed) {
    console.log('\nAll months reconcile — Supabase matches the portal. ✓');
  }
})().catch((e) => { console.error('reconcile failed:', e.message); process.exit(1); });
