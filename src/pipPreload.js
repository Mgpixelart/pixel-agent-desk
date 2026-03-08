/**
 * PiP Preload Script
 * Provides secure IPC bridge for PiP window
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pipAPI', {
  backToDashboard: () => ipcRenderer.send('pip-back-to-dashboard'),
});
