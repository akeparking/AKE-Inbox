const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('inboxDesktop', Object.freeze({
  status: () => ipcRenderer.invoke('desk:status'),
  connect: value => ipcRenderer.invoke('desk:connect', value),
  open: name => ipcRenderer.invoke('desk:open', name),
  settings: () => ipcRenderer.invoke('desk:settings'),
  clearSession: () => ipcRenderer.invoke('desk:clear-session'),
  subscribe: callback => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('desk:state', handler);
    return () => ipcRenderer.removeListener('desk:state', handler);
  }
}));
