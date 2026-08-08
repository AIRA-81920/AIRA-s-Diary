// 应用入口文件
// 功能：使用 ReactDOM.createRoot 将根组件 App 挂载到 #root 节点
// 实现方式：React 18 的 createRoot API，并导入全局 index.css 以加载 Tailwind 样式
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { initGlowSystem } from './services/glowSystem.js'
import useStore from './services/store.js'

// 启动时先恢复主题（render 前设置 <html data-theme>，避免亮/暗闪烁）
document.documentElement.dataset.theme = localStorage.getItem('aira-theme') || 'dark'

// 初始化微光系统：全局事件委托（幂等，StrictMode 双执行安全）
// 功能：让所有 .glow-btn / .glow-card 组件获得"鼠标跟随光斑 + 边框呼应"效果
initGlowSystem()

// 网络图徽标轮询：拉取待查看的新桥梁数量，用于入口图标红点提示
// 实现方式：
//   1. 应用启动时立即调用一次 loadPendingBridgeCount（不等 60s，让首屏徽标即正确）
//   2. 之后每 60 秒轮询一次，但仅当 forceGraphOpen === false 时才发起请求——
//      网络图打开时 openForceGraph 已清零并 mark-seen，轮询无意义且会覆盖清零态
//   3. 模块级 setInterval，SPA 整个生命周期运行，无需 clearInterval（应用卸载即进程退出）
useStore.getState().loadPendingBridgeCount()
setInterval(() => {
  if (!useStore.getState().forceGraphOpen) {
    useStore.getState().loadPendingBridgeCount()
  }
}, 60 * 1000)

// 挂载应用：createRoot 返回根对象，render 渲染 App 组件
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
