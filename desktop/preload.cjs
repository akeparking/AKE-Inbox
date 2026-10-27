const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('inboxDesktop', Object.freeze({
  status: () => ipcRenderer.invoke('desk:status'),
  connect: value => ipcRenderer.invoke('desk:connect', value),
  open: name => ipcRenderer.invoke('desk:open', name),
  settings: () => ipcRenderer.invoke('desk:settings'),
  clearSession: () => ipcRenderer.invoke('desk:clear-session'),
  reconnect: () => ipcRenderer.invoke('desk:reconnect'),
  setOnline: value => ipcRenderer.invoke('desk:online', value === true),
  preferences: value => ipcRenderer.invoke('desk:preferences', value),
  checkUpdates: () => ipcRenderer.invoke('desk:updates'),
  downloadUpdate: () => ipcRenderer.invoke('desk:download-update'),
  subscribe: callback => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('desk:state', handler);
    return () => ipcRenderer.removeListener('desk:state', handler);
  }
}));
