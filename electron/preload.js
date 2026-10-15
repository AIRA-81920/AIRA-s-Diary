// Electron 预加载脚本
// 功能：在渲染进程安全地暴露主进程能力，配合前端 openExternalLink.js 与 api.js
// 实现方式：contextBridge 暴露受控的 electronAPI（openExternal + getLocalToken），
//           渲染进程 window.electronAPI.openExternal → 主进程 ipcMain.handle('open-external')
//           window.electronAPI.getLocalToken → 主进程 ipcMain.handle('get-local-token')
// 安全说明（SEC-010）：本脚本仅使用 contextBridge/ipcRenderer，二者在沙箱化 preload 中均可用，
//           主进程已开启 sandbox: true
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 打开外部链接（URL 或本地相对资源），交由主进程用系统默认程序打开（主进程有域名白名单）
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // 获取本地 API 令牌（SEC-002：前端 fetch 封装统一附加 x-local-token 头）
  getLocalToken: () => ipcRenderer.invoke('get-local-token'),
});
