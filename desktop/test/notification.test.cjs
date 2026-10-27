const test = require('node:test');
const assert = require('node:assert/strict');
const { activationTarget, toastXml } = require('../notification.cjs');
test('notification activation accepts only an account and conversation pair', () => {
  assert.deepEqual(activationTarget('ake-inbox:1:32'), { accountId: 1, conversationId: 32 });
  for (const value of ['', 'https://example.com', 'ake-inbox:0:1', 'ake-inbox:1:9007199254740992', 'ake-inbox:1:2&url=bad']) assert.equal(activationTarget(value), null);
});
test('Windows toast carries a conversation target without customer text', () => {
  const xml = toastXml({ accountId: 1, conversationId: 32, content: 'private customer text' }, false);
  assert.match(xml, /launch="ake-inbox:1:32"/);
  assert.match(xml, /<audio silent="true"\/>/);
  assert.doesNotMatch(xml, /private customer text/);
  assert.doesNotMatch(toastXml({ accountId: 1, conversationId: 32 }, true), /<audio/);
});
