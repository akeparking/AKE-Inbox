const { test } = require('node:test');
const assert = require('node:assert/strict');
const { endpoint, sameOrigin, settings, crmWorkspaceTarget } = require('../config.cjs');
test('accepts WSL loopback and HTTPS office hosts', () => {
  assert.equal(endpoint('http://localhost:14720/app/login'), 'http://localhost:14720/app/login');
  assert.equal(endpoint('https://inbox.example.invalid/app'), 'https://inbox.example.invalid/app');
});
test('rejects credentials, tokens, insecure remote hosts and privileged schemes', () => {
  for (const url of ['http://192.168.1.2:3000', 'https://user:password@example.invalid', 'https://example.invalid?token=secret', 'file:///etc/passwd', 'javascript:alert(1)', 'http://localhost.evil.invalid', 'https://example.invalid/#token']) assert.throws(() => endpoint(url));
});
test('navigation allowlist compares exact origins', () => {
  assert.equal(sameOrigin('https://example.invalid/app', 'https://example.invalid/login'), true);
  for (const url of ['https://example.invalid.evil.test/', 'http://example.invalid', 'https://example.invalid:8443/', 'file:///tmp/a']) assert.equal(sameOrigin(url, 'https://example.invalid'), false);
});
test('stores only endpoints', () => assert.deepEqual(Object.keys(settings({ inboxUrl: 'http://localhost', workspaceUrl: 'http://localhost:2', token: 'not-stored' })), ['inboxUrl', 'workspaceUrl']));
test('CRM links open only the configured workspace origin and exact CRM route', () => {
  const workspace = 'https://workspace.example.invalid:8443/sales/inbox';
  assert.equal(crmWorkspaceTarget('https://workspace.example.invalid:8443/sales/saas', workspace), 'https://workspace.example.invalid:8443/sales/saas');
  for (const target of ['https://workspace.example.invalid/sales/saas', 'https://workspace.example.invalid.evil.test:8443/sales/saas', 'https://workspace.example.invalid:8443/sales/saas?token=test', 'https://workspace.example.invalid:8443/elsewhere', 'javascript:alert(1)']) assert.equal(crmWorkspaceTarget(target, workspace), null);
});
