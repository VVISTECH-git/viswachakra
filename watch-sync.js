// emits sync progress every ~10 min and exits when the sync ends
const http = require('http');

function getStatus() {
  return new Promise((resolve) => {
    http.get('http://localhost:3000/api/sync/status', (r) => {
      let d = '';
      r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

(async () => {
  let lastEmit = 0;
  let lastProg = '';
  let sawRunning = false;
  while (true) {
    const s = await getStatus();
    if (s) {
      const logs = s.log || [];
      const prog = [...logs].reverse().find((l) => /\[\d+\/\d+\]/.test(l)) || '';
      const term = logs.find((l) => /Sync done|Sync failed|exited with code|process finished/.test(l));
      if (s.running) sawRunning = true;
      if (term || (sawRunning && !s.running)) {
        if (prog) console.log('last progress: ' + prog);
        console.log(term || 'sync process ended: ' + (logs[logs.length - 1] || '(no log)'));
        process.exit(0);
      }
      const now = Date.now();
      if (prog && prog !== lastProg && now - lastEmit > 600000) {
        console.log(prog);
        lastEmit = now;
        lastProg = prog;
      }
    }
    await new Promise((r) => setTimeout(r, 30000));
  }
})();
