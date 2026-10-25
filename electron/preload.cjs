/**
 * Electron preload：向页面暴露最小桥接 API（contextIsolation 开启，页面无 Node 权限）。
 *
 * window.omni.pickDirectory() —— 弹出原生文件夹选择对话框，返回绝对路径或 null。
 * Web UI 的「设置 → 工作目录 → 浏览…」据此提供原生选择体验；纯浏览器环境
 * （window.omni 不存在）自动回退为手动输入路径。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omni', {
  pickDirectory: () => ipcRenderer.invoke('omni:pick-directory'),
  desktopInfo: () => ipcRenderer.invoke('omni:desktop-info'),
  setBotSettings: (settings) => ipcRenderer.invoke('omni:bot-settings', settings),
  hide: () => ipcRenderer.invoke('omni:hide'),
  openFullWindow: () => ipcRenderer.invoke('omni:open-full'),
  minimizeWindow: () => ipcRenderer.invoke('omni:window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('omni:window-maximize'),
  closeWindow: () => ipcRenderer.invoke('omni:window-close'),
  onDesktopAction: (callback) => {
    const listener = (_event, action) => callback(action);
    ipcRenderer.on('omni:desktop-action', listener);
    return () => ipcRenderer.removeListener('omni:desktop-action', listener);
  },
});
