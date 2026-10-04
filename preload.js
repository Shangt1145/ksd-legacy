'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('KG_PLAYER_STORAGE', {
  read: () => ipcRenderer.invoke('kg-player-read'),
  write: snapshot => ipcRenderer.invoke('kg-player-write', snapshot),
});
