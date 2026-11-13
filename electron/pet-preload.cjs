'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('omniPet', {
  info: () => ipcRenderer.invoke('omni:pet-info'),
  action: (action, input) => ipcRenderer.invoke('omni:pet-action', action, input),
  onPointer: callback => {
    const listener = (_event, point) => callback(point);
    ipcRenderer.on('omni:pet-pointer', listener);
    return () => ipcRenderer.removeListener('omni:pet-pointer', listener);
  },
  onUpdate: callback => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on('omni:pet-update', listener);
    return () => ipcRenderer.removeListener('omni:pet-update', listener);
  },
});
