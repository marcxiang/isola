'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('commerce', {
  state: () => ipcRenderer.invoke('commerce-state'),
  saveSettings: input => ipcRenderer.invoke('commerce-settings-save', input),
  connect: () => ipcRenderer.invoke('commerce-connect'),
  sync: () => ipcRenderer.invoke('commerce-sync'),
  savePlan: input => ipcRenderer.invoke('commerce-plan-save', input),
  openListing: planId => ipcRenderer.invoke('commerce-open-listing', planId),
  preflight: planId => ipcRenderer.invoke('commerce-preflight', planId),
  prepareDraft: planId => ipcRenderer.invoke('commerce-prepare-draft', planId),
  setPlanEnabled: (id, enabled) => ipcRenderer.invoke('commerce-plan-enabled', id, enabled),
  runOnce: () => ipcRenderer.invoke('commerce-run-once'),
  setRunning: enabled => ipcRenderer.invoke('commerce-running', enabled),
  resolve: (jobId, action, data) => ipcRenderer.invoke('commerce-resolve', jobId, action, data),
  onState: fn => {
    if (typeof fn !== 'function') return () => {};
    const listener = (_, state) => fn(state);
    ipcRenderer.on('commerce-state', listener);
    return () => ipcRenderer.removeListener('commerce-state', listener);
  }
});
