// ResizablePanel 可调宽容器组件（深空智识美学）
// 功能：包裹任意子组件，提供 4px 拖拽手柄，支持平滑过渡动画
// 实现方式：
//   - 拖拽手柄位于面板右侧（side='right'）或左侧（side='left'）
//   - 拖拽时禁用 CSS transition（直接跟随鼠标），松手后恢复（动画归位）
//   - 拖拽期间为子容器加 .panel-transitioning 类，临时禁用 backdrop-filter
//     避免 backdrop-filter 在宽度变化时频繁重绘导致卡顿
//   - 手柄 hover/active 时显示青色光带，拖拽中显示宽度数字浮层
import React, { useState, useCallback, useRef, useEffect } from 'react'

/**
 * @param {object} props
 * @param {number} props.width - 当前宽度（px）
 * @param {number} props.minWidth - 最小宽度（px）
 * @param {number} props.maxWidth - 最大宽度（px）
 * @param {Function} props.onResize - 宽度变化回调，参数为新宽度（px）
 * @param {'left'|'right'} [props.side='right'] - 拖拽手柄所在边
 * @param {string} [props.className] - 容器额外类名
 * @param {boolean} [props.collapsed=false] - 是否处于收起态（收起时不显示手柄）
 * @param {React.ReactNode} props.children - 子内容
 */
function ResizablePanel({
  width,
  minWidth,
  maxWidth,
  onResize,
  side = 'right',
  className = '',
  collapsed = false,
  children
}) {
  // 拖拽状态：是否正在拖拽 / 起始 X / 起始宽度
  const [dragging, setDragging] = useState(false)
  // 拖拽起始信息（用 ref 避免 re-render）
  const dragInfo = useRef({ startX: 0, startWidth: 0 })
  // 宽度浮层显示值（拖拽中显示）
  const [hoverWidth, setHoverWidth] = useState(null)
  // 手柄 hover 态
  const [handleHover, setHandleHover] = useState(false)

  /**
   * 拖拽开始：记录起始 X 与起始宽度，绑定全局 mousemove/mouseup
   */
  const handleMouseDown = useCallback(
    (e) => {
      // 收起态不允许拖拽
      if (collapsed) return
      e.preventDefault()
      e.stopPropagation()
      setDragging(true)
      dragInfo.current = { startX: e.clientX, startWidth: width }

      const handleMouseMove = (ev) => {
        const delta = ev.clientX - dragInfo.current.startX
        // 手柄在右侧：拖拽向右 = 增宽；手柄在左侧：拖拽向左 = 增宽
        const newWidth = side === 'right'
          ? dragInfo.current.startWidth + delta
          : dragInfo.current.startWidth - delta
        // 夹紧到 [minWidth, maxWidth]
        const clamped = Math.min(maxWidth, Math.max(minWidth, newWidth))
        onResize(clamped)
        setHoverWidth(clamped)
      }

      const handleMouseUp = () => {
        setDragging(false)
        setHoverWidth(null)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        // 拖拽结束：恢复 body 光标
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      // 拖拽期间禁用文本选择 + 固定光标
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [width, minWidth, maxWidth, onResize, side, collapsed]
  )

  // 组件卸载时清理光标
  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  // 容器样式：拖拽时禁用 transition（直接跟随鼠标），否则启用平滑过渡
  const transitionStyle = dragging
    ? { transition: 'none' }
    : { transition: 'width 400ms cubic-bezier(0.16, 1, 0.3, 1)' }

  return (
    <div
      className={`relative flex-shrink-0 ${dragging ? 'panel-transitioning' : ''} ${className}`}
      style={{
        width,
        ...transitionStyle,
        // 容器自身提供玻璃态背景（拖拽时由 .panel-transitioning 切纯色）
        background: dragging ? 'rgb(var(--deep-rgb) / 0.92)' : 'rgb(var(--deep-rgb) / 0.6)',
        backdropFilter: dragging ? 'none' : 'blur(20px)',
        WebkitBackdropFilter: dragging ? 'none' : 'blur(20px)'
      }}
    >
      {/* 子内容容器：撑满父级 */}
      <div className="h-full w-full">{children}</div>

      {/* 拖拽手柄：4px 宽，绝对定位在 side 指定的边
          - 默认半透明，hover/active 时显示青色光带
          - 收起态隐藏手柄 */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleMouseDown}
          onMouseEnter={() => setHandleHover(true)}
          onMouseLeave={() => setHandleHover(false)}
          className={`panel-resize-handle absolute top-0 bottom-0 z-40 ${
            side === 'right' ? 'right-0' : 'left-0'
          }`}
          style={{
            width: '4px',
            cursor: 'col-resize',
            // 默认半透明白，hover/拖拽时切青色光带
            background: (handleHover || dragging)
              ? 'linear-gradient(180deg, transparent, rgb(var(--cyan-rgb) / 0.6), transparent)'
              : 'transparent',
            transition: 'background 200ms ease',
            // 拖拽中光带更亮
            boxShadow: dragging ? '0 0 8px rgb(var(--cyan-rgb) / 0.5)' : 'none'
          }}
          title="拖拽调整宽度"
        />
      )}

      {/* 宽度浮层：拖拽中显示当前宽度数字 */}
      {dragging && hoverWidth != null && (
        <div
          className="absolute top-1/2 -translate-y-1/2 z-50 px-2.5 py-1 rounded-md text-[11px] font-sans pointer-events-none"
          style={{
            // 浮层贴近手柄：right 边手柄 → 浮层显示在手柄左侧；left 边反之
            [side === 'right' ? 'right' : 'left']: '12px',
            background: 'rgb(var(--cyan-rgb) / 0.15)',
            border: '1px solid rgb(var(--cyan-rgb) / 0.3)',
            color: 'var(--accent-cyan-light)',
            backdropFilter: 'blur(8px)'
          }}
        >
          {Math.round(hoverWidth)}px
        </div>
      )}
    </div>
  )
}

export default ResizablePanel
