const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../deploy/demo/archive/ake-api.js'), 'utf8');

async function rotate({ expiry = '2000000000', responseExpiry = expiry, protocol = 'https:' } = {}) {
  const writes = [];
  const original = { 'access-token': 'fictional-old', client: 'fictional-client', uid: 'fictional@example.invalid', expiry };
  const document = {
    get cookie() { return 'cw_d_session_info=' + encodeURIComponent(JSON.stringify(original)); },
    set cookie(value) { writes.push(value); }
  };
  const context = { window: {}, document, location: { pathname: '/widget', protocol }, AbortSignal,
    fetch: async () => ({ ok: true, status: 200, headers: { get: key => ({ 'access-token': 'fictional-new', expiry: responseExpiry }[key] || null) }, json: async () => ({ ok: true }) }) };
  vm.runInNewContext(source, context);
  await context.window.akeApi(1, '/inboxes');
  assert.equal(writes.length, 1);
  return writes[0];
}

test('native token rotation retains persistent expiry, secure and same-site attributes', async () => {
  const cookie = await rotate();
  assert.match(cookie, /; Secure; SameSite=Lax/);
  assert.ok(cookie.endsWith('; Expires=' + new Date(2000000000 * 1000).toUTCString()));
  assert.equal(JSON.parse(decodeURIComponent(cookie.split(';')[0].split('=')[1]))['access-token'], 'fictional-new');
});
test('missing response expiry retains the valid expiry already held by the session', async () => {
  assert.ok((await rotate({ responseExpiry: '' })).endsWith('; Expires=' + new Date(2000000000 * 1000).toUTCString()));
});
test('an expired rotated token is expired in the cookie rather than extended', async () => {
  assert.ok((await rotate({ responseExpiry: '1' })).endsWith('; Expires=Thu, 01 Jan 1970 00:00:01 GMT'));
});
test('malformed expiry cannot inject attributes or create an invalid persistent cookie', async () => {
  const cookie = await rotate({ responseExpiry: 'invalid; Domain=example.invalid' });
  assert.doesNotMatch(cookie, /; (Expires|Domain)=/);
  assert.doesNotMatch(cookie, /Invalid Date/);
});
