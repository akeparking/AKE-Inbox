(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const account = new URL(location.href).searchParams.get('account') || '1';
  let seats = [], selected, refreshTimer, pollBusy = false;
  const notice = (text, error = false) => { $('notice').textContent = text; $('notice').className = error ? 'error' : 'success'; };
  const credentials = () => {
    const raw = document.cookie.split('; ').find(x => x.startsWith('cw_d_session_info='));
    if (!raw) throw new Error('请先登录 Inbox，再打开「我的渠道」。');
    return JSON.parse(decodeURIComponent(raw.slice(raw.indexOf('=') + 1)));
  };
  async function api(path, body) {
    const auth = credentials();
    const headers = { 'content-type': 'application/json' };
    for (const k of ['access-token', 'client', 'uid', 'token-type']) if (auth[k]) headers[k] = auth[k];
    const response = await fetch(`/api/v1/accounts/${encodeURIComponent(account)}/ake_seats${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers, credentials: 'same-origin', cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    if (response.headers.get('access-token')) {
      for (const k of ['access-token', 'client', 'uid', 'token-type', 'expiry']) if (response.headers.get(k)) auth[k] = response.headers.get(k);
      document.cookie = `cw_d_session_info=${encodeURIComponent(JSON.stringify(auth))}; Path=/; Secure; SameSite=Lax`;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || (response.status === 401 ? '登录已过期，请重新登录 Inbox。' : '操作失败，请稍后重试。'));
    return data;
  }
  async function status() {
    if (!selected || pollBusy) return;
    const seatId = selected.id; pollBusy = true;
    try {
      const data = await api(`/${seatId}/whatsapp`);
      if (selected.id !== seatId) return;
      $('wa-state').textContent = ({ open: '已连接', connecting: '等待手机扫码', close: '未连接', closed: '未连接', not_configured: '尚未配置渠道' })[data.state] || '正在检查连接';
      if (data.state === 'open') { clearTimeout(refreshTimer); $('qr').hidden = true; $('qr').removeAttribute('src'); $('qr-hint').textContent = '已关联成功，可以返回 Inbox 查看消息。'; }
    } catch (e) { $('wa-state').textContent = e.message; }
    finally { pollBusy = false; }
  }
  async function connect() {
    if (!selected) return;
    const seatId = selected.id;
    clearTimeout(refreshTimer); $('connect').disabled = true;
    try {
      const data = await api(`/${seatId}/whatsapp/connect`, {});
      if (selected.id !== seatId) return;
      if (data.connected) { $('qr').hidden = true; $('qr').removeAttribute('src'); $('qr-hint').textContent = '此坐席已经连接。'; }
      else if (data.qr) {
        $('qr').src = data.qr; $('qr').hidden = false;
        $('qr-hint').textContent = '请扫描当前二维码；二维码会自动刷新。请勿把此二维码分享给他人。';
        refreshTimer = setTimeout(connect, (data.expires_in || 35) * 1000);
      } else { $('qr').hidden = true; $('qr-hint').textContent = '正在生成二维码…'; refreshTimer = setTimeout(connect, 4000); }
      await status();
    } catch (e) { notice(e.message, true); }
    finally { $('connect').disabled = false; }
  }
  function select() {
    selected = seats.find(s => String(s.id) === $('seat').value);
    clearTimeout(refreshTimer); $('qr').hidden = true; $('qr').removeAttribute('src'); $('qr-hint').textContent = ''; notice('');
    $('seat-state').textContent = selected.legacy ? '管理员管理 · 不参与分配' : !selected.activated ? '尚未激活 · 不参与网站分配' : selected.availability === 'online' ? '在线 · 参与网站分配' : '离线 · 不参与网站分配';
    $('mail-state').textContent = selected.email ? `${selected.email.address} · ${selected.email.receiving && selected.email.sending ? '已开启收发' : '待配置'}` : '尚未绑定邮箱';
    const form = $('mail-form'); form.reset();
    form.hidden = !!selected.legacy;
    $('legacy-mail').hidden = !selected.legacy || !selected.email_inbox_id;
    if(selected.legacy) {
      $('mail-state').textContent = '原有 AKE Export Email 由管理员独立管理。';
      $('legacy-mail').href = `/app/accounts/${account}/settings/inboxes/${selected.email_inbox_id}`;
    }
    for (const name of ['imap_address', 'imap_login', 'smtp_address', 'smtp_login', 'smtp_port']) if (selected.email?.[name]) form.elements[name].value = selected.email[name];
    if (selected.email) form.elements.email.value = selected.email.address;
    $('wa-inbox').hidden = !selected.whatsapp_inbox_id;
    if (selected.whatsapp_inbox_id) $('wa-inbox').href = `/app/accounts/${account}/inbox/${selected.whatsapp_inbox_id}`;
    status();
  }
  async function load() {
    const data = await api(''); seats = data.seats;
    const prior = $('seat').value;
    $('seat').replaceChildren(...seats.map(s => { const o = document.createElement('option'); o.value = s.id; o.textContent = s.name; return o; }));
    if (seats.some(s => String(s.id) === prior)) $('seat').value = prior;
    if (seats.length) select(); else notice('当前账号没有可管理的坐席。', true);
  }
  $('seat').addEventListener('change', select);
  $('connect').addEventListener('click', connect);
  $('mail-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true; notice('正在验证邮箱连接…');
    try { await api(`/${selected.id}/email`, { channel: Object.fromEntries(new FormData(event.target)) }); await load(); notice('邮箱已验证并保存。'); }
    catch (e) { notice(e.message, true); }
    finally { button.disabled = false; }
  });
  $('back').href = `/app/accounts/${account}/dashboard`;
  load().catch(e => notice(e.message, true));
  setInterval(() => { if (!document.hidden) status(); }, 12000);
  addEventListener('pagehide', () => clearTimeout(refreshTimer));
})();
