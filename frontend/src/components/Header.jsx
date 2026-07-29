// Header 顶部导航组件（深空智识美学）
// 功能：展示衬线双色应用名 + 副标题 + 灵感网络按钮 + 玻璃态新建按钮
// 实现方式：纯展示组件；使用 Cormorant Garamond 衬线字 + 玻璃态卡片样式
// K3-f：新增"灵感网络"按钮，触发 ForceGraph 全屏覆盖层
import React from 'react'
import { Plus, Network, Bookmark, Settings } from 'lucide-react'
import useStore from '../services/store.js'

/**
 * @param {object} props
 * @param {Function} props.onNewInspiration - 点击"新建灵感"按钮时的回调
 */
function Header({ onNewInspiration }) {
  // K3-f：从 store 读取 openForceGraph action
  const openForceGraph = useStore((s) => s.openForceGraph)
  const forceGraphLoading = useStore((s) => s.forceGraphLoading)
  // 继续思考：从 store 读取 openContinueThinking action 与已保存回答数
  const openContinueThinking = useStore((s) => s.openContinueThinking)
  const savedRepliesCount = useStore((s) => s.savedRepliesList.length)
  // 设置面板
  const openSettings = useStore((s) => s.openSettings)

  return (
    // 顶部导航：玻璃态面板 + 渐变底边
    <header className="relative glass-panel border-b border-line/5">
      {/* 渐变底边：cyan → transparent，营造光晕分隔效果 */}
      <div
        className="absolute bottom-0 left-0 right-0 h-px"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, rgb(var(--cyan-rgb) / 0.4) 30%, rgb(var(--amber-rgb) / 0.3) 70%, transparent 100%)'
        }}
      />
      <div className="flex items-center justify-between px-8 py-5">
        {/* 左侧：应用名 + 副标题 */}
        <div className="flex items-center gap-4">
          {/* 应用 Logo：AIRA.png */}
          <div className="relative">
            <div
              className="absolute inset-0 rounded-full blur-md animate-pulse-soft"
              style={{ background: 'rgb(var(--cyan-rgb) / 0.3)' }}
            />
            <img src="/AIRA.png" alt="AIRA" className="relative w-11 h-11 object-cover" style={{ borderRadius: '10px' }} />
          </div>
          <div className="flex flex-col">
            {/* 双色应用名：AIRA's 青色 + 's Diary 琥珀色，衬线字体 */}
            <h1
              className="font-display text-2xl font-semibold leading-none"
              style={{ letterSpacing: '-0.02em' }}
            >
              <span style={{ color: 'var(--accent-cyan)' }}>AIRA's</span>
              <span style={{ color: 'var(--accent-amber)' }} className="italic">
                {' '}
                Diary
              </span>
            </h1>
            {/* 副标题：极淡的描述文字 */}
            <p className="text-[10px] tracking-[0.2em] uppercase text-white/30 mt-1 font-sans text-center">
              Crystallize your thoughts
            </p>
          </div>
        </div>

        {/* 右侧：灵感网络按钮 + 新建灵感按钮 */}
        <div className="flex items-center gap-3">
          {/* K3-f：灵感网络按钮（触发 ForceGraph 全屏覆盖层） */}
          <button
            type="button"
            onClick={openForceGraph}
            disabled={forceGraphLoading}
            className="glass-card flex items-center gap-2 px-4 py-2.5 rounded-xl text-ink/70 hover:text-ink/95 text-sm font-medium transition-all group disabled:opacity-50"
            title="查看灵感网络（力导向图总览）"
          >
            <Network
              size={16}
              className="transition-transform group-hover:scale-110"
              style={{ color: '#a855f7' }}
            />
            <span>灵感网络</span>
          </button>

          {/* 继续思考按钮：打开已保存对话面板 */}
          <button
            type="button"
            onClick={openContinueThinking}
            className="glass-card flex items-center gap-2 px-4 py-2.5 rounded-xl text-ink/70 hover:text-ink/95 text-sm font-medium transition-all group"
            title="查看搁置的思考（已保存的对话回答）"
          >
            <Bookmark
              size={16}
              className="transition-transform group-hover:scale-110"
              style={{ color: 'var(--accent-amber)' }}
            />
            <span>接着想{savedRepliesCount > 0 ? ` (${savedRepliesCount})` : ''}</span>
          </button>

          {/* 新建灵感按钮（玻璃态 + cyan 光晕） */}
          <button
            type="button"
            onClick={onNewInspiration}
            className="btn-accent flex items-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-medium"
          >
            <Plus size={16} strokeWidth={2.5} />
            <span>新建灵感</span>
          </button>

          {/* 分隔线：系统级操作与灵感操作隔离 */}
          <div className="h-7 w-px bg-veil/[0.08] ml-1" />

          {/* 设置按钮（齿轮图标） */}
          <button
            type="button"
            onClick={openSettings}
            className="glass-card flex items-center justify-center w-10 h-10 rounded-xl text-ink/40 hover:text-ink/80 transition-all group"
            title="设置"
          >
            <Settings
              size={18}
              className="transition-transform duration-500 group-hover:rotate-90"
            />
          </button>
        </div>
      </div>
    </header>
  )
}

export default Header
