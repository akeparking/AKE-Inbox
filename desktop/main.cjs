const { app, BrowserWindow, WebContentsView, ipcMain, Menu, Tray, nativeImage, dialog, session, Notification, shell, powerMonitor, net } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const WebSocket = require('ws');
const { settings, sameOrigin } = require('./config.cjs');
const { Reception } = require('./reception.cjs');
const { REPOSITORY, selectRelease } = require('./updates.cjs');
const { badge } = require('./badge.cjs');
const { activationTarget, toastXml } = require('./notification.cjs');
const testId = process.env.AKE_DESKTOP_TEST_HOME ? require('node:crypto').createHash('sha256').update(`v2:${process.env.AKE_DESKTOP_TEST_HOME}`).digest('hex').slice(0, 12) : '';
const appName = testId ? `AKE Inbox Acceptance ${testId}` : 'AKE Inbox';
const appId = testId ? `com.ake.inbox.acceptance.${testId}` : 'com.ake.inbox';
app.setName(appName);
if (process.env.AKE_DESKTOP_TEST_HOME) app.setPath('userData', process.env.AKE_DESKTOP_TEST_HOME);
app.setAppUserModelId(appId);
app.commandLine.appendSwitch('disk-cache-size', String(64 * 1024 * 1024));
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
const page = path.join(__dirname, 'ui', 'index.html'), pageUrl = pathToFileURL(page).href;
const views = new Map(), partition = 'persist:ake-inbox', HEADER = 72;
let win, view, tray, config, store, reception, timer, quitting = false, released = false;
let pane = 'settings', connection = 'connecting', opening = false, epoch = 0, nativeHttpHealthy = false;
let preferences = { notifications: true, sound: false, launchAtLogin: false };
let update = { state: 'idle' }, lastUpdateCheck = 0, activeNotification, lastNotice = 0;
let lastActivation = '', lastActivationAt = 0;
let pendingRead = null, flushingRead = false, screenLocked = false;
const paths = () => ({ host: path.join(app.getPath('userData'), 'host-settings.json'), prefs: path.join(app.getPath('userData'), 'desktop-settings.json') });
async function savePreferences() { await fs.writeFile(paths().prefs, JSON.stringify({ ...preferences, lastUpdateCheck }), { mode: 0o600 }); }
function publish(extra = {}) {
  const value = { config: config || null, pane, connection, version: app.getVersion(), preferences, update, reception: reception?.state() || {}, ...extra };
  if (win && !win.isDestroyed()) win.webContents.send('desk:state', value);
  const native = views.get('inbox'); if (native && !native.webContents.isDestroyed()) native.webContents.send('reception:state');
  return value;
}
function trusted(event) { if (!win || event.sender !== win.webContents || event.senderFrame?.url !== pageUrl) throw new Error('Invalid desktop caller'); }
function trustedNative(event) {
  const native = views.get('inbox');
  if (!native || event.sender !== native.webContents || event.senderFrame !== native.webContents.mainFrame || !sameOrigin(event.senderFrame.url, config.inboxUrl)) throw new Error('Invalid reception caller');
}
function hideView() { if (view) { win.contentView.removeChildView(view); view = null; } }
function closeViews() { epoch++; pendingRead = null; hideView(); for (const child of views.values()) child.webContents.close(); views.clear(); }
function resize() {
  if (!view || !win || win.isMinimized()) return;
  const [w, h] = win.getContentSize();
  // Windows reports a zero content size while minimizing. Keep the last usable
  // viewport so hidden native pages do not relayout into a zero-width column.
  if (w > 0 && h > HEADER) view.setBounds({ x: 0, y: HEADER, width: w, height: h - HEADER });
}
function showWindow() { if (win.isMinimized()) win.restore(); win.show(); resize(); win.focus(); win.flashFrame(false); }
function updateTray() {
  const s = reception?.state() || {};
  tray?.setImage(s.unreadCount ? badge(s.unreadCount, nativeImage) : nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray.png')));
  tray?.setToolTip(`AKE Inbox · ${s.online ? '接待中' : s.paused ? '已暂停' : '未在线'} · ${s.unreadCount || 0} 条未读`);
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: `打开工作台${s.unreadCount ? ` (${s.unreadCount})` : ''}`, click: showWindow },
    { label: s.paused ? '开始接待' : '暂停接待', enabled: s.authenticated === true, click: () => reception.setOnline(s.paused) },
    { label: '设置', click: () => { hideView(); pane = 'settings'; publish(); showWindow(); } },
    { type: 'separator' }, { label: '退出 AKE Inbox', click: () => app.quit() }
  ]));
}
function overlay(count) {
  if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
  if (!count) { win.setOverlayIcon(null, '没有未读消息'); win.flashFrame(false); return; }
  win.setOverlayIcon(badge(count, nativeImage), `${count} 条未读消息`);
}
async function openConversation({ accountId, conversationId }) {
  if (!Number.isSafeInteger(accountId) || !Number.isSafeInteger(conversationId)) return;
  if (reception?.context?.accountId !== accountId) { showWindow(); return; }
  const target = `${accountId}:${conversationId}`;
  if (lastActivation === target && Date.now() - lastActivationAt < 1000) return;
  lastActivation = target; lastActivationAt = Date.now();
  await open('inbox');
  const url = new URL(`/app/accounts/${accountId}/conversations/${conversationId}`, config.inboxUrl);
  const contents = views.get('inbox')?.webContents;
  // Restoring a conversation that is already open must keep its reply draft
  // and loaded page, rather than rebuilding the whole native application.
  if (contents && contents.getURL() !== url.href) await contents.loadURL(url.href).catch(() => {});
  showWindow();
  contents?.focus();
  void flushReadReceipt();
}
function notifyMessage(event) {
  if (!win || win.isDestroyed()) return;
  const current = views.get('inbox')?.webContents.getURL() || '';
  if (viewingInbox() && current.endsWith(`/conversations/${event.conversationId}`)) return;
  if (!win.isVisible()) { win.showInactive(); win.minimize(); }
  if (!win.isFocused()) win.flashFrame(true);
  if (!preferences.notifications || Date.now() - lastNotice < 3000) return;
  lastNotice = Date.now();
  if (Notification.isSupported()) {
    activeNotification?.close();
    activeNotification = new Notification({ title: 'AKE Inbox', body: event.recovered || event.count > 1 ? '你有新的客户消息，请打开工作台查看。' : '你有新的客户消息', silent: !preferences.sound, icon: path.join(__dirname, 'ui', 'tray.png'), ...(process.platform === 'win32' ? { toastXml: toastXml(event, preferences.sound) } : {}) });
    activeNotification.on('click', () => void openConversation(event));
    activeNotification.on('failed', () => publish({ notice: 'Windows 通知不可用；任务栏和托盘未读提醒仍然有效。' }));
    activeNotification.show();
  }
}
async function auth(origin) {
  const cookies = await store.cookies.get({ url: origin, name: 'cw_d_session_info' });
  if (!cookies.length) return null;
  try { const v = JSON.parse(decodeURIComponent(cookies[0].value)); return v['access-token'] && v.client && v.uid ? v : null; } catch { return null; }
}
async function requestPath(context, endpoint, body, timeout = 8000) {
  const credentials = await auth(context.origin) || context.auth;
  if (!credentials) throw Object.assign(new Error('signed_out'), { status: 401 });
  const headers = { 'content-type': 'application/json' };
  for (const key of ['access-token', 'client', 'uid', 'token-type']) if (credentials[key]) headers[key] = credentials[key];
  const response = await store.fetch(`${context.origin}${endpoint}`, {
    method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined, headers,
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw Object.assign(new Error('service_unavailable'), { status: response.status });
  if (response.headers.get('access-token')) {
    for (const key of ['access-token', 'client', 'uid', 'token-type', 'expiry']) if (response.headers.get(key)) credentials[key] = response.headers.get(key);
    const latest = await auth(context.origin);
    if (latest?.client === credentials.client && latest.uid === credentials.uid) {
      const [cookie] = await store.cookies.get({ url: context.origin, name: 'cw_d_session_info' });
      const value = encodeURIComponent(JSON.stringify(credentials));
      if (cookie && (value !== cookie.value || cookie.session)) {
        // A rotated native token must keep its persistence. Dropping expires
        // changes it into a session cookie and logs users out on ZIP upgrades.
        const expirationDate = cookie.expirationDate || Number(credentials.expiry);
        await store.cookies.set({ url: context.origin, name: cookie.name, value,
          path: cookie.path || '/', secure: cookie.secure, httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite, ...(!cookie.hostOnly ? { domain: cookie.domain } : {}),
          ...(Number.isFinite(expirationDate) && expirationDate > Date.now() / 1000 ? { expirationDate } : {}) });
      }
    }
  }
  context.auth = credentials;
  const text = await response.text(); if (text.length > 262144) throw new Error('invalid_response');
  return JSON.parse(text);
}
function request(context, action, body, timeout) {
  return requestPath(context, `/api/v1/accounts/${context.accountId}/ake_reception/${action}`, body, timeout);
}
function viewingInbox() {
  return win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused() && !screenLocked && view === views.get('inbox');
}
async function flushReadReceipt() {
  if (flushingRead || !pendingRead || !viewingInbox() || !nativeHttpHealthy || !reception?.context) return;
  const target = pendingRead, native = views.get('inbox');
  const route = new URL(native.webContents.getURL());
  if (route.origin !== reception.context.origin || route.pathname !== `/app/accounts/${target.accountId}/conversations/${target.conversationId}`) { pendingRead = null; return; }
  flushingRead = true; pendingRead = null;
  try {
    await requestPath(reception.context, `/api/v1/accounts/${target.accountId}/conversations/${target.conversationId}/update_last_seen`, {});
    await reception.snapshot();
  } catch { if (!pendingRead) pendingRead = target; }
  finally { flushingRead = false; }
}
let syncing = false;
async function synchronize(renew = false) {
  if (syncing || quitting || !config) return;
  syncing = true;
  try {
    const native = views.get('inbox'); if (!native || !nativeHttpHealthy) return;
    const url = new URL(native.webContents.getURL() || config.inboxUrl);
    if (!sameOrigin(url.href, config.inboxUrl)) return;
    const id = Number(url.pathname.match(/\/app\/accounts\/(\d+)/)?.[1] || url.searchParams.get('account'));
    const credentials = await auth(url.origin);
    if (!credentials || !Number.isSafeInteger(id) || id < 1) {
      if (reception.context) await reception.disconnect();
      if (/\/app\/(login|auth|password)/.test(url.pathname)) { connection = 'signed_out'; publish(); }
      return;
    }
    const identity = `${url.origin}:${id}:${credentials.uid}:${credentials.client}`;
    if (reception.context?.identity !== identity) await reception.connect({ origin: url.origin, accountId: id, identity, auth: credentials });
    else if (renew) await reception.tick();
    void flushReadReceipt();
  } finally { syncing = false; }
}
async function open(name) {
  if (!config || !['inbox', 'workspace'].includes(name) || opening) return publish();
  hideView();
  if (views.has(name)) { view = views.get(name); pane = name; win.contentView.addChildView(view); resize(); void flushReadReceipt(); return publish(); }
  const generation = epoch, url = name === 'inbox' ? config.inboxUrl : config.workspaceUrl;
  const child = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: true, partition, ...(name === 'inbox' ? { preload: path.join(__dirname, 'reception-preload.cjs') } : {}) } });
  views.set(name, child); view = child; pane = name; opening = true;
  if (name === 'inbox') { connection = 'connecting'; nativeHttpHealthy = false; }
  child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event, target) => { if (!sameOrigin(target, url)) { event.preventDefault(); publish({ notice: '此入口只允许访问已配置的办公室主机。' }); } };
  child.webContents.on('will-navigate', guard); child.webContents.on('will-redirect', guard);
  child.webContents.on('did-navigate', (_event, _target, status) => {
    if (name === 'inbox') nativeHttpHealthy = status >= 200 && status < 400;
    if (name === 'inbox' && status >= 400) { connection = 'failed'; void reception.disconnect(); publish({ error: `主机暂不可用 (${status})，正在等待恢复。` }); }
    else if (name === 'inbox') void synchronize();
  });
  child.webContents.on('did-navigate-in-page', () => { if (name === 'inbox') void synchronize(); });
  child.webContents.on('did-finish-load', () => { if (name === 'inbox') void synchronize(); });
  child.webContents.on('render-process-gone', () => {
    views.delete(name); if (name === 'inbox') { connection = 'failed'; void reception.disconnect(); }
    if (view === child) { hideView(); pane = 'settings'; } publish({ error: '页面已关闭，请重新连接。' });
  });
  win.contentView.addChildView(child); resize(); publish();
  try { await child.webContents.loadURL(url); }
  catch { if (generation === epoch) { if (name === 'inbox') nativeHttpHealthy = false; connection = 'failed'; publish({ error: '连接中断，请检查主机或稍后重连。' }); } }
  finally { opening = false; }
  return publish();
}
async function reconnect() { await reception.disconnect(); closeViews(); connection = 'connecting'; await open('inbox'); return publish(); }
async function clearSession() {
  await reception.disconnect(); closeViews(); pane = 'settings'; connection = 'signed_out';
  await store.clearStorageData(); await store.clearCache(); await store.clearAuthCache(); await store.closeAllConnections();
  return publish({ notice: '已清除这台电脑的登录状态。' });
}
async function checkUpdates(manual = false) {
  if (update.state === 'checking' || (!manual && Date.now() - lastUpdateCheck < 86400000)) return publish();
  lastUpdateCheck = Date.now(); await savePreferences(); update = { state: 'checking' }; publish();
  try {
    const response = await net.fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(6000), redirect: 'error' });
    if (!response.ok) throw new Error('update_unavailable');
    const text = await response.text(); if (text.length > 2097152) throw new Error('response_too_large');
    const release = selectRelease(JSON.parse(text), app.getVersion()); update = release ? { state: 'available', ...release } : { state: 'current' };
  } catch { update = { state: 'unavailable' }; }
  return publish();
}
async function registerWindows() {
  if (process.platform !== 'win32') return;
  const folder = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  await fs.mkdir(folder, { recursive: true });
  // Electron's Windows COM activator locates this shortcut by the executable's
  // ProductName, not app.getName(). A differently named link can advertise a
  // CLSID the process never registers, causing notification clicks to vanish.
  const shortcut = path.join(folder, `${require('./package.json').productName}.lnk`);
  const clsid = testId ? `7C2C52DD-05DA-4B71-8B4A-${testId}` : '7C2C52DD-05DA-4B71-8B4A-55D847EA7031';
  const ok = shell.writeShortcutLink(shortcut, 'create', { target: process.execPath, cwd: path.dirname(process.execPath), description: 'AKE Inbox 工作台', appUserModelId: appId, toastActivatorClsid: clsid });
  if (!ok) publish({ notice: '系统通知注册未完成；任务栏提醒仍然有效。' });
}
async function create() {
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  try { config = settings(JSON.parse(await fs.readFile(paths().host, 'utf8'))); } catch { config = settings(require('./defaults.json')); }
  try { const p = JSON.parse(await fs.readFile(paths().prefs, 'utf8')); for (const key of Object.keys(preferences)) if (typeof p[key] === 'boolean') preferences[key] = p[key]; lastUpdateCheck = Number(p.lastUpdateCheck) || 0; } catch {}
  store = session.fromPartition(partition);
  // Native Chatwoot can mark the selected conversation read on a background
  // message. Defer only that view's read receipt until a person can see it.
  store.webRequest.onBeforeRequest({ urls: ['*://*/api/v1/accounts/*/conversations/*/update_last_seen'] }, (details, callback) => {
    const native = views.get('inbox');
    if (details.method !== 'POST' || details.webContentsId !== native?.webContents.id || !sameOrigin(details.url, config.inboxUrl)) { callback({}); return; }
    const match = new URL(details.url).pathname.match(/^\/api\/v1\/accounts\/(\d+)\/conversations\/(\d+)\/update_last_seen$/);
    if (match && !viewingInbox()) {
      pendingRead = { accountId: Number(match[1]), conversationId: Number(match[2]) };
      callback({ cancel: true }); return;
    }
    callback({});
  });
  store.setPermissionRequestHandler((_wc, _p, callback) => callback(false)); store.setPermissionCheckHandler(() => false);
  store.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: '保存 Inbox 导出文件' }));
  reception = new Reception({ request, socket: (url, origin) => new WebSocket(url, ['actioncable-v1-json'], { origin, handshakeTimeout: 8000, maxPayload: 131072 }), notify: notifyMessage, changed: state => { if (state.connection) connection = state.connection; overlay(state.unreadCount || 0); updateTray(); publish(); } });
  win = new BrowserWindow({ width: 1320, height: 900, minWidth: 850, minHeight: 640, backgroundColor: '#0d1110', title: 'AKE Inbox 工作台', icon: path.join(__dirname, 'ui', 'tray.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('resize', resize); win.on('restore', resize);
  win.on('focus', () => { win.flashFrame(false); void flushReadReceipt(); void reception.snapshot().catch(() => {}); });
  win.on('close', event => { if (!quitting && tray) { event.preventDefault(); win.hide(); } });
  const icon = nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray.png'));
  if (!icon.isEmpty()) { tray = new Tray(icon); tray.on('double-click', showWindow); updateTray(); }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'AKE Inbox', submenu: [{ label: '设置', click: () => { hideView(); pane = 'settings'; publish(); } }, { label: '重新连接', accelerator: 'CmdOrCtrl+R', click: () => void reconnect() }, { label: '退出', click: () => app.quit() }] }]));
  ipcMain.handle('desk:status', e => { trusted(e); return publish(); });
  ipcMain.handle('desk:connect', async (e, value) => { trusted(e); if (opening) return publish();
    try { const next = settings(value); if (config.inboxUrl !== next.inboxUrl || config.workspaceUrl !== next.workspaceUrl) await clearSession(); config = next; await fs.writeFile(paths().host, JSON.stringify(next), { mode: 0o600 }); return await reconnect(); }
    catch { return publish({ error: '请输入有效地址：本机可使用 HTTP，其他主机必须使用 HTTPS。' }); }
  });
  ipcMain.handle('desk:open', (e, name) => { trusted(e); return open(name); });
  ipcMain.handle('desk:settings', e => { trusted(e); hideView(); pane = 'settings'; return publish(); });
  ipcMain.handle('desk:reconnect', e => { trusted(e); return reconnect(); });
  ipcMain.handle('desk:online', async (e, value) => { trusted(e); await reception.setOnline(value === true); return publish(); });
  ipcMain.handle('desk:preferences', async (e, input) => { trusted(e); const oldStartup = preferences.launchAtLogin; for (const key of Object.keys(preferences)) if (typeof input?.[key] === 'boolean') preferences[key] = input[key]; if (process.platform === 'win32' && oldStartup !== preferences.launchAtLogin && !process.env.AKE_DESKTOP_TEST_HOME) app.setLoginItemSettings({ openAtLogin: preferences.launchAtLogin, path: process.execPath }); await savePreferences(); return publish(); });
  ipcMain.handle('desk:updates', e => { trusted(e); return checkUpdates(true); });
  ipcMain.handle('desk:download-update', async e => { trusted(e); if (update.url) await shell.openExternal(update.url); return publish(); });
  ipcMain.handle('desk:clear-session', async e => { trusted(e); const answer = await dialog.showMessageBox(win, { type: 'question', message: '清除这台电脑的登录状态？', detail: '会话记录仍保存在办公室主机。', buttons: ['取消', '清除登录'], defaultId: 0, cancelId: 0 }); return answer.response === 1 ? clearSession() : publish(); });
  ipcMain.handle('reception:status', e => { trustedNative(e); return reception.state(); });
  ipcMain.handle('reception:online', (e, value) => { trustedNative(e); return reception.setOnline(value === true); });
  store.cookies.on('changed', (_e, cookie) => { if (cookie.name === 'cw_d_session_info') void synchronize(); });
  powerMonitor.on('suspend', () => void reception.suspend(true)); powerMonitor.on('resume', () => void reception.suspend(false));
  // Locking the screen deliberately keeps reception online, per team policy.
  powerMonitor.on('lock-screen', () => { screenLocked = true; });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; void flushReadReceipt(); });
  await win.loadFile(page); await registerWindows();
  if (process.platform === 'win32') Notification.handleActivation(details => {
    const target = activationTarget(details.arguments);
    if (target) void openConversation(target);
  });
  if (process.platform === 'win32' && preferences.launchAtLogin && !process.env.AKE_DESKTOP_TEST_HOME) app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  await open('inbox');
  timer = setInterval(() => { if (connection === 'failed' && !reception.context && !opening) void reconnect(); else void synchronize(true); }, 20000);
  setTimeout(() => void checkUpdates(), 10000).unref();
}
app.on('second-instance', () => { if (win) showWindow(); });
app.on('before-quit', event => { quitting = true; clearInterval(timer); if (released || !reception) return; event.preventDefault(); activeNotification?.close(); Promise.race([reception.disconnect(), new Promise(resolve => setTimeout(resolve, 2200))]).finally(() => { released = true; app.quit(); }); });
app.on('window-all-closed', () => app.quit());
if (locked) app.whenReady().then(create).catch(() => { dialog.showErrorBox('AKE Inbox', '启动失败，请重新解压完整客户端后再试。'); app.quit(); });
