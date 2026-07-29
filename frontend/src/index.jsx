// 应用入口文件
// 功能：使用 ReactDOM.createRoot 将根组件 App 挂载到 #root 节点
// 实现方式：React 18 的 createRoot API，并导入全局 index.css 以加载 Tailwind 样式
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// 启动时先恢复主题（render 前设置 <html data-theme>，避免亮/暗闪烁）
document.documentElement.dataset.theme = localStorage.getItem('aira-theme') || 'dark'

// 挂载应用：createRoot 返回根对象，render 渲染 App 组件
createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
