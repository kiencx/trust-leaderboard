// Local preview that mimics Vercel: serves ./public and runs ./api/*.js functions.
// Run: npm run dev  ->  http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const file = path.join(DIR, 'api', path.basename(url.pathname) + '.js');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    const { default: handler } = await import(pathToFileURL(file).href);
    res.status = c => { res.statusCode = c; return res; };
    res.send = b => res.end(b);
    res.json = o => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    return handler(req, res);
  }
  let file = path.join(DIR, 'public', path.normalize(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(path.join(DIR, 'public')) || !fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
