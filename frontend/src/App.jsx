// App 应用根组件
// 功能：应用启动时拉取灵感列表，渲染主工作区
// 实现方式：useEffect 在组件挂载后调用 store.loadInspirations()，外层包裹全屏暗色背景
import React, { useEffect } from 'react'
import Workspace from './components/Workspace.jsx'
import useStore from './services/store.js'

function App() {
  // 应用启动时加载灵感列表
  const loadInspirations = useStore((state) => state.loadInspirations)
  // v8：加载文件夹列表
  const loadFolders = useStore((state) => state.loadFolders)
  // 订阅主题：切换时全树重渲染，使 JS 侧按主题取值的语义色（themeTokens）即时生效
  const theme = useStore((state) => state.theme)

  useEffect(() => {
    loadInspirations()
    loadFolders()
  }, [loadInspirations, loadFolders])

  // 最外层：全屏背景走 --bg-base 变量（dark=#0a0e1a），亮暗随 <html data-theme> 翻转
  return (
    <div className="h-screen app-shell" style={{ background: 'var(--bg-base)' }} data-theme-active={theme}>
      <Workspace />
    </div>
  )
}

export default App
