import http from 'node:http';
import net from 'node:net';

// A fixed reverse proxy for the outbound office tunnel. No account tokens,
// database, attachments, model runtime, or customer-message logs live here.
const bind = process.env.RELAY_BIND || '127.0.0.1';
const port = Number(process.env.RELAY_PORT || 14730);
const inboxHost = process.env.INBOX_HOST;
const workspaceHost = process.env.WORKSPACE_HOST;
if (!inboxHost || !workspaceHost) throw new Error('Both public hosts are required');
function target(req) {
  const host = (req.headers.host || '').toLowerCase();
  if (host === inboxHost.toLowerCase() && !req.url.startsWith('/ake/internal/')) return 24720;
  if (host === workspaceHost.toLowerCase() && (req.url === '/sales' || req.url.startsWith('/sales/'))) return 24721;
  return null;
}
const server = http.createServer((req, res) => {
  const upstreamPort = target(req);
  if (!upstreamPort || !req.url.startsWith('/')) { res.writeHead(404).end(); return; }
  const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method,
    headers: req.headers, timeout: 60_000 }, response => {
    res.writeHead(response.statusCode, response.headers); response.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => {
    // Never acknowledge an unpersisted message or automatically retry a POST.
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '10' });
    res.end(JSON.stringify({ error: 'office_temporarily_unavailable', message: '连接正在恢复，请保留未发送内容后重试。' }));
  });
  req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
});
server.on('upgrade', (req, socket, head) => {
  const upstreamPort = target(req);
  if (upstreamPort !== 24720 || req.url.split('?')[0] !== '/cable') { socket.destroy(); return; }
  const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n`);
    for (let n = 0; n < req.rawHeaders.length; n += 2) upstream.write(`${req.rawHeaders[n]}: ${req.rawHeaders[n + 1]}\r\n`);
    upstream.write('\r\n'); if (head.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); socket.on('close', () => upstream.destroy());
});
server.listen(port, bind);
