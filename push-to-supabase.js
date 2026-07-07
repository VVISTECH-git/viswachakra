// Push the local SQLite repository up to Supabase (Postgres) so the mobile app can read it.
// Runs after each scrape. Bulk-upserts cases + claim_workflow; replaces workflow per case.
// Needs SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { createClient } = require('@supabase/supabase-js');
const { db } = require('./db');

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

async function chunkedUpsert(supabase, table, rows, conflictCol, chunk = 500) {
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const { error } = await supabase.from(table).upsert(slice, { onConflict: conflictCol });
    if (error) throw new Error(`${table} upsert failed at row ${i}: ${error.message}`);
    process.stdout.write(`  ${table}: ${Math.min(i + chunk, rows.length)}/${rows.length}\r`);
  }
  console.log('');
}

async function main() {
  if (!URL || !KEY) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env first.');
    process.exit(1);
  }
  const supabase = createClient(URL, KEY, { auth: { persistSession: false } });

  const cases = db.prepare('SELECT * FROM cases').all();
  const workflow = db.prepare('SELECT case_no, row_index, date_time, role_name, remarks, action, amount FROM claim_workflow').all();
  console.log(`Pushing ${cases.length} cases and ${workflow.length} workflow rows to Supabase...`);

  // cases: primary key case_no
  await chunkedUpsert(supabase, 'cases', cases, 'case_no');

  // claim_workflow: unique (case_no, row_index). Replace all rows for the cases we have,
  // then upsert - simplest correct approach for a full push.
  await chunkedUpsert(supabase, 'claim_workflow', workflow, 'case_no,row_index');

  // sync_runs (optional history mirror)
  const runs = db.prepare('SELECT started_at, finished_at, status, from_dt, to_dt, total_found, deep_scraped, message FROM sync_runs ORDER BY id DESC LIMIT 50').all();
  if (runs.length) {
    const { error } = await supabase.from('sync_runs').insert(runs).select().limit(0);
    if (error && !/duplicate/i.test(error.message)) console.log('  (sync_runs mirror skipped:', error.message, ')');
  }

  console.log('Done. Supabase is up to date.');
}

main().catch((e) => { console.error('Push failed:', e.message); process.exit(1); });
