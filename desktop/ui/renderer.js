const bridge = window.inboxDesktop;
const feedback = document.querySelector('#feedback');
let hydrated = false;
function render(state) {
  document.querySelector('#setup').hidden = state.pane !== 'settings';
  const labels = { unconfigured: '尚未连接', configured: '主机已配置', connecting: '正在连接', connected: '页面已连接', failed: '连接中断' };
  document.querySelector('#connection span').textContent = labels[state.connection] || '尚未连接';
  document.querySelector('#connection').classList.toggle('live', state.connection === 'connected');
  document.querySelector('#version').textContent = state.version;
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
if (bridge) { bridge.subscribe(render); bridge.status().then(render); }
else { feedback.textContent = '浏览器设计预览；请用 Windows APP 连接主机。'; document.querySelector('#connect').disabled = true; }
