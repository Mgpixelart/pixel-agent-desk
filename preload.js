const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onStateUpdate: (callback) => {
    ipcRenderer.on('agent-state-update', (event, data) => callback(data));
  },
  getState: () => {
    ipcRenderer.send('get-state');
    return new Promise((resolve) => {
      ipcRenderer.once('state-response', (event, data) => resolve(data));
    });
  },
  getWorkArea: () => {
    ipcRenderer.send('get-work-area');
    return new Promise((resolve) => {
      ipcRenderer.once('work-area-response', (event, data) => resolve(data));
    });
  },
  constrainWindow: (bounds) => {
    ipcRenderer.send('constrain-window', bounds);
  }
});
