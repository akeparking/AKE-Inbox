(() => {
  'use strict';
  if (!window.chatwootWebChannel?.websiteToken || window.akeConversationExperience) return;
  window.akeConversationExperience = true;
  const token = window.chatwootWebChannel.websiteToken;
  const messages = new Map();
  const style = document.createElement('style');
  style.textContent = `
    .ake-has-message-meta { display:flex; flex-direction:column; align-items:stretch; }
    .ake-has-message-meta > .agent-name { display:none !important; }
    .ake-message-meta { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin:5px 4px 8px; font:11px/1.5 system-ui,sans-serif; color:#64748b; }
    .user-message .ake-message-meta { justify-content:flex-end; text-align:right; }
    .ake-message-meta[data-receipt=read] .ake-receipt { color:#2563eb; }
    .ake-message-meta[data-receipt=failed] { color:#b91c1c; }
    .dark .ake-message-meta { color:#a8b5c7; }
    .dark .ake-message-meta[data-receipt=read] .ake-receipt { color:#93c5fd; }
    .ake-continuity-note { margin:4px 12px 8px; color:#64748b; text-align:center; font:11px/1.5 system-ui,sans-serif; }
  `;
  document.head.append(style);
  let busy = false, timer, previousIds = '', lastFetch = 0, lastState;

  function elements() { return [...document.querySelectorAll('[id^="cwmsg-"]')]; }
  function idFor(element) { const match = element.id.match(/^cwmsg-(\d+)$/); return match ? Number(match[1]) : null; }
  function makeText(tag, text, className) {
    const node = document.createElement(tag); node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function render() {
    const container = document.querySelector('.conversation--container');
    const followBottom = container && container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    let changed = false;
    for (const element of elements()) {
      const own = element.classList.contains('user-message-wrap');
      const wrap = element.querySelector(own ? '.user-message > .message-wrap' : '.agent-message > .message-wrap');
      if (!wrap) continue;
      const item = messages.get(idFor(element));
      const failed = own && wrap.classList.contains('is-failed');
      const pending = own && wrap.classList.contains('in-progress');
      if (!item && !failed && !pending) continue;
      const date = item && new Date(item.created_at);
      const clock = date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, {hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date) : '';
      const receipt = failed ? 'failed' : pending ? 'sending' : item?.receipt;
      const label = ({read:'Read',delivered:'Delivered',failed:'Not sent',sending:'Sending…'})[receipt] || '';
      const name = own ? '' : item?.sender_name || '';
      const fingerprint = JSON.stringify([name,clock,receipt,item?.sender_kind]);
      let meta = wrap.querySelector(':scope > .ake-message-meta');
      if (meta?.dataset.fingerprint === fingerprint) continue;
      changed = true;
      if (!meta) { meta = document.createElement('div'); meta.className = 'ake-message-meta'; wrap.append(meta); }
      wrap.classList.add('ake-has-message-meta');
      meta.dataset.fingerprint = fingerprint;
      meta.dataset.receipt = receipt || '';
      const parts = [];
      if (name) parts.push(makeText('span', name, 'ake-sender-name'));
      if (clock) {
        const time = makeText('time', clock); time.dateTime = item.created_at;
        time.title = date.toLocaleString(); parts.push(time);
      }
      if (label) {
        const status = makeText('span', label, 'ake-receipt');
        status.title = receipt === 'read' ? 'Viewed by a member of our team' : receipt === 'delivered' ? 'Received by our support system' : label;
        parts.push(status);
      }
      meta.replaceChildren(...parts.flatMap((part, index) => index ? [makeText('span', '·'), part] : [part]));
    }
    if (lastState?.email_continuity && lastState.has_email && lastState.has_conversation) {
      if (container && !container.querySelector('.ake-continuity-note')) {
        const note = makeText('p', 'Away from this page? We’ll email unread replies. You can reply directly to the email.', 'ake-continuity-note');
        container.append(note);
        changed = true;
      }
    } else document.querySelectorAll('.ake-continuity-note').forEach(node => node.remove());
    if (changed && followBottom) container.scrollTop = container.scrollHeight;
  }
  async function refresh() {
    render();
    if (busy || document.visibilityState === 'hidden') return;
    const ids = elements().map(idFor).filter(Boolean).slice(-100).join(',');
    if (ids === previousIds && Date.now() - lastFetch < 4000) return;
    busy = true;
    try {
      const query = new URLSearchParams({website_token:token,ids});
      const response = await fetch('/api/v1/widget/ake_conversation_state?' + query, {
        headers:{'X-Auth-Token':window.authToken}, cache:'no-store', signal:AbortSignal.timeout(8000)
      });
      if (!response.ok) return;
      const data = await response.json();
      for (const item of data.messages || []) {
        const previous = messages.get(item.id);
        if (previous?.receipt === 'read') item.receipt = 'read';
        messages.set(item.id, item);
      }
      previousIds = ids; lastFetch = Date.now(); lastState = data;
      window.dispatchEvent(new CustomEvent('ake:conversation-state', {detail:{hasConversation:!!data.has_conversation}}));
      render();
    } catch { /* Keep verified metadata during temporary connectivity failures. */ }
    finally { busy = false; }
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 150); }
  new MutationObserver(schedule).observe(document.body, {childList:true,subtree:true});
  document.addEventListener('visibilitychange', schedule);
  setInterval(refresh, 4000);
  refresh();
})();
