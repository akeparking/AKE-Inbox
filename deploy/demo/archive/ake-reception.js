(() => {
  'use strict';
  let running = false, lastState;
  function draw(state, error = false) {
    const nav = document.getElementById('ake-workspace-nav');
    if (!nav) return;
    let button = document.getElementById('ake-reception-status');
    if (!button) { button = document.createElement('button'); button.id = 'ake-reception-status'; button.type = 'button'; nav.append(button); }
    button.dataset.state = error ? 'error' : state?.online ? 'online' : 'offline';
    button.textContent = error ? '连接中断 · 重试' : state?.online ? '接待中 · 暂停接待' : '已暂停 · 开始接待';
    button.setAttribute('aria-label', error ? '接待连接中断，点击重试' : state?.online ? '当前正在接待，点击暂停接待' : '当前已暂停，点击开始接待');
    button.setAttribute('aria-pressed', String(!error && !!state?.online));
    button.title = error ? '接待状态暂时无法确认，请重试。' : state?.online ? '暂停后停止为此接待实例分配新会话。' : '开始接待后接收新会话。';
    button.disabled = running;
    button.onclick = () => refresh(error ? undefined : state?.online ? 'offline' : 'online');
  }
  async function refresh(state) {
    if (running) return;
    const account = location.pathname.match(/\/app\/accounts\/(\d+)/)?.[1] || new URLSearchParams(location.search).get('account');
    if (!account || (!window.akeDesktopReception && !window.akeApi)) return;
    running = true;
    const button = document.getElementById('ake-reception-status');
    if (button && state) { button.disabled = true; button.textContent = '正在切换…'; }
    try {
      // The desktop main process owns its lease. Do not acquire a second
      // browser lease, or pause other instances when toggling the desktop.
      if (window.akeDesktopReception) {
        if (state) await window.akeDesktopReception.setOnline(state === 'online');
        lastState = await window.akeDesktopReception.status();
      } else lastState = await window.akeApi(account, '/ake_reception/heartbeat', state ? { state } : {});
      running = false; draw(lastState);
    } catch { running = false; draw(lastState, true); }
  }
  window.addEventListener('ake:workspace-ready', () => lastState ? draw(lastState) : refresh());
  if (window.akeDesktopReception) window.akeDesktopReception.subscribe(() => refresh());
  else { setInterval(() => refresh(), 20000); window.addEventListener('online', () => refresh()); }
  refresh();
})();
