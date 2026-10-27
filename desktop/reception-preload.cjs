const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('akeDesktopReception', Object.freeze({
  status: () => ipcRenderer.invoke('reception:status'),
  setOnline: value => ipcRenderer.invoke('reception:online', value === true),
  subscribe: callback => { const handler = () => callback(); ipcRenderer.on('reception:state', handler); return () => ipcRenderer.removeListener('reception:state', handler); }
}));
