import http from 'node:http';
import net from 'node:net';

// Fixed upstreams only. Databases and application services have no outbound network.
const routes = [[14720, 'web', 3000], [14721, 'workspace', 3000], [14722, 'core', 4100]];
for (const [listen, hostname, port] of routes) {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/')) { res.writeHead(400).end(); return; }
    if (process.env.OFFICE_READ_ONLY !== 'false' && listen === 14721 && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)
      && !['/sales/api/inbox/session', '/sales/api/inbox/logout'].includes(req.url.split('?')[0])) {
      res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ message: '本机为迁移预备环境，暂不允许修改或发送。' })); return;
    }
    const upstream = http.request({ hostname, port, path: req.url, method: req.method, headers: req.headers, timeout: 60_000 }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('timeout', () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"office_service_unavailable"}'); });
    req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/') || listen !== 14720) { socket.destroy(); return; }
    const upstream = net.connect(port, hostname, () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
      for (let i = 0; i < req.rawHeaders.length; i += 2) upstream.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
      upstream.write('\r\n'); if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
  });
  server.listen(listen, '0.0.0.0');
}
