// WorkbenchDrawer 工作台抽屉容器（K3-e + K4-b 改造：挤压式抽屉）
// 功能：挤压式挂载 CrystallizePanel 或 EpitaxyPanel（与 Detail 并列，不再替换）
// 实现方式：
//   - K4-b 修订 ADR-4：抽屉与 Detail 并列（挤压式），Detail 不消失
//   - 一次仅一个抽屉（store.drawer: 'none' | 'crystallize' | 'epitaxy'）
//   - 400ms cubic-bezier 过渡（width + opacity）
//   - 拖拽调宽（store.drawerWidth，min 440 / max 720，默认 520）
//   - 拖拽期间 .panel-transitioning 纯色降级（R7 防 backdrop-filter 重绘掉帧）
//   - 关闭按钮 → closeDrawer()，中间态自动保存到 drawerCache（"接着干"）
//   - K4-b：双击手柄 reset 到默认宽度 520px
//   - K4-b：拖拽时显示宽度浮窗
import React, { useState, useRef, useCallback, useEffect } from 'react'
import { X } from 'lucide-react'
import useStore from '../services/store.js'
import CrystallizePanel from './CrystallizePanel.jsx'
import EpitaxyPanel from './EpitaxyPanel.jsx'

/**
 * 抽屉头部标题映射
 * drawer kind → { title, subtitle, accentColor }
 */
const DRAWER_META = {
  crystallize: {
    title: '灵感结晶',
    subtitle: '感知类型 → 追问 → 结晶体',
    accent: '#06b6d4'  // 青色
  },
  epitaxy: {
    title: '外延探究',
    subtitle: '方向卡片 → 深挖 → 词块提炼',
    accent: '#a855f7'  // 紫色
  }
}

/**
 * WorkbenchDrawer 抽屉外壳
 * 功能：挤压式挂载 CrystallizePanel/EpitaxyPanel，提供关闭按钮 + 拖拽调宽
 */
function WorkbenchDrawer() {
  // 从 store 读取抽屉状态与 actions
  const drawer = useStore((s) => s.drawer)
  const closeDrawer = useStore((s) => s.closeDrawer)
  const drawerWidth = useStore((s) => s.drawerWidth)
  const drawerWidthDefault = useStore((s) => s.drawerWidthDefault)
  const setDrawerWidth = useStore((s) => s.setDrawerWidth)
  const selectedInspiration = useStore((s) => s.selectedInspiration)

  // 拖拽状态
  const [dragging, setDragging] = useState(false)
  const [handleHover, setHandleHover] = useState(false)
  const [liveWidth, setLiveWidth] = useState(null)  // K4-b：拖拽时实时显示的宽度
  // fix5-4：挂载动画状态——挂载时从 width=0 过渡到 drawerWidth，实现"从右滑入"动画
  const [mounted, setMounted] = useState(false)
  const dragInfo = useRef({ startX: 0, startWidth: 0 })

  // fix5-4：挂载后下一帧设为 true，触发 width 从 0 → drawerWidth 的 transition
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setMounted(true))
    })
  }, [])

  // 抽屉未打开或无选中灵感：不渲染（由父组件控制是否挂载）
  if (drawer === 'none' || !selectedInspiration) {
    return null
  }

  const meta = DRAWER_META[drawer] || DRAWER_META.crystallize

  /**
   * 拖拽开始：记录起始 X 与起始宽度，绑定全局 mousemove/mouseup
   * 实现方式：拖拽向左 → 增加宽度（手柄在左边缘）
   */
  const handleResizeStart = useCallback(
    (e) => {
      e.preventDefault()
      e.stopPropagation()
      setDragging(true)
      dragInfo.current = { startX: e.clientX, startWidth: drawerWidth }

      const handleMouseMove = (ev) => {
        // 向左拖动 → delta 为负 → 宽度增加
        const delta = dragInfo.current.startX - ev.clientX
        const newWidth = dragInfo.current.startWidth + delta
        // 实时更新浮窗显示
        setLiveWidth(newWidth)
        setDrawerWidth(newWidth)
      }

      const handleMouseUp = () => {
        setDragging(false)
        setLiveWidth(null)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [drawerWidth, setDrawerWidth]
  )

  /**
   * K4-b：双击手柄 reset 到默认宽度
   */
  const handleDoubleClick = useCallback(() => {
    setDrawerWidth(drawerWidthDefault)
  }, [drawerWidthDefault, setDrawerWidth])

  // 组件卸载时清理光标
  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  return (
    // 抽屉主容器：K4-b 挤压式（与 Detail 并列），宽度过渡 400ms
    // fix5-4：挂载时 width=0，下一帧过渡到 drawerWidth，实现"从右滑入"动画
    <div
      className={`insp-themed relative flex-shrink-0 overflow-hidden ${mounted ? 'animate-fade-in' : ''} ${dragging ? 'panel-transitioning' : ''}`}
      style={{
        // fix5-4：挂载前 width=0，挂载后 width=drawerWidth，触发 transition
        width: mounted ? `${drawerWidth}px` : '0px',
        transition: dragging
          ? 'none'
          : 'width 400ms cubic-bezier(0.16, 1, 0.3, 1)',
        // 拖拽期间纯色降级（R7），避免 backdrop-filter 重绘掉帧
        background: dragging ? 'rgb(var(--deep-rgb) / 0.92)' : 'rgb(var(--deep-rgb) / 0.6)',
        backdropFilter: dragging ? 'none' : 'blur(20px)',
        WebkitBackdropFilter: dragging ? 'none' : 'blur(20px)',
        borderLeft: '1px solid rgb(var(--ink) / 0.05)',
        boxShadow: `-8px 0 32px rgba(0,0,0,0.4), 0 0 0 1px ${meta.accent}10`
      }}
    >
      {/* UI 精修：抽屉点亮动画——"光先亮、面板再滑出"
          挂载时（mounted=true 的下一帧）光晕从左侧渐变浮现，与 width 滑入过渡同节奏 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: `radial-gradient(ellipse 65% 45% at 0% 50%, ${meta.accent}1f, transparent 70%)`,
          opacity: mounted ? 1 : 0,
          transition: 'opacity 400ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      />

      {/* 头部：标题 + 副标题 + 关闭按钮 */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-line/5"
        style={{ background: `linear-gradient(180deg, ${meta.accent}08, transparent)` }}
      >
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: meta.accent, boxShadow: `0 0 8px ${meta.accent}` }}
            />
            <h3
              className="font-display text-base font-semibold text-ink/90"
              style={{ letterSpacing: '-0.01em' }}
            >
              {meta.title}
            </h3>
          </div>
          <p className="text-ink/35 text-[10px] mt-0.5 ml-3.5 font-sans">
            {meta.subtitle}
          </p>
        </div>
        <button
          type="button"
          onClick={closeDrawer}
          className="glow-btn modal-close-btn p-1.5 rounded-md text-ink/30"
          title="关闭抽屉（中间态已保存，可继续接着干）"
        >
          <X size={14} />
        </button>
      </div>

      {/* 内容区：absolute + opacity 交叉淡入淡出切换面板 */}
      <div className="absolute inset-0 top-[68px]">
        {/* CrystallizePanel：仅 drawer === 'crystallize' 时可见 */}
        <div
          className="absolute inset-0"
          style={{
            opacity: drawer === 'crystallize' ? 1 : 0,
            transition: 'opacity 300ms ease',
            pointerEvents: drawer === 'crystallize' ? 'auto' : 'none'
          }}
        >
          {drawer === 'crystallize' && (
            <CrystallizePanel
              inspiration={selectedInspiration}
              onCollapse={closeDrawer}
            />
          )}
        </div>

        {/* EpitaxyPanel：仅 drawer === 'epitaxy' 时可见 */}
        <div
          className="absolute inset-0"
          style={{
            opacity: drawer === 'epitaxy' ? 1 : 0,
            transition: 'opacity 300ms ease',
            pointerEvents: drawer === 'epitaxy' ? 'auto' : 'none'
          }}
        >
          {drawer === 'epitaxy' && (
            <EpitaxyPanel
              inspiration={selectedInspiration}
              onCollapse={closeDrawer}
            />
          )}
        </div>
      </div>

      {/* 左边缘拖拽手柄：K4-b 手柄区域扩到 8px，双击 reset */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={handleResizeStart}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={() => setHandleHover(true)}
        onMouseLeave={() => setHandleHover(false)}
        className="absolute top-0 bottom-0 left-0 z-40"
        style={{
          width: '8px',
          cursor: 'col-resize',
          background: 'transparent',
          transition: 'background 200ms ease'
        }}
        title="拖拽调整宽度，双击恢复默认"
      >
        {/* 可见光带（2px，居中于 8px 手柄区域内） */}
        <div
          className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2"
          style={{
            width: '2px',
            background: (handleHover || dragging)
              ? `linear-gradient(180deg, transparent, ${meta.accent}80, transparent)`
              : 'transparent',
            transition: 'background 200ms ease',
            boxShadow: dragging ? `0 0 8px ${meta.accent}80` : 'none'
          }}
        />

        {/* K4-b：拖拽时显示宽度浮窗
            fix5-4：浮窗从手柄内部移到抽屉内部（left: 16px），避免被相邻 Detail 面板遮挡
            z-index 提升到 z-50，确保浮窗始终在最上层 */}
        {dragging && liveWidth && (
          <div
            className="absolute top-1/2 -translate-y-1/2 z-50 px-2.5 py-1 rounded-md text-[11px] font-mono pointer-events-none whitespace-nowrap"
            style={{
              left: '16px',
              background: 'rgb(var(--deep-rgb) / 0.95)',
              color: meta.accent,
              border: `1px solid ${meta.accent}40`,
              boxShadow: `0 0 12px ${meta.accent}40, 0 4px 16px rgba(0,0,0,0.6)`,
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)'
            }}
          >
            {Math.round(liveWidth)}px
          </div>
        )}
      </div>
    </div>
  )
}

export default WorkbenchDrawer
