// Backfill in 2-day chunks (the portal times out on wide date ranges)
// Usage: node backfill.js --start "01/07/2026 00:00" [--days 2]
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { runSync } = require('./scraper');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function parseDMY(s) {
  const m = s.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
  return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
}

function fmt(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

(async () => {
  const start = parseDMY(arg('start', '01/07/2026 00:00'));
  const chunkDays = parseFloat(arg('days', '2'));
  const endArg = arg('end', '');
  const end = endArg ? parseDMY(endArg) : new Date();

  const chunks = [];
  let cur = start;
  while (cur < end) {
    const next = new Date(Math.min(cur.getTime() + chunkDays * 86400000, end.getTime()));
    chunks.push([fmt(cur), fmt(next)]);
    cur = next;
  }

  console.log(`Backfill: ${chunks.length} chunks of up to ${chunkDays} days`);
  let grandFound = 0, grandDeep = 0;
  for (let i = 0; i < chunks.length; i++) {
    const [from, to] = chunks[i];
    console.log(`\n##### Chunk ${i + 1}/${chunks.length}: ${from} -> ${to} #####`);
    try {
      const r = await runSync({ from, to });
      grandFound += r.totalFound;
      grandDeep += r.deepScraped;
      // push THIS chunk's data to Supabase right away (crash-safe, watchable in real time)
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
        try {
          require('child_process').execSync('node push-to-supabase.js --since-minutes 120', { stdio: 'inherit', cwd: __dirname });
        } catch (e) {
          console.log('  (chunk push to Supabase failed, will retry at end):', e.message);
        }
      }
    } catch (err) {
      console.log(`Chunk ${i + 1} failed: ${err.message} - continuing with next chunk`);
    }
  }
  console.log(`\n##### Backfill complete: ${grandFound} found, ${grandDeep} deep-scraped #####`);

  // push everything up to Supabase (if configured)
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    console.log('\n##### Pushing all data to Supabase... #####');
    try {
      require('child_process').execSync('node push-to-supabase.js', { stdio: 'inherit', cwd: __dirname });
    } catch (e) {
      console.log('Supabase push failed (run `node push-to-supabase.js` manually):', e.message);
    }
  } else {
    console.log('\n(Supabase not configured - skipping cloud push)');
  }
})();
