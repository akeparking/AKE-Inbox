// Executable decision contract for the planned office routing coordinator.
// The caller must transact the cursor + conversation revision in the host database.
// This module is not connected to production ingestion or delivery yet.
export const leaseMs = 75_000;
export function routeReception({ seats, accountId, inboxId, now, cursor = 0, current, aiReady }) {
  const eligible = seats.filter(seat => seat.accountId === accountId && seat.inboxIds.includes(inboxId)
    && seat.confirmed && seat.status === 'online' && seat.leaseUntil > now)
    .map(seat => seat.id).sort((a, b) => a - b);
  const ids = [...new Set(eligible)];
  if (current?.blocked || current?.optedOut || current?.paused || current?.resolved)
    return { mode: 'paused', ownerId: null, cursor, cancelAi: true, reason: 'restricted' };
  if (current?.mode === 'human' && ids.includes(current.ownerId))
    return { mode: 'human', ownerId: current.ownerId, cursor, cancelAi: true, reason: 'keep_online_owner' };
  if (ids.length) {
    const ownerId = ids.find(id => id > cursor) ?? ids[0];
    return { mode: 'human', ownerId, cursor: ownerId, cancelAi: true, reason: 'online_round_robin' };
  }
  if (current?.requestedHuman || current?.manualHold)
    return { mode: 'human_pending', ownerId: null, cursor, cancelAi: true, reason: 'human_required' };
  return { mode: aiReady ? 'ai' : 'human_pending', ownerId: null, cursor, cancelAi: !aiReady, reason: aiReady ? 'all_offline' : 'ai_unavailable' };
}
export function canDeliverAi({ draftRevision, conversationRevision, mode, eligibleOnlineCount, paused, optedOut, blocked }) {
  return draftRevision === conversationRevision && mode === 'ai' && eligibleOnlineCount === 0 && !paused && !optedOut && !blocked;
}
