import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeReception, canDeliverAi } from '../reception-policy.mjs';
const seat = (id, patch = {}) => ({ id, accountId: 1, inboxIds: [1, 2], confirmed: true, status: 'online', leaseUntil: 1000, ...patch });
const input = patch => ({ seats: [seat(1), seat(2), seat(3)], accountId: 1, inboxId: 1, now: 100, aiReady: true, ...patch });
test('new conversations rotate in order and expired/offline seats are skipped', () => {
  let cursor = 0; const owners = [];
  for (let i = 0; i < 5; i++) { const r = routeReception(input({ cursor, seats: [seat(1), seat(2, { leaseUntil: 100 }), seat(3)] })); owners.push(r.ownerId); cursor = r.cursor; }
  assert.deepEqual(owners, [1, 3, 1, 3, 1]);
});
test('account, membership, activation and manual status bound eligibility', () => {
  const seats = [seat(1, { accountId: 2 }), seat(2, { inboxIds: [3] }), seat(3, { confirmed: false }), seat(4, { status: 'away' })];
  assert.equal(routeReception(input({ seats })).mode, 'ai');
});
test('existing online owner stays; dropped owner is reassigned', () => {
  assert.equal(routeReception(input({ current: { mode: 'human', ownerId: 2 } })).ownerId, 2);
  assert.equal(routeReception(input({ current: { mode: 'human', ownerId: 9 }, cursor: 2 })).ownerId, 3);
});
test('all offline routes to AI only when available; explicit human requests wait', () => {
  assert.equal(routeReception(input({ seats: [] })).mode, 'ai');
  assert.equal(routeReception(input({ seats: [], aiReady: false })).mode, 'human_pending');
  assert.equal(routeReception(input({ seats: [], current: { requestedHuman: true } })).mode, 'human_pending');
});
test('returning human takes over an AI conversation and cancels stale output', () => {
  assert.equal(routeReception(input({ current: { mode: 'ai' } })).cancelAi, true);
  const draft = { draftRevision: 7, conversationRevision: 7, mode: 'ai', eligibleOnlineCount: 0 };
  assert.equal(canDeliverAi(draft), true);
  assert.equal(canDeliverAi({ ...draft, conversationRevision: 8 }), false);
  assert.equal(canDeliverAi({ ...draft, eligibleOnlineCount: 1 }), false);
  assert.equal(canDeliverAi({ ...draft, mode: 'human' }), false);
});
test('pause, block and opt out cannot be overridden by availability', () => {
  for (const flag of ['paused', 'blocked', 'optedOut', 'resolved']) assert.equal(routeReception(input({ current: { [flag]: true } })).mode, 'paused');
});
