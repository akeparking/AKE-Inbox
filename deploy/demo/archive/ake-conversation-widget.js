(() => {
  'use strict';
  if (!window.chatwootWebChannel?.websiteToken || window.akeConversationExperience) return;
  window.akeConversationExperience = true;
  const token = window.chatwootWebChannel.websiteToken;
  const messages = new Map();
  const style = document.createElement('style');
  style.textContent = `
    html { font-family:system-ui,sans-serif; }
    #app .header-expanded { padding:24px; background:#da251d; }
    #app .header-expanded h2 { color:#fff; font-size:24px; line-height:1.3; letter-spacing:-.5px; font-weight:650; margin-top:8px; }
    #app .header-expanded p { color:#fff; font-size:14px; line-height:1.6; }
    #app .header-expanded .actions button,#app .header-expanded .actions svg { color:#fff; }
    #app .expanded ~ .z-50 { justify-content:flex-start; padding:24px; }
    #app .expanded ~ .z-50 > div { box-shadow:none; border:1px solid #e0e6eb; outline:none; padding:20px; gap:16px; }
    #app .expanded ~ .z-50 button { min-height:44px; justify-content:space-between; border-top:1px solid #edf0f3; padding-top:12px; }
    #app .collapsed header { padding:16px 20px; min-height:76px; border-bottom:1px solid #e0e6eb; }
    #app .collapsed header > div:first-child { min-width:0; }
    #app .actions button,#app .collapsed header > div > button { min-width:44px; min-height:44px; display:inline-flex; align-items:center; justify-content:center; }
    #app .actions .close-button:not(.rn-close-button) { display:none; }
    #app .is-mobile .actions .close-button,#app .is-bubble-hidden .actions .close-button { display:inline-flex; }
    #app .formkit-form { padding:24px; background:#fff; }
    #app .formkit-form > div:first-child { color:#62717e; font-size:14px; line-height:1.6; }
    #app .formkit-outer { margin-top:0; margin-bottom:16px; }
    #app .formkit-label { font-size:13px; color:#24323e; padding:0 0 6px; text-transform:none; }
    #app .formkit-input { min-height:44px; border-radius:8px; font-size:14px; padding:11px 12px; outline-color:#d8e0e6; }
    #app .formkit-input:focus { outline-color:#da251d; box-shadow:0 0 0 3px #da251d14; }
    #app textarea.formkit-input { min-height:112px; resize:vertical; }
    #app .formkit-form > button { min-height:46px; border-radius:8px; margin-top:4px; font-weight:600; }
    #app .formkit-message { font-size:12px; }
    #app button:focus-visible { outline:2px solid #a51e18; outline-offset:3px; }
    #app .conversation--container { background:#f7f9fb; }
    #app .chat-bubble { font-size:14px; line-height:1.6; }
    #app .branding--link { font-size:12px; }
    #app .dark .formkit-form { background:#171b20; }
    #app .dark .formkit-label { color:#e7edf3; }
    #app .dark .formkit-form > div:first-child { color:#bac6d2; }
    #app .dark .conversation--container { background:#171b20; }
    @media(max-width:350px) { #app .header-expanded { padding:20px 18px; } #app .expanded ~ .z-50,#app .formkit-form { padding:20px 18px; } }
    .ake-has-message-meta { display:flex; flex-direction:column; align-items:stretch; }
    .ake-has-message-meta > .agent-name { display:none !important; }
    .ake-message-meta { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin:5px 4px 8px; font:12px/1.5 system-ui,sans-serif; color:#64748b; }
    .user-message .ake-message-meta { justify-content:flex-end; text-align:right; }
    .ake-message-meta[data-receipt=read] .ake-receipt { color:#2563eb; }
    .ake-message-meta[data-receipt=failed] { color:#b91c1c; }
    .dark .ake-message-meta { color:#a8b5c7; }
    .dark .ake-message-meta[data-receipt=read] .ake-receipt { color:#93c5fd; }
    .ake-continuity-note { margin:8px 16px 12px; color:#64748b; text-align:center; font:12px/1.5 system-ui,sans-serif; }
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
    // FormKit provides localized inline validation. Native browser tooltips
    // use the browser installation language and can otherwise reintroduce Chinese.
    document.querySelectorAll('#app form.formkit-form').forEach(form => { form.noValidate = true; });
    for (const [selector, label] of [
      ['.actions .close-button', 'Close chat'],
      ['.actions .new-window--button', 'Open chat in a new window'],
      ['.collapsed header > div:first-child > button', 'Back to home'],
    ]) {
      document.querySelectorAll(selector).forEach(button => button.setAttribute('aria-label', label));
    }
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
      const clock = date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en', {hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(date) : '';
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
        time.title = date.toLocaleString('en'); parts.push(time);
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
