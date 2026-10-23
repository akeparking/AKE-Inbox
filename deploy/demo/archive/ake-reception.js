(() => {
  let running = false;
  async function heartbeat(state) {
    const account = location.pathname.match(/\/app\/accounts\/(\d+)/)?.[1] || new URLSearchParams(location.search).get('account');
    if (!account || !window.akeApi || running) return;
    running = true;
    try {
      const result = await window.akeApi(account, '/ake_reception/heartbeat', state ? { state } : {});
      let button = document.getElementById('ake-reception-status');
      if (!button && document.getElementById('ake-workspace-nav')) {
        button = document.createElement('button'); button.id = 'ake-reception-status';
        button.style.cssText = 'border:1px solid #cbd5e1;border-radius:5px;padding:8px 12px;background:white;color:#253345;cursor:pointer;white-space:nowrap';
        document.getElementById('ake-workspace-nav').append(button);
      }
      if (button) {
        button.textContent = result.online ? '接待中 · 点击下线' : '已下线 · 点击接待';
        button.onclick = () => heartbeat(result.online ? 'offline' : 'online');
      }
    } catch {
      const button = document.getElementById('ake-reception-status');
      if (button) button.textContent = '接待连接中断 · 正在重试';
    } finally { running = false; }
  }
  heartbeat(); setInterval(() => heartbeat(), 20000);
  window.addEventListener('online', () => heartbeat());
})();
