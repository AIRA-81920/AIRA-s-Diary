// Electron 预加载脚本
// 功能：在渲染进程安全地暴露主进程能力，配合前端 openExternalLink.js
// 实现方式：contextBridge 暴露受控的 electronAPI（仅 openExternal），
//           渲染进程 window.electronAPI.openExternal → 主进程 ipcMain.handle('open-external')
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 打开外部链接（URL 或本地相对资源），交由主进程用系统默认程序打开
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});