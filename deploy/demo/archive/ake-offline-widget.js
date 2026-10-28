(() => {
  'use strict';
  if (!window.chatwootWebChannel?.websiteToken || document.getElementById('ake-offline-form')) return;
  const token = window.chatwootWebChannel.websiteToken;
  const layer = document.createElement('section');
  layer.id = 'ake-offline-form'; layer.lang = 'en'; layer.hidden = true;
  layer.setAttribute('aria-labelledby', 'ake-offline-title');
  layer.innerHTML = `<style>
    #ake-offline-form[hidden]{display:none}
    #ake-offline-form{position:fixed;inset:0;z-index:10000;overflow:auto;background:#fff;color:#24323e;font:14px/1.55 system-ui,sans-serif;color-scheme:light}
    #ake-offline-form *{box-sizing:border-box}
    #ake-offline-form header{min-height:76px;background:#da251d;color:#fff;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 24px}
    #ake-offline-form header strong{display:block;font-size:17px;letter-spacing:.1px}
    #ake-offline-form .ake-offline-status{display:flex;align-items:center;gap:7px;font-size:12px;margin-top:3px;color:#fff}
    #ake-offline-form .ake-offline-status:before{content:"";width:6px;height:6px;border:1px solid currentColor;border-radius:50%}
    #ake-offline-form .ake-close{min-width:44px;min-height:44px;margin-right:-12px;padding:8px;background:transparent;color:#fff;border:1px solid #ffffff60;border-radius:8px;font:13px system-ui;cursor:pointer}
    #ake-offline-form .ake-close[hidden]{display:none}
    #ake-offline-form .ake-form-body{padding:24px;max-width:480px;margin:auto}
    #ake-offline-form h2{font-size:21px;line-height:1.3;font-weight:650;letter-spacing:-.4px;margin:0 0 10px;outline-offset:4px}
    #ake-offline-form .ake-intro{margin:0 0 24px;color:#62717e;font-size:14px}
    #ake-offline-form .ake-field{margin:0 0 16px}
    #ake-offline-form label{display:flex;justify-content:space-between;gap:8px;margin:0 0 6px;padding:0;font-size:13px;font-weight:600;text-transform:none}
    #ake-offline-form .ake-optional{font-size:12px;color:#71808c;font-weight:400}
    #ake-offline-form input,#ake-offline-form textarea{display:block;width:100%;min-height:44px;padding:11px 12px;margin:0;border:1px solid #d8e0e6;border-radius:8px;background:#fff;color:#24323e;font:14px/1.5 system-ui;outline:none;box-shadow:none}
    #ake-offline-form input::placeholder,#ake-offline-form textarea::placeholder{color:#7b8893}
    #ake-offline-form textarea{min-height:100px;resize:vertical}
    #ake-offline-form input:hover,#ake-offline-form textarea:hover{border-color:#9eacb8}
    #ake-offline-form input:focus,#ake-offline-form textarea:focus{border-color:#da251d;box-shadow:0 0 0 3px #da251d14}
    #ake-offline-form [aria-invalid=true]{border-color:#b91c1c}
    #ake-offline-form .ake-field-error{display:block;min-height:0;margin:4px 0 0;color:#b91c1c;font-size:12px}
    #ake-offline-form .ake-field-error:empty{display:none}
    #ake-offline-form .ake-submit{width:100%;min-height:46px;margin:4px 0 0;padding:12px 16px;border:0;border-radius:8px;background:#da251d;color:#fff;font:600 14px system-ui;cursor:pointer}
    #ake-offline-form .ake-submit:hover{background:#bc2019}
    #ake-offline-form button:disabled{opacity:.65;cursor:wait}
    #ake-offline-form :focus-visible{outline:2px solid #98221c;outline-offset:3px}
    #ake-offline-form .ake-close:focus-visible{outline-color:#fff}
    #ake-offline-form .ake-helper{font-size:12px;color:#62717e;margin:10px 0 0;text-align:center}
    #ake-offline-form .ake-powered{display:block;border-top:1px solid #edf0f3;padding-top:16px;margin-top:24px;color:#71808c;text-align:center;font-size:12px;white-space:nowrap}
    #ake-offline-form [role=status]{margin:12px 0 0;color:#b91c1c;font-size:13px}
    #ake-offline-form [role=status]:empty{display:none}
    #ake-offline-form[data-submitted=true] .ake-form-body{padding-top:40px}
    @media(max-width:350px){#ake-offline-form header{padding:14px 18px}#ake-offline-form .ake-form-body{padding:20px 18px}#ake-offline-form h2{font-size:20px}}
  </style>
  <header><div><strong>AKE Parking</strong><span class="ake-offline-status">Team offline</span></div><button class="ake-close" type="button" aria-label="Close chat" hidden>Close</button></header>
  <div class="ake-form-body">
    <h2 id="ake-offline-title" tabindex="-1">Tell us about your project</h2>
    <p class="ake-intro">Leave your details and a message. Our team will follow up by email.</p>
    <form novalidate>
      <div class="ake-field"><label for="ake-visitor-email">Work email</label><input id="ake-visitor-email" name="email" type="email" required maxlength="254" autocomplete="email" placeholder="you@company.com" aria-describedby="ake-email-error"><span id="ake-email-error" class="ake-field-error"></span></div>
      <div class="ake-field"><label for="ake-visitor-name">Your name <span class="ake-optional">Optional</span></label><input id="ake-visitor-name" name="name" maxlength="120" autocomplete="name" placeholder="Full name" aria-describedby="ake-name-error"><span id="ake-name-error" class="ake-field-error"></span></div>
      <div class="ake-field"><label for="ake-visitor-company">Company <span class="ake-optional">Optional</span></label><input id="ake-visitor-company" name="company" maxlength="200" autocomplete="organization" placeholder="Company name" aria-describedby="ake-company-error"><span id="ake-company-error" class="ake-field-error"></span></div>
      <div class="ake-field"><label for="ake-visitor-message">Project details</label><textarea id="ake-visitor-message" name="message" required maxlength="5000" rows="3" placeholder="What are you planning? Include your location and project requirements." aria-describedby="ake-message-error"></textarea><span id="ake-message-error" class="ake-field-error"></span></div>
      <button class="ake-submit" type="submit">Send message</button>
      <p class="ake-helper">We'll use your email to reply to this inquiry.</p>
      <p role="status" aria-live="polite"></p>
    </form>
    <small class="ake-powered">Powered by AKE Parking</small>
  </div>`;
  document.body.append(layer);
  const form = layer.querySelector('form');
  const button = layer.querySelector('.ake-submit');
  const status = layer.querySelector('[role=status]');
  const close = layer.querySelector('.ake-close');
  if (window.self !== window.top || window.ReactNativeWebView) {
    close.hidden = false;
    close.onclick = () => {
      if (window.self !== window.top) window.parent.postMessage('chatwoot-widget:{"event":"closeWindow"}', '*');
      else window.ReactNativeWebView.postMessage('chatwoot-widget:{"type":"close-widget"}');
    };
  }
  let busy = false, submitted = false, checking = false, hasConversation = false;
  const submission = crypto.randomUUID();
  function show(visible) {
    layer.hidden = !visible;
    const app = document.getElementById('app');
    if (app) {
      app.inert = visible;
      if (visible) app.setAttribute('aria-hidden', 'true');
      else app.removeAttribute('aria-hidden');
    }
  }
  layer.addEventListener('keydown', event => { if (event.key === 'Escape' && !close.hidden) close.click(); });
  // Returning visitors retain their existing thread even when agents go offline.
  window.addEventListener('ake:conversation-state', event => {
    hasConversation = event.detail?.hasConversation === true;
    if (hasConversation && !submitted) show(false);
  });
  async function availability() {
    if (checking || busy) return;
    checking = true;
    try {
      const response = await fetch(`/api/v1/widget/ake_availability?website_token=${encodeURIComponent(token)}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const data = await response.json();
      const dirty = [...form.elements].some(field => field.value?.trim());
      show(submitted || (!hasConversation && (!data.online || dirty)));
    } catch { /* Preserve the last known state and entered values during an outage. */ }
    finally { checking = false; }
  }
  function validate(field) {
    let error = '';
    if (field.required && !field.value.trim()) error = field.name === 'email' ? 'Please enter your work email.' : 'Please tell us about your project.';
    else if (field.validity.typeMismatch) error = 'Please enter a valid email address.';
    else if (field.validity.tooLong) error = `Please use ${field.maxLength} characters or fewer.`;
    field.setAttribute('aria-invalid', String(!!error));
    layer.querySelector(`#ake-${field.name}-error`).textContent = error;
    return !error;
  }
  form.addEventListener('input', event => {
    if (event.target.getAttribute('aria-invalid') === 'true') validate(event.target);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || submitted) return;
    const invalid = [...form.querySelectorAll('input,textarea')].filter(field => !validate(field));
    if (invalid.length) { status.textContent = 'Please check the highlighted fields.'; invalid[0].focus(); return; }
    busy = true; button.disabled = true; button.textContent = 'Sending…'; status.textContent = ''; form.setAttribute('aria-busy', 'true');
    try {
      const values = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]));
      const response = await fetch(`/api/v1/widget/ake_offline?website_token=${encodeURIComponent(token)}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Auth-Token': window.authToken },
        body: JSON.stringify({ ...values, submission_id: submission }), signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error();
      submitted = true; layer.dataset.submitted = 'true';
      layer.querySelector('h2').textContent = 'Message received';
      layer.querySelector('.ake-intro').textContent = 'Thank you for reaching out. Our team will reply to the email address you provided.';
      form.hidden = true; layer.querySelector('h2').focus();
    } catch { status.textContent = 'Your message could not be sent. Please try again. Your details are still here.'; }
    finally { busy = false; button.disabled = false; button.textContent = 'Send message'; form.removeAttribute('aria-busy'); }
  });
  availability(); setInterval(availability, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) availability(); });
})();
