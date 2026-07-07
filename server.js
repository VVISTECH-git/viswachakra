// Viswachakra claims console - API server
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const { fork } = require('child_process');
const cron = require('node-cron');
const ExcelJS = require('exceljs');
const { db } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json());

// ---- optional basic auth (set APP_PASSWORD in .env to enable) ----
if (process.env.APP_PASSWORD) {
  app.use((req, res, next) => {
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [, pass] = Buffer.from(encoded, 'base64').toString().split(':');
      if (pass === process.env.APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Viswachakra Claims Console"');
    res.status(401).send('Authentication required');
  });
}

app.use(express.static(path.join(__dirname, 'public')));

// ---- sync runner (child process so a scraper crash never kills the server) ----
let syncChild = null;
let syncLog = [];

function startSyncProcess(args) {
  if (syncChild) return { ok: false, error: 'A sync is already running' };
  syncLog = [];
  syncChild = fork(path.join(__dirname, 'scraper.js'), args, { silent: true });
  const capture = (data) => {
    for (const line of data.toString().split('\n')) {
      if (!line.trim()) continue;
      syncLog.push(line.trimEnd());
      if (syncLog.length > 400) syncLog.shift();
    }
  };
  syncChild.stdout.on('data', capture);
  syncChild.stderr.on('data', capture);
  syncChild.on('exit', (code) => {
    syncLog.push(code === 0 ? '[sync process finished]' : `[sync process exited with code ${code}]`);
    syncChild = null;
  });
  return { ok: true };
}

// ---- API ----
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) n FROM cases').get().n;
  const withWorkflow = db.prepare('SELECT COUNT(DISTINCT case_no) n FROM claim_workflow').get().n;
  const lastSync = db.prepare('SELECT MAX(last_synced) t FROM cases').get().t;
  const lastRun = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get() || null;
  const onHold = db.prepare(`SELECT COUNT(*) n FROM cases WHERE claim_status LIKE '%Hold%' OR claim_status LIKE '%Stopped%'`).get().n;
  const paid = db.prepare(`SELECT COUNT(*) n FROM cases WHERE claim_status LIKE '%Paid%' OR claim_status LIKE '%Credited%'`).get().n;
  res.json({ total, withWorkflow, lastSync, lastRun, onHold, paid, syncRunning: !!syncChild });
});

app.get('/api/cases', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const pageSize = Math.min(200, Math.max(10, parseInt(req.query.pageSize || '25', 10)));

  const where = [];
  const params = {};
  if (q) {
    where.push(`(case_no LIKE @q OR claim_no LIKE @q OR patient_name LIKE @q OR card_no LIKE @q OR contact_no LIKE @q)`);
    params.q = `%${q}%`;
  }
  if (status) { where.push('claim_status = @status'); params.status = status; }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const total = db.prepare(`SELECT COUNT(*) n FROM cases${whereSql}`).get(params).n;
  const rows = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM claim_workflow w WHERE w.case_no = c.case_no) wf_count
    FROM cases c${whereSql}
    ORDER BY
      substr(c.status_date, 7, 4) || '-' || substr(c.status_date, 4, 2) || '-' || substr(c.status_date, 1, 2) || substr(c.status_date, 11) DESC
    LIMIT @lim OFFSET @off
  `).all({ ...params, lim: pageSize, off: (page - 1) * pageSize });

  res.json({ rows, total, page, pageSize });
});

app.get('/api/statuses', (req, res) => {
  res.json(db.prepare(`SELECT claim_status s, COUNT(*) n FROM cases WHERE claim_status <> '' GROUP BY 1 ORDER BY n DESC`).all());
});

app.get('/api/workflow', (req, res) => {
  const caseNo = req.query.case || '';
  const rows = db.prepare('SELECT * FROM claim_workflow WHERE case_no = ? ORDER BY row_index').all(caseNo);
  const caseRow = db.prepare('SELECT * FROM cases WHERE case_no = ?').get(caseNo);
  res.json({ caseRow, rows });
});

app.get('/api/export', async (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || '').trim();
  const where = [];
  const params = {};
  if (q) { where.push(`(case_no LIKE @q OR claim_no LIKE @q OR patient_name LIKE @q OR card_no LIKE @q)`); params.q = `%${q}%`; }
  if (status) { where.push('claim_status = @status'); params.status = status; }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const cases = db.prepare(`SELECT * FROM cases${whereSql} ORDER BY case_no`).all(params);
  const caseNos = new Set(cases.map((c) => c.case_no));
  const workflow = db.prepare('SELECT * FROM claim_workflow ORDER BY case_no, row_index').all()
    .filter((w) => caseNos.has(w.case_no));

  const wb = new ExcelJS.Workbook();
  const ws1 = wb.addWorksheet('Cases');
  ws1.columns = [
    { header: 'Case No', key: 'case_no', width: 24 }, { header: 'Claim No', key: 'claim_no', width: 30 },
    { header: 'Patient', key: 'patient_name', width: 24 }, { header: 'Card No', key: 'card_no', width: 22 },
    { header: 'District', key: 'district', width: 14 }, { header: 'Mandal', key: 'mandal', width: 16 },
    { header: 'Village', key: 'village', width: 16 }, { header: 'Contact', key: 'contact_no', width: 14 },
    { header: 'Hospital', key: 'nwh_name', width: 34 }, { header: 'IP No', key: 'ip_no', width: 12 },
    { header: 'IP Registration', key: 'ip_registration_dt', width: 20 },
    { header: 'Category', key: 'category', width: 30 }, { header: 'Procedure', key: 'procedure_name', width: 45 },
    { header: 'Claim Status', key: 'claim_status', width: 40 }, { header: 'Status Date', key: 'status_date', width: 20 },
    { header: 'Note', key: 'workflow_note', width: 30 },
  ];
  ws1.getRow(1).font = { bold: true };
  cases.forEach((c) => ws1.addRow(c));

  const ws2 = wb.addWorksheet('Claim workflow');
  ws2.columns = [
    { header: 'Case No', key: 'case_no', width: 24 }, { header: 'Step', key: 'row_index', width: 6 },
    { header: 'Date & Time', key: 'date_time', width: 22 }, { header: 'Role & Name', key: 'role_name', width: 26 },
    { header: 'Action', key: 'action', width: 28 }, { header: 'Amount', key: 'amount', width: 12 },
    { header: 'Remarks', key: 'remarks', width: 90 },
  ];
  ws2.getRow(1).font = { bold: true };
  workflow.forEach((w) => ws2.addRow({ ...w, row_index: w.row_index + 1 }));
  ws2.getColumn('remarks').alignment = { wrapText: true, vertical: 'top' };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="viswachakra-cases-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

app.post('/api/sync', (req, res) => {
  const { hours, from, to, limit } = req.body || {};
  const args = [];
  if (from) args.push('--from', from);
  if (to) args.push('--to', to);
  if (!from && hours) args.push('--hours', String(hours));
  if (limit) args.push('--limit', String(limit));
  if (process.env.HEADLESS === 'true') args.push('--headless');
  const result = startSyncProcess(args);
  if (!result.ok) return res.status(409).json(result);
  res.json({ ok: true });
});

app.get('/api/sync/status', (req, res) => {
  const history = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 20').all();
  res.json({ running: !!syncChild, log: syncLog.slice(-60), history });
});

// ---- hourly scheduler (set SYNC_EVERY_HOUR=true in .env to enable) ----
if (process.env.SYNC_EVERY_HOUR === 'true') {
  const expr = process.env.SYNC_CRON || '10 * * * *'; // 10 minutes past every hour
  cron.schedule(expr, () => {
    console.log('[scheduler] starting hourly sync (last 2 hours window)');
    const args = ['--hours', '2'];
    if (process.env.HEADLESS !== 'false') args.push('--headless');
    startSyncProcess(args);
  });
  console.log(`Hourly sync scheduler enabled (cron: ${expr})`);
}

app.listen(PORT, () => console.log(`Viswachakra claims console: http://localhost:${PORT}`));
