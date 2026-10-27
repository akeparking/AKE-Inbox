// No customer content, credentials or external URLs enter Windows toast payloads.
function activationTarget(value) {
  const match = /^ake-inbox:(\d+):(\d+)$/.exec(value || '');
  if (!match) return null;
  const [accountId, conversationId] = match.slice(1).map(Number);
  return [accountId, conversationId].every(n => Number.isSafeInteger(n) && n > 0) ? { accountId, conversationId } : null;
}
function toastXml({ accountId, conversationId, count, recovered }, sound) {
  const launch = `ake-inbox:${accountId}:${conversationId}`;
  if (!activationTarget(launch)) throw new Error('Invalid notification target');
  const body = recovered || count > 1 ? '你有新的客户消息，请打开工作台查看。' : '你有新的客户消息';
  return `<toast launch="${launch}" activationType="foreground"><visual><binding template="ToastGeneric"><text>AKE Inbox</text><text>${body}</text></binding></visual>${sound ? '' : '<audio silent="true"/>'}</toast>`;
}
module.exports = { activationTarget, toastXml };
