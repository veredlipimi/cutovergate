// Mock sites for the test suite.
//   startNewPlatform() — the migrated site: planted redirect cases, header x-platform: newcms
//   startLegacy()      — the old server still answering 200 for everything
import http from 'node:http';

const R = (status, location) => ({ status, location });
export const ROUTES = {
  '/old-pass': R(301, '/new-pass'),
  '/old-308': R(308, '/new-pass'),
  '/old-slash': R(301, '/new-slash/'),
  '/old-302': R(302, '/new-302'),
  '/old-wrong': R(301, '/elsewhere'),
  '/old-home-1': R(301, '/'),
  '/old-home-2': R(301, '/'),
  '/old-chain': R(301, '/mid'),
  '/mid': R(301, '/new-chain'),
  '/old-target-moves': R(301, '/new-target-moves'),
  '/new-target-moves': R(301, '/final-target'),
  '/old-loop': R(301, '/loop-b'),
  '/loop-b': R(301, '/old-loop'),
  '/old-broken': R(301, '/gone-target'),
  '/old-any': R(301, '/whatever'),
  '/old-abs': R(301, 'ABS:/new-abs'),
  '/old-query?id=7': R(301, '/new-query'),
  '/blog/a': R(301, '/posts/a'), '/blog/b': R(301, '/posts/b'),
  // trailing slash dropped before rule matching
  '/legacy/page-a/': R(301, '/legacy/page-a'), '/legacy/page-b/': R(301, '/legacy/page-b'),
  '/docs/x': R(301, '/wrong-docs/x'), '/docs/y': R(301, '/wrong-docs/y'), '/docs/z': R(301, '/wrong-docs/z'),
};
const DIRECT = {
  '/old-missing': 404, '/old-200': 200, '/retired': 410, '/gone-target': 404,
  '/shop/1': 404, '/shop/2': 404,
  // legacy paths the platform refuses before any redirect rule runs
  // a site refusing the probe
  '/blocked-1': 403, '/blocked-2': 403, '/blocked-3': 403, '/blocked-4': 403,
  '/old/about.1.aspx': 400, '/old/team.2.aspx': 400, '/old/contact.3.aspx': 400,
};

function newPlatform(req, res) {
  const u = new URL(req.url, 'http://x');
  const key = u.pathname + u.search;
  const host = `http://${req.headers.host}`;
  res.setHeader('x-platform', 'newcms');
  if (u.pathname === '/old-slow') { setTimeout(() => { res.writeHead(301, { location: '/new-pass' }); res.end(); }, 3000); return; }
  if (u.pathname.startsWith('/files/') || u.pathname.startsWith('/downloads/')) return files(req, res, u.pathname);
  if (u.pathname === '/page-with-links') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<html><body><a href="/files/ok.pdf">ok</a> <a href='/files/missing.pdf'>missing</a>
      <a href=/files/soft.pdf>soft</a> <a href="/downloads/report.docx">docx</a> <a href="/about">page</a>
      <a href="mailto:a@b.c">mail</a> <a href="/files/nohead.pdf">nohead</a></body></html>`);
  }
  const route = ROUTES[key] || ROUTES[u.pathname];
  if (route) {
    const loc = route.location.startsWith('ABS:') ? host + route.location.slice(4) : route.location;
    res.writeHead(route.status, { location: loc }); return res.end();
  }
  if (key in DIRECT || u.pathname in DIRECT) { res.writeHead(DIRECT[key] ?? DIRECT[u.pathname], { 'content-type': 'text/html' }); return res.end('<h1>page</h1>'); }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><title>new</title><h1>new platform</h1>');
}

function files(req, res, p) {
  if (p === '/files/ok.pdf' || p === '/downloads/report.docx') { res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': '4' }); return res.end(req.method === 'HEAD' ? undefined : '%PDF'); }
  if (p === '/files/soft.pdf') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<h1>Not found</h1>'); }
  if (p === '/files/nohead.pdf') {
    if (req.method === 'HEAD') { res.writeHead(405); return res.end(); }
    res.writeHead(206, { 'content-type': 'application/pdf', 'content-range': 'bytes 0-0/4' }); return res.end('%');
  }
  res.writeHead(404, { 'content-type': 'text/html' }); res.end('nope');
}

function legacy(req, res) {
  res.setHeader('server', 'legacy-cms');
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h1>old site</h1>');
}

const listen = (handler) => new Promise(resolve => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) }));
});
export const startNewPlatform = () => listen(newPlatform);
export const startLegacy = () => listen(legacy);

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startNewPlatform();
  const l = await startLegacy();
  console.log(`new platform: ${s.url}\nlegacy:       ${l.url}`);
}
