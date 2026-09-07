// Local dev harness: serves the static app and hands /api/* to the same
// serverless handler Vercel runs in production.
//
//   node dev-server.js            → http://localhost:3000
//   MATON_API_KEY=... node dev-server.js
//
// The key can also come from a .env file next to this script, or be entered
// in the app's Settings dialog (it is then stored in localStorage).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Load .env so getApiKey() in api/index.js finds MATON_API_KEY.
const dotenvPath = path.join(ROOT, '.env');
if (fs.existsSync(dotenvPath)) {
  fs.readFileSync(dotenvPath, 'utf8').split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const index = trimmed.indexOf('=');
    if (index === -1) return;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key]) process.env[key] = value;
  });
}

const apiHandler = require('./api/index.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

// Only these paths are reachable; everything else 404s so .env, lib/ and
// api/ source can never be served by accident.
const SERVE_FILES = new Set([
  '/index.html', '/app.js', '/styles.css', '/gmail.css', '/drive.css', '/settings.css'
]);

function isServable(pathname) {
  return SERVE_FILES.has(pathname) || pathname.startsWith('/src/');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;

  if (pathname.startsWith('/api/')) {
    apiHandler(req, res).catch(err => {
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // Reject traversal before touching the filesystem.
  const resolved = path.resolve(ROOT, '.' + pathname);
  if (!resolved.startsWith(ROOT) || !isServable(pathname)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  const configured = process.env.MATON_API_KEY ? 'from environment' : 'not set — add it in Settings ⚙️';
  console.log(`Maton Mail dev server → http://localhost:${PORT}`);
  console.log(`MATON_API_KEY: ${configured}`);
});
