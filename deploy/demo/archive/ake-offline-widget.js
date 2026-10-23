(() => {
  if (!window.chatwootWebChannel?.websiteToken) return;
  const token = window.chatwootWebChannel.websiteToken;
  const zh = (navigator.language || '').startsWith('zh');
  const copy = zh ? ['给我们留言', '目前没有坐席在线。请留下您的信息，我们上线后会联系您。', '姓名', '邮箱', '留言', '提交留言', '留言已收到', '我们会通过您填写的邮箱与您联系。', '提交失败，请稍后重试。'] : ['Leave us a message', 'Our team is offline. Leave your details and we will get back to you.', 'Name', 'Email', 'Message', 'Send message', 'Message received', 'Our team will contact you at the email you provided.', 'Could not submit. Please try again.'];
  const layer = document.createElement('section'); layer.id = 'ake-offline-form'; layer.hidden = true;
  layer.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#fff;color:#273540;overflow:auto;font:14px/1.55 system-ui';
  const companyLabel = zh ? '公司名称' : 'Company name';
  layer.innerHTML = `<style>
#ake-offline-form[hidden]{display:none}#ake-offline-form *{box-sizing:border-box}#ake-offline-form header{height:64px;background:#da251d;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 20px}#ake-offline-form header strong{font-size:16px}#ake-offline-form header span{font-size:13px}#ake-offline-form header span:before{content:"";display:inline-block;width:7px;height:7px;background:#ffd2cf;border-radius:50%;margin-right:7px}#ake-offline-form .ake-form-body{padding:20px 18px}#ake-offline-form h2{font-size:19px;margin:0 0 8px}#ake-offline-form p{margin:7px 0 18px;color:#677681}#ake-offline-form form{background:#eff3f6;border-radius:10px;padding:18px}#ake-offline-form label{display:block;margin:0 0 15px;color:#586773;font-size:13px}#ake-offline-form em{font-style:normal;color:#da251d}#ake-offline-form input,#ake-offline-form textarea{display:block;width:100%;padding:11px;margin-top:6px;border:1px solid #e0e6eb;border-radius:5px;background:white;font:14px system-ui;color:#273540;min-height:44px}#ake-offline-form textarea{resize:vertical}#ake-offline-form button{display:block;min-height:44px;background:#da251d;color:white;border:0;border-radius:22px;margin:20px auto 0;padding:10px 26px;font:inherit;cursor:pointer}#ake-offline-form button:disabled{opacity:.6}#ake-offline-form :focus-visible{outline:2px solid #a11b17;outline-offset:2px}#ake-offline-form small{display:block;text-align:center;margin-top:20px;color:#78848d;font-size:11px;white-space:nowrap}#ake-offline-form [role=status]{margin-bottom:0;color:#a11b17}
</style><header><strong>AKE Parking</strong><span>${zh ? '离线' : 'Offline'}</span></header><div class="ake-form-body"><h2>${copy[0]}</h2><p>${copy[1]}</p><form><label><em>*</em> ${copy[3]}<input name="email" type="email" required maxlength="254" autocomplete="email"></label><label>${copy[2]}<input name="name" maxlength="120" autocomplete="name"></label><label>${companyLabel}<input name="company" maxlength="200" autocomplete="organization"></label><label><em>*</em> ${copy[4]}<textarea name="message" required maxlength="5000" rows="3"></textarea></label><button type="submit">${copy[5]}</button><p role="status" aria-live="polite"></p></form><small>Powered by AKE Parking</small></div>`;
  document.body.append(layer);
  let busy = false, submitted = false, checking = false, hasConversation = false;
  // An existing conversation must remain accessible when agents go offline,
  // including when a visitor returns after replying through email.
  window.addEventListener('ake:conversation-state', event => {
    hasConversation = event.detail?.hasConversation === true;
    if (hasConversation && !submitted) layer.hidden = true;
  });
  const submission = crypto.randomUUID();
  async function availability() {
    if (checking || busy) return; checking = true;
    try {
      const r = await fetch(`/api/v1/widget/ake_availability?website_token=${encodeURIComponent(token)}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const data = await r.json();
      // Keep a partly completed form intact if an agent comes online mid-entry.
      const dirty = [...layer.querySelectorAll('input,textarea')].some(x => x.value);
      layer.hidden = !submitted && (hasConversation || (data.online && !dirty));
    } catch { /* Keep the last known UI during a transient status failure. */ }
    finally { checking = false; }
  }
  layer.querySelector('form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || submitted) return; busy = true;
    const button = event.submitter, message = layer.querySelector('[role=status]'); button.disabled = true; message.textContent = '';
    try {
      const response = await fetch(`/api/v1/widget/ake_offline?website_token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Auth-Token': window.authToken },
        body: JSON.stringify({ ...Object.fromEntries(new FormData(event.target)), submission_id: submission }), signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error();
      submitted = true; layer.querySelector('h2').textContent = copy[6]; layer.querySelector('p').textContent = copy[7]; event.target.hidden = true;
    } catch { message.textContent = copy[8]; }
    finally { busy = false; button.disabled = false; }
  });
  availability(); setInterval(availability, 15000);
  addEventListener('visibilitychange', availability);
})();
