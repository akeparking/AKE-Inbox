const { app, BrowserWindow, WebContentsView, ipcMain, Menu, Tray, nativeImage, dialog, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { settings, sameOrigin } = require('./config.cjs');

app.setName('AKE Inbox');
if (process.env.AKE_DESKTOP_TEST_HOME) app.setPath('userData', process.env.AKE_DESKTOP_TEST_HOME);
app.setAppUserModelId('com.ake.inbox');
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
let win, view, tray, config, quitting = false, pane = 'settings', connection = 'unconfigured';
let epoch = 0, opening = false;
const views = new Map();
const page = path.join(__dirname, 'ui', 'index.html');
const pageUrl = pathToFileURL(page).href;
const partition = 'persist:ake-inbox';
const HEADER = 72;

function publish(extra = {}) {
  const value = { config: config || null, pane, connection, version: app.getVersion(), ...extra };
  if (win && !win.isDestroyed()) win.webContents.send('desk:state', value);
  return value;
}
function trusted(event) {
  if (!win || event.sender !== win.webContents || event.senderFrame?.url !== pageUrl) throw new Error('Invalid desktop caller');
}
function hideView() {
  if (view) { win.contentView.removeChildView(view); view = null; }
}
function closeView() {
  epoch++;
  hideView();
  for (const child of views.values()) child.webContents.close();
  views.clear();
}
function resize() {
  if (view && win) { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: HEADER, width, height: Math.max(1, height - HEADER) }); }
}
async function open(name) {
  if (!config || !['inbox', 'workspace'].includes(name) || opening) return publish({ error: '请先连接办公室主机' });
  hideView();
  if (views.has(name)) {
    view = views.get(name); pane = name; connection = 'connected';
    win.contentView.addChildView(view); resize(); return publish();
  }
  const generation = epoch;
  const url = name === 'inbox' ? config.inboxUrl : config.workspaceUrl;
  const child = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false, partition } });
  views.set(name, child);
  view = child; pane = name; connection = 'connecting'; opening = true;
  child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const guard = (event, target) => { if (!sameOrigin(target, url)) { event.preventDefault(); publish({ notice: '此入口只允许访问已配置的办公室主机。' }); } };
  child.webContents.on('will-navigate', guard);
  child.webContents.on('will-redirect', guard);
  child.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMain) => { if (isMain && view === child) { connection = 'connecting'; publish(); } });
  child.webContents.on('did-finish-load', () => { if (view === child) { connection = 'connected'; publish(); } });
  child.webContents.on('render-process-gone', () => { views.delete(name); if (view === child) { hideView(); pane = 'settings'; connection = 'failed'; publish({ error: '工作台已关闭，请重新连接。' }); } });
  win.contentView.addChildView(child); resize(); publish();
  try { await child.webContents.loadURL(url); }
  catch { if (generation === epoch) { closeView(); pane = 'settings'; connection = 'failed'; publish({ error: '未能连接办公室主机，请检查 WSL 服务和地址。' }); } }
  finally { opening = false; }
  return publish();
}
async function clearSession() {
  closeView(); pane = 'settings'; connection = config ? 'configured' : 'unconfigured';
  const store = session.fromPartition(partition);
  await store.clearStorageData(); await store.clearCache(); await store.clearAuthCache();
  await store.closeAllConnections();
  return publish({ notice: '已清除这台电脑的工作台登录状态。' });
}
async function create() {
  const file = path.join(app.getPath('userData'), 'host-settings.json');
  try { config = settings(JSON.parse(await fs.readFile(file, 'utf8'))); connection = 'configured'; } catch {}
  const store = session.fromPartition(partition);
  store.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  store.setPermissionCheckHandler(() => false);
  store.on('will-download', (_event, item) => {
    // The user's Save dialog chooses the destination. Never execute a downloaded file.
    item.setSaveDialogOptions({ title: '保存 Inbox 导出文件' });
  });
  win = new BrowserWindow({ width: 1320, height: 900, minWidth: 850, minHeight: 640, backgroundColor: '#0d1110', title: 'AKE Inbox 工作台', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('resize', resize);
  win.on('close', event => { if (!quitting && tray) { event.preventDefault(); win.hide(); } });
  const icon = nativeImage.createFromPath(path.join(__dirname, 'ui', 'tray.png'));
  if (!icon.isEmpty()) {
    tray = new Tray(icon);
    tray.setToolTip('AKE Inbox — 接待状态以工作台为准');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开工作台', click: () => { win.show(); win.focus(); } },
      { label: '主机设置', click: () => { hideView(); pane = 'settings'; publish(); win.show(); } },
      { type: 'separator' },
      { label: '退出 AKE Inbox', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => { win.show(); win.focus(); });
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'AKE Inbox', submenu: [
    { label: '主机设置', click: () => { hideView(); pane = 'settings'; publish(); } },
    { label: '重新加载', accelerator: 'CmdOrCtrl+R', click: () => view?.webContents.reload() },
    { type: 'separator' }, { label: '退出', accelerator: 'Alt+F4', click: () => { quitting = true; app.quit(); } }
  ] }]));
  ipcMain.handle('desk:status', event => { trusted(event); return publish(); });
  ipcMain.handle('desk:connect', async (event, value) => {
    trusted(event); if (opening) return publish();
    try {
      const next = settings(value);
      if (config && (config.inboxUrl !== next.inboxUrl || config.workspaceUrl !== next.workspaceUrl)) await clearSession();
      await fs.mkdir(app.getPath('userData'), { recursive: true });
      await fs.writeFile(file, JSON.stringify(next, null, 2), { mode: 0o600 });
      config = next; return await open('inbox');
    } catch (error) { return publish({ error: error.message }); }
  });
  ipcMain.handle('desk:open', (event, name) => { trusted(event); return open(name); });
  ipcMain.handle('desk:settings', event => { trusted(event); hideView(); pane = 'settings'; return publish(); });
  ipcMain.handle('desk:clear-session', async event => {
    trusted(event);
    const answer = await dialog.showMessageBox(win, { type: 'question', message: '清除本机工作台登录状态？', detail: '会话记录仍保存在办公室主机上。清除后需要重新登录。', buttons: ['取消', '清除登录'], defaultId: 0, cancelId: 0 });
    return answer.response === 1 ? clearSession() : publish();
  });
  await win.loadFile(page);
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
if (locked) app.whenReady().then(create);
