const { contextBridge, ipcRenderer } = require('electron');
const api = {};
for (const name of ['list', 'save', 'launch', 'stop', 'delete', 'clear', 'duplicate', 'batch', 'export', 'import', 'info','fingerprintPreview','fingerprintCatalog']) api[name] = (...args) => ipcRenderer.invoke(({fingerprintPreview:'fingerprint-preview',fingerprintCatalog:'fingerprint-catalog'}[name]||name), ...args);
api.test = p => ipcRenderer.invoke('proxy-test', p);
api.openCommerce=()=>ipcRenderer.invoke('commerce-open');
api.onChange = fn => ipcRenderer.on('profiles', (_, rows) => fn(rows));
contextBridge.exposeInMainWorld('isola', api);
