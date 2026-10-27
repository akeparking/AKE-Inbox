const bridge = window.inboxDesktop;
const feedback = document.querySelector('#feedback');
let hydrated = false;
function render(state) {
  document.querySelector('#setup').hidden = state.pane !== 'settings';
  const labels = { unconfigured: '尚未连接', configured: '主机已配置', connecting: '正在连接', connected: '主机已连接', failed: '主机暂不可用', signed_out: '请登录接待台', incompatible: '主机需要升级', forbidden: '账号尚无接待权限' };
  document.querySelector('#connection span').textContent = labels[state.connection] || '尚未连接';
  document.querySelector('#connection').classList.toggle('live', state.connection === 'connected');
  document.querySelector('#version').textContent = state.version;
  const reception = state.reception || {};
  const presence = document.querySelector('#presence');
  presence.disabled = !reception.authenticated;
  presence.textContent = reception.online ? '接待中 · 暂停' : reception.paused ? '已暂停 · 开始' : '开始接待';
  presence.dataset.online = String(reception.online);
  document.querySelector('#unread').textContent = reception.unreadCount ? `${reception.unreadCount} 条未读` : '暂无未读';
  for (const key of ['notifications','sound','launchAtLogin']) document.querySelector(`[name=${key}]`).checked = state.preferences?.[key] === true;
  const updates = { idle:'可手动检查新版本', checking:'正在检查 GitHub…', current:'当前没有更新的正式 Windows 版本', unavailable:'暂时无法连接 GitHub，接待不受影响', available:`发现新版本 ${state.update?.version || ''}` };
  document.querySelector('#update-status').textContent = updates[state.update?.state] || '';
  document.querySelector('#download-update').hidden = state.update?.state !== 'available';
  document.querySelector('#check-updates').disabled = state.update?.state === 'checking';
  document.querySelectorAll('[data-pane]').forEach(button => { button.disabled = !state.config || state.connection === 'connecting'; button.classList.toggle('selected', button.dataset.pane === state.pane); });
  document.querySelector('#settings').classList.toggle('selected', state.pane === 'settings');
  document.querySelector('#connect').disabled = state.connection === 'connecting';
  if (!hydrated && state.config) { document.querySelector('#inbox-url').value = state.config.inboxUrl; document.querySelector('#workspace-url').value = state.config.workspaceUrl; hydrated = true; }
  feedback.textContent = state.error || state.notice || '';
}
document.querySelector('#host-form').addEventListener('submit', async event => {
  event.preventDefault(); feedback.textContent = '正在连接办公室主机…';
  render(await bridge.connect({ inboxUrl: document.querySelector('#inbox-url').value, workspaceUrl: document.querySelector('#workspace-url').value }));
});
document.querySelectorAll('[data-pane]').forEach(button => button.addEventListener('click', async () => render(await bridge.open(button.dataset.pane))));
document.querySelector('#settings').addEventListener('click', async () => render(await bridge.settings()));
document.querySelector('#clear-session').addEventListener('click', async () => render(await bridge.clearSession()));
document.querySelector('#presence').addEventListener('click', async event => render(await bridge.setOnline(event.currentTarget.dataset.online !== 'true')));
document.querySelector('#reconnect').addEventListener('click', async () => render(await bridge.reconnect()));
document.querySelector('#check-updates').addEventListener('click', async () => render(await bridge.checkUpdates()));
document.querySelector('#download-update').addEventListener('click', async () => render(await bridge.downloadUpdate()));
document.querySelector('#preferences').addEventListener('change', async () => render(await bridge.preferences(Object.fromEntries(['notifications','sound','launchAtLogin'].map(k => [k,document.querySelector(`[name=${k}]`).checked])))));
if (bridge) { bridge.subscribe(render); bridge.status().then(render); }
else { feedback.textContent = '浏览器设计预览；请用 Windows APP 连接主机。'; document.querySelector('#connect').disabled = true; }
