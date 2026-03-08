/**
 * PiP Preload Script
 * Provides secure IPC bridge for PiP window
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pipAPI', {
  close: () => ipcRenderer.send('pip-close'),
  minimize: () => ipcRenderer.send('pip-minimize'),
  backToDashboard: () => ipcRenderer.send('pip-back-to-dashboard'),
  dragWindow: (dx, dy) => ipcRenderer.send('pip-drag', dx, dy),
});
