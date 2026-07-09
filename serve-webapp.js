// Minimal static server for local testing of the webapp/ folder.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, 'webapp');
const port = process.env.PORT || 5050;
const types = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.json':'application/json' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(root, p);
  fs.readFile(fp, (e, d) => {
    if (e) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(fp)] || 'application/octet-stream' });
    res.end(d);
  });
}).listen(port, () => console.log('webapp on http://localhost:' + port));
