'use strict';
const {contextBridge, ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('commerce', {
  showEnvironments: () => ipcRenderer.invoke('commerce-home'),
  onPage: fn => {
    if(typeof fn!=='function')return ()=>{};
    const listener=(_event,page)=>{if(['overview','accounts','inventory','plans','jobs','settings'].includes(page))fn(page);};
    ipcRenderer.on('commerce-page',listener);return ()=>ipcRenderer.removeListener('commerce-page',listener);
  },
  state: () => ipcRenderer.invoke('commerce-state'),
  saveSettings: input => ipcRenderer.invoke('commerce-settings-save', input),
  connect: () => ipcRenderer.invoke('commerce-connect'),
  sync: () => ipcRenderer.invoke('commerce-sync'),
  saveProductListing: input => ipcRenderer.invoke('commerce-product-listing-save', input),
  importProductPhotos: options => ipcRenderer.invoke('commerce-local-photos-import', options),
  importSupplierPhotos: options => ipcRenderer.invoke('commerce-supplier-photos-import', options),
  saveManualProduct: input => ipcRenderer.invoke('commerce-local-product-save', input),
  deleteManualProduct: productId => ipcRenderer.invoke('commerce-local-product-delete', productId),
  deletePlan: planId => ipcRenderer.invoke('commerce-plan-delete', planId),
  restorePlan: planId => ipcRenderer.invoke('commerce-plan-restore', planId),
  productCover: productId => ipcRenderer.invoke('commerce-product-cover', productId),
  savePlan: input => ipcRenderer.invoke('commerce-plan-save', input),
  saveAndStartPlan: input => ipcRenderer.invoke('commerce-plan-save-start', input),
  startPlan: planId => ipcRenderer.invoke('commerce-plan-start', planId),
  saveAccount: input => ipcRenderer.invoke('commerce-account-save', input),
  deleteAccount: accountId => ipcRenderer.invoke('commerce-account-delete', accountId),
  loginAccount: accountId => ipcRenderer.invoke('commerce-account-login', accountId),
  openAccount: accountId => ipcRenderer.invoke('commerce-account-open', accountId),
  verifyAccount: (accountId,options) => ipcRenderer.invoke('commerce-account-verify', accountId,options),
  openListing: planId => ipcRenderer.invoke('commerce-open-listing', planId),
  openActiveListing: planId => ipcRenderer.invoke('commerce-open-active-listing', planId),
  preflight: planId => ipcRenderer.invoke('commerce-preflight', planId),
  inspectAccount: planId => ipcRenderer.invoke('commerce-account-inspect', planId),
  inspectPublication: planId => ipcRenderer.invoke('commerce-publication-inspect', planId),
  submitPublication: planId => ipcRenderer.invoke('commerce-publication-submit', planId),
  inspectPublishedListing: planId => ipcRenderer.invoke('commerce-published-inspect', planId),
  associatePublishedListing: (planId,reviewToken) => ipcRenderer.invoke('commerce-published-associate', planId,reviewToken),
  confirmDeletedListing: (planId,confirmation) => ipcRenderer.invoke('commerce-confirm-deleted-listing', planId,confirmation),
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
  },
  onEnvironment: fn => {
    if(typeof fn!=='function')return ()=>{};
    const listener=(_event,context)=>{if(context&&typeof context.profileId==='string'&&['accounts','plans'].includes(context.section))fn({profileId:context.profileId,section:context.section});};
    ipcRenderer.on('commerce-environment',listener);return ()=>ipcRenderer.removeListener('commerce-environment',listener);
  }
});
