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
});
