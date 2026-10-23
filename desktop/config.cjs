const { isIP } = require('node:net');

function endpoint(value) {
  if (typeof value !== 'string' || value.length > 1024) throw new Error('请输入有效的主机地址');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('地址必须包含 http:// 或 https://'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('其他电脑连接主机时请使用 HTTPS；本机 localhost 可以使用 HTTP');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('地址中不能包含密码、查询参数或登录令牌');
  if (isIP(url.hostname) === 4 && url.hostname === '0.0.0.0') throw new Error('请使用具体的主机地址');
  return url.href;
}
function settings(input) {
  return { inboxUrl: endpoint(input?.inboxUrl), workspaceUrl: endpoint(input?.workspaceUrl) };
}
function sameOrigin(target, expected) {
  try { return new URL(target).origin === new URL(expected).origin; } catch { return false; }
}
module.exports = { endpoint, settings, sameOrigin };
