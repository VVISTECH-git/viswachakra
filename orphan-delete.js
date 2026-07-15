// Delete the orphan cases (in logs/orphans.txt) from Supabase so it exactly mirrors
// the portal master list. Also removes their claim_workflow rows. Irreversible.
// Run orphan-check.js first to (re)generate logs/orphans.txt and review the list.
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

(async () => {
  const orphans = fs.readFileSync(path.join(__dirname, 'logs', 'orphans.txt'), 'utf8')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  console.log(`Deleting ${orphans.length} orphan cases (and their workflow rows)...`);

  for (let i = 0; i < orphans.length; i += 100) {
    const chunk = orphans.slice(i, i + 100);
    const w = await s.from('claim_workflow').delete().in('case_no', chunk);
    if (w.error) throw new Error('workflow delete failed: ' + w.error.message);
    const c = await s.from('cases').delete().in('case_no', chunk);
    if (c.error) throw new Error('cases delete failed: ' + c.error.message);
    process.stdout.write(`  deleted ${Math.min(i + 100, orphans.length)}/${orphans.length}\r`);
  }

  const { count } = await s.from('cases').select('*', { count: 'exact', head: true });
  console.log(`\nDone. Supabase cases now: ${count}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
