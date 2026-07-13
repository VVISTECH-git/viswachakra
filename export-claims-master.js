// Generate the "Claims Master" register (21-column template) from Supabase.
// Reads all cases + claim_workflow, derives submission / query / reply / approval /
// outstanding / days-pending, and writes an .xlsx matching Claims_Master_Template.xlsx.
// Usage: node export-claims-master.js [output.xlsx]   (default: Desktop\Claims_Master_<date>.xlsx)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const ExcelJS = require('exceljs');
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
// workflow dates look like "06-Jan-2026 08:45 PM"
function parseWf(str) {
  const m = String(str || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = +m[4]; const ap = (m[6] || '').toUpperCase();
  if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0;
  return new Date(+m[3], MON[m[2].toLowerCase()], +m[1], h, +m[5]);
}
// case fields look like "16/12/2025 19:32:47"
function parseDmy(str) {
  const m = String(str || '').match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  return new Date(+m[3], +m[2] - 1, +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
}
const anyDate = (str) => parseWf(str) || parseDmy(str);
function fmt(d) { if (!d) return ''; const p = (n) => String(n).padStart(2, '0'); return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`; }
function amt(v) { const n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10); return isNaN(n) ? 0 : n; }

async function fetchAll(t, c) {
  const o = []; let f = 0;
  while (true) {
    const { data, error } = await s.from(t).select(c).range(f, f + 999);
    if (error) throw new Error(error.message);
    if (!data || !data.length) break;
    o.push(...data); if (data.length < 1000) break; f += 1000;
  }
  return o;
}

const HEADERS = ['Claim ID', 'UHID', 'Patient Name', 'Insurance/TPA', 'Scheme', 'Surgery Date',
  'Procedure', 'Claim Amount', 'Submission Date', 'Current Status', 'Query Raised?', 'Query Date',
  'Reply Date', 'Approval Date', 'Amount Approved', 'Payment Date', 'Amount Received', 'Outstanding',
  'Days Pending', 'Follow-up Needed', 'Remarks'];

function derive(c, rows) {
  rows = [...rows].sort((a, b) => a.row_index - b.row_index);
  const initiated = rows.find((r) => /initiated/i.test(r.action || '')) || rows[0];
  const submissionAt = initiated ? parseWf(initiated.date_time) : null;
  const claimAmt = c.claimed_amount != null ? c.claimed_amount : (initiated ? amt(initiated.amount) : 0);

  // approval = last "Recommended for Approval" / "Medical Audit Recommend Approval" (not rejection)
  const approvalRow = [...rows].reverse().find((r) => /recommend(ed)? for approval|recommend approval/i.test(r.action || ''));
  const approvalAt = approvalRow ? parseWf(approvalRow.date_time) : null;
  const approvedAmt = approvalRow ? amt(approvalRow.amount) : null;

  // payment
  const paidRow = [...rows].reverse().find((r) => /paid/i.test(r.action || ''));
  const paidAt = paidRow ? parseWf(paidRow.date_time) : (c.paid_date ? parseWf(c.paid_date) : null);
  const received = c.paid_amount != null ? c.paid_amount : (paidRow ? amt(paidRow.amount) : null);
  const isPaid = !!paidRow || c.is_paid;

  // query = first hold / sent-back / pending-for-update / rejection-recommend
  const queryRow = rows.find((r) => /kept hold|sent back|returned|query|recommended for rejection|updated claim .* pending/i.test(r.action || ''));
  const queryAt = queryRow ? parseWf(queryRow.date_time) : null;
  // reply = first hospital (MEDCO) / re-submission action AFTER the query
  let replyAt = null;
  if (queryRow) {
    const qi = rows.indexOf(queryRow);
    const reply = rows.slice(qi + 1).find((r) => /MEDCO|Patient Feedback Submitted|Initiated|Updated Claim/i.test(`${r.role_name || ''} ${r.action || ''}`));
    if (reply) replyAt = parseWf(reply.date_time);
  }

  const outstanding = Math.max(0, (claimAmt || 0) - (received || 0));
  let daysPending = null;
  if (isPaid && submissionAt && paidAt) daysPending = Math.max(0, Math.round((paidAt - submissionAt) / 864e5));
  else if (submissionAt) daysPending = Math.max(0, Math.round((Date.now() - submissionAt) / 864e5));

  return {
    'Claim ID': c.claim_no || '',
    UHID: c.card_no || '',
    'Patient Name': c.patient_name || '',
    'Insurance/TPA': '',
    Scheme: '',
    'Surgery Date': fmt(anyDate(c.ip_registration_dt)),
    Procedure: c.procedure_name || '',
    'Claim Amount': claimAmt || '',
    'Submission Date': fmt(submissionAt),
    'Current Status': c.claim_status || '',
    'Query Raised?': queryRow ? 'Yes' : 'No',
    'Query Date': fmt(queryAt),
    'Reply Date': fmt(replyAt),
    'Approval Date': fmt(approvalAt),
    'Amount Approved': approvedAmt != null ? approvedAmt : '',
    'Payment Date': fmt(paidAt),
    'Amount Received': received != null ? received : '',
    Outstanding: outstanding,
    'Days Pending': daysPending != null ? daysPending : '',
    'Follow-up Needed': isPaid ? 'No' : 'Yes',
    Remarks: c.latest_comment || '',
  };
}

(async () => {
  console.log('Fetching cases + workflow from Supabase...');
  const cases = await fetchAll('cases', 'case_no,claim_no,card_no,patient_name,ip_registration_dt,procedure_name,claimed_amount,paid_amount,paid_date,claim_status,latest_comment,status_date,is_paid');
  const wf = await fetchAll('claim_workflow', 'case_no,row_index,date_time,action,amount,remarks,role_name');
  const byCase = {}; wf.forEach((r) => { (byCase[r.case_no] = byCase[r.case_no] || []).push(r); });
  console.log(`Computing ${cases.length} claims from ${wf.length} workflow rows...`);

  const rows = cases
    .sort((a, b) => String(a.case_no).localeCompare(String(b.case_no)))
    .map((c) => derive(c, byCase[c.case_no] || []));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Claims Master');
  ws.columns = HEADERS.map((h) => ({ header: h, key: h, width: Math.max(12, Math.min(30, h.length + 5)) }));
  rows.forEach((r) => ws.addRow(r));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + HEADERS.length)}1` };

  const out = process.argv[2] || `C:/Users/bhanu/OneDrive/Desktop/Claims_Master_${new Date().toISOString().slice(0, 10)}.xlsx`;
  await wb.xlsx.writeFile(out);

  const paid = rows.filter((r) => r['Payment Date']).length;
  const q = rows.filter((r) => r['Query Raised?'] === 'Yes').length;
  const fu = rows.filter((r) => r['Follow-up Needed'] === 'Yes').length;
  console.log(`\nWrote ${rows.length} claims -> ${out}`);
  console.log(`  paid: ${paid}   |   query raised: ${q}   |   follow-up needed: ${fu}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
