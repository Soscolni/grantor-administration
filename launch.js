// Combined Railway entry point. Runs both webhook apps in ONE service:
//   - monday-rivhit-bridge   at the root path  (/monday/webhook, /healthz, ...)
//   - monday-subitems-sheet  under  /subitems  (/subitems/monday/webhook, ...)
//
// Each app is spawned as its own `node server.js` on an internal port and stays
// completely self-contained (its own deps, its own env). This file only spawns
// the processes and reverse-proxies by path prefix — it imports NO code from the
// subdirs, so the repo's "independent apps" rule still holds.
//
// Railway gives us one public port ($PORT); the children listen on internal
// ports. The combined service's env vars must be the UNION of both apps' vars
// (the rivhit set + MONDAY_API_TOKEN; the subitems board/column/sheet ids ship as
// defaults). WEBHOOK_SHARED_SECRET, if set, applies to BOTH apps' webhooks.

import { spawn } from 'node:child_process';
import http from 'node:http';

const PORT = Number(process.env.PORT) || 3000;
const APPS = {
  rivhit: { name: 'monday-rivhit-bridge', dir: 'monday-rivhit-bridge', port: 4001 },
  subitems: { name: 'monday-subitems-sheet', dir: 'monday-subitems-sheet', port: 4002 },
};

const children = [];

function startApp({ name, dir, port }) {
  const child = spawn('node', ['server.js'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port) },
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    console.error(`[launch] ${name} exited (code=${code}, signal=${signal}) — stopping service so Railway restarts it`);
    shutdown(1);
  });
  children.push(child);
  return child;
}

function shutdown(exitCode) {
  for (const c of children) {
    if (!c.killed) c.kill('SIGTERM');
  }
  process.exit(exitCode);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

startApp(APPS.rivhit);
startApp(APPS.subitems);

// Reverse proxy. /subitems/* -> subitems app (prefix stripped); everything else
// -> rivhit-bridge. The request body is piped through untouched so each child
// parses its own JSON (do NOT add a body parser here).
const proxy = http.createServer((req, res) => {
  // Service-level liveness for Railway's healthcheck. A dead child can't be
  // masked: its exit handler tears the whole service down (see startApp).
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'combined', apps: [APPS.rivhit.name, APPS.subitems.name] }));
    return;
  }

  let port = APPS.rivhit.port;
  let path = req.url;
  if (req.url === '/subitems' || req.url.startsWith('/subitems/')) {
    port = APPS.subitems.port;
    path = req.url.slice('/subitems'.length) || '/';
  }

  const upstream = http.request(
    { host: '127.0.0.1', port, method: req.method, path, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    console.error(`[launch] proxy error -> :${port}${path}: ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'upstream unavailable' }));
  });
  req.pipe(upstream);
});

proxy.listen(PORT, () => {
  console.log(
    `[launch] combined proxy on :${PORT} — ` +
    `rivhit @ :${APPS.rivhit.port} (root), subitems @ :${APPS.subitems.port} (/subitems)`,
  );
});
