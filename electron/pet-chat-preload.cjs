'use strict';
/** 专属宠物对话窗口复用 Web UI，仅暴露本窗口的受控能力。 */
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (action, input) => ipcRenderer.invoke('omni:pet-chat', action, input);
contextBridge.exposeInMainWorld('omni', {
  ready: () => invoke('ready'),
  desktopInfo: () => invoke('info'),
  setSession: id => invoke('session', id),
  hide: () => invoke('hide'),
  closeWindow: () => invoke('hide'),
  pickDirectory: () => invoke('pick-directory'),
  setPetEnabled: enabled => invoke('pet-enable', enabled),
  setBotSettings: settings => invoke('bot-settings', settings),
  expandBotWindow: () => invoke('expand'),
  compactBotWindow: () => invoke('compact'),
  readClipboard: () => invoke('read-clipboard'),
  captureScreen: () => invoke('capture-screen'),
  stageWorkspaceDraft: (target, draft) => invoke('stage-draft', { target, draft }),
  takeWorkspaceDraft: () => invoke('take-draft'),
  onDesktopAction: callback => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('omni:pet-chat-action', listener);
    return () => ipcRenderer.removeListener('omni:pet-chat-action', listener);
  },
});
