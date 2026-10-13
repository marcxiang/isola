'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('commerce', {
  state: () => ipcRenderer.invoke('commerce-state'),
  saveSettings: input => ipcRenderer.invoke('commerce-settings-save', input),
  connect: () => ipcRenderer.invoke('commerce-connect'),
  sync: () => ipcRenderer.invoke('commerce-sync'),
  savePlan: input => ipcRenderer.invoke('commerce-plan-save', input),
  openListing: planId => ipcRenderer.invoke('commerce-open-listing', planId),
  openActiveListing: planId => ipcRenderer.invoke('commerce-open-active-listing', planId),
  preflight: planId => ipcRenderer.invoke('commerce-preflight', planId),
  inspectAccount: planId => ipcRenderer.invoke('commerce-account-inspect', planId),
  inspectPublication: planId => ipcRenderer.invoke('commerce-publication-inspect', planId),
  prepareDraft: planId => ipcRenderer.invoke('commerce-prepare-draft', planId),
  inspectPhotos: planId => ipcRenderer.invoke('commerce-photos-inspect', planId),
  preparePhotos: planId => ipcRenderer.invoke('commerce-photos-prepare', planId),
  photoPreview: planId => ipcRenderer.invoke('commerce-photos-preview', planId),
  uploadPhotos: (planId,recheckOnly=false) => ipcRenderer.invoke('commerce-photos-upload', planId,recheckOnly),
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
