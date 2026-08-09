// 统一外部链接打开工具（Web/Electron 兼容）
// 功能：所有需要打开外部 URL 或本地文件的地方统一走此函数，
//        Web 环境用 window.open 新标签页，Electron 环境用 shell.openExternal/openPath 调系统默认程序
// 实现方式：
//   - 检测 window.electronAPI.openExternal 是否存在（Electron 预加载脚本暴露）
//   - 存在 → 走 Electron IPC 通道，由主进程调 shell.openExternal（URL）或 shell.openPath（本地文件）
//   - 不存在 → Web 环境，window.open 新标签页打开（Chrome/Edge 内置 PDF 预览器）
//
// Electron 打包时需在 preload.js 中暴露：
//   contextBridge.exposeInMainWorld('electronAPI', {
//     openExternal: (url) => ipcRenderer.invoke('open-external', url)
//   })
// 主进程 ipcMain.handle('open-external', ...) 中按 URL 前缀分流：
//   http/https → shell.openExternal(url)
//   本地相对路径 → 解析为绝对路径后 shell.openPath(absPath)

/**
 * 打开外部链接（URL 或相对路径文件）
 * @param {string} url - 链接地址，如 'https://github.com/...' 或 './How2Use.pdf'
 */
export function openExternalLink(url) {
  if (typeof window !== 'undefined' && window.electronAPI?.openExternal) {
    // Electron 环境：通过预加载脚本暴露的 IPC 通道调系统默认程序
    window.electronAPI.openExternal(url)
  } else {
    // Web 环境：新标签页打开（Chrome/Edge 内置 PDF 预览器）
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
