// AskBranchFloat 提问支路 · 左侧浮窗（毛玻璃）
// 功能：结晶追问屏左侧 Detail 区浮现的支路对话浮窗——
//   右缘紧贴 WorkbenchDrawer 左缘、底边与「提问追加」输入行同一水平线；
//   身后铺一层可点收起的毛玻璃遮罩
// 实现方式：
//   - 读 store 的 explainBranchActiveKey 与该实例；visible && !collapsed 才渲染，否则返回 null
//   - 渲染在 Workspace 横向 flex 容器内的绝对定位包裹层（inset:0 / pointer-events:none / z-30）
//   - 几何跟随：可见期间用 requestAnimationFrame 循环量测抽屉/Detail/输入行三个锚点的
//     getBoundingClientRect()，只在数值变化时写 style；任一锚点缺失则整体隐藏
//   - 尺寸三阶段：内容高 → 首次发送扩到标准高度 → 随内容增长 → 到阈值停住改滚动
import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import useStore from '../services/store.js'
import StreamingMarkdown from './StreamingMarkdown.jsx'

// 面板标准高度（够放 1 组问答：一条用户气泡 + 3–5 句回复）——首次发送后自动扩到该高度
const STANDARD_H = 200
// 浮窗头部（✕ 行）高度，用于把"内容高"换算成"面板高"
const HEADER_H = 44

/**
 * AskBranchFloat 浮窗组件（由 Workspace 渲染在 Detail 与抽屉之间的横向容器里）
 */
function AskBranchFloat() {
  const activeKey = useStore((s) => s.explainBranchActiveKey)
  const inst = useStore((s) => (activeKey ? s.explainBranch[activeKey] : null))
  const askBranchCloseFloat = useStore((s) => s.askBranchCloseFloat)

  // 仅当有活跃实例、浮窗可见且提问追加未收起时渲染（收起 → 跟着隐藏，visible 仍保留）
  const visible = !!activeKey && !!inst?.visible && !inst?.collapsed
  const messages = inst?.messages || []

  const wrapRef = useRef(null)     // 绝对定位包裹层（覆盖横向容器）
  const overlayRef = useRef(null)  // 毛玻璃遮罩
  const panelRef = useRef(null)    // 浮窗面板
  const listRef = useRef(null)     // 消息列表（量内容高）
  const lastRef = useRef({})       // 上一次写入的几何值（变化检测；重新挂载时必须清空）
  const [appeared, setAppeared] = useState(false)
  // 几何是否已写入：未就位前不显示、不可点（防止任何情况下"停在静态位置"露出左上角）
  const [positioned, setPositioned] = useState(false)
  const positionedRef = useRef(false)

  // 就位标记：只在变化时 setState，避免 rAF 每帧触发重渲染
  const markPositioned = (v) => {
    if (positionedRef.current !== v) {
      positionedRef.current = v
      setPositioned(v)
    }
  }

  // 出现时淡入（只做 opacity，不引入夸张动效）
  useEffect(() => {
    if (!visible) {
      setAppeared(false)
      return
    }
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setAppeared(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [visible])

  // 几何跟随：可见期间循环量测三个锚点，只写变化过的值
  useEffect(() => {
    if (!visible) {
      markPositioned(false)
      return
    }
    // 关键修复：收起后再展开/再浮现时 React 会重建这些 DOM 节点（节点上没有任何内联几何），
    // 但 lastRef 还记着上一轮的"已写过"值 → put 会跳过写入，面板就停在静态位置（左上角）。
    // 所以每次重新进入可见态，清空记忆强制重写一次。
    lastRef.current = {}
    markPositioned(false)
    let raf = 0
    let cancelled = false

    const tick = () => {
      if (cancelled) return
      const wrap = wrapRef.current
      const overlay = overlayRef.current
      const panel = panelRef.current
      const drawer = document.getElementById('workbench-drawer')
      const detail = document.getElementById('inspiration-detail')
      const inputRow = document.getElementById('ask-branch-input-row')
      const last = lastRef.current

      // 任一锚点缺失（抽屉关闭、Detail 切空态等）：整体隐藏，但继续轮询以便自动恢复
      if (!wrap || !overlay || !panel || !drawer || !detail || !inputRow) {
        markPositioned(false)
        // 清掉"已就位"标记：幽灵动画据此判断浮窗是否已定位（避免量到未定位的静态位置）
        if (panel && panel.dataset.askPositioned !== 'false') panel.dataset.askPositioned = 'false'
        if (wrap && last.display !== 'none') {
          wrap.style.display = 'none'
          last.display = 'none'
          // 清空已记几何，重新出现时强制重写
          Object.keys(last).forEach((k) => { if (k !== 'display') delete last[k] })
        }
        raf = requestAnimationFrame(tick)
        return
      }

      // 包裹层 inset:0，其矩形即横向容器矩形
      const cRect = wrap.getBoundingClientRect()
      // 首次可用时恢复显示
      if (last.display !== 'block') {
        wrap.style.display = 'block'
        last.display = 'block'
      }

      const drawerRect = drawer.getBoundingClientRect()
      const detailRect = detail.getBoundingClientRect()
      const inputRect = inputRow.getBoundingClientRect()

      // 右对齐抽屉左缘 / 底对齐输入行底边（同一坐标系：均相对容器）
      const rightPx = `${Math.round(cRect.right - drawerRect.left)}px`
      const bottomPx = `${Math.round(cRect.bottom - inputRect.bottom)}px`
      // Detail 列左缘、抽屉左缘（用于铺毛玻璃）
      const overlayLeftPx = `${Math.round(detailRect.left - cRect.left)}px`
      const overlayWidthPx = `${Math.round(Math.max(0, drawerRect.left - detailRect.left))}px`
      const overlayHeightPx = `${Math.round(cRect.height)}px`
      // 浮窗宽度：min(420, Detail 宽 - 48)，右缘紧贴、不铺满 Detail
      const panelWidthPx = `${Math.round(Math.max(0, Math.min(420, detailRect.width - 48)))}px`

      // 尺寸三阶段：clamp(内容高 + 头部高, 标准高度, 阈值)
      // 阈值 = min(Detail 可用高度 * 0.7, 360)
      const contentH = listRef.current ? listRef.current.scrollHeight : 0
      const threshold = Math.min(detailRect.height * 0.7, 360)
      const upper = Math.max(threshold, STANDARD_H)
      const panelHeightPx = `${Math.round(Math.min(Math.max(contentH + HEADER_H, STANDARD_H), upper))}px`

      // 只在数值变化时写 style（键按元素加前缀，避免遮罩/面板同名属性互相干扰）
      const put = (el, prefix, key, val) => {
        const k = `${prefix}.${key}`
        if (last[k] === val) return
        last[k] = val
        el.style[key] = val
      }
      put(overlay, 'ov', 'left', overlayLeftPx)
      put(overlay, 'ov', 'width', overlayWidthPx)
      put(overlay, 'ov', 'height', overlayHeightPx)
      put(panel, 'pn', 'right', rightPx)
      put(panel, 'pn', 'bottom', bottomPx)
      put(panel, 'pn', 'width', panelWidthPx)
      put(panel, 'pn', 'height', panelHeightPx)

      // 就位标记：几何已写入本帧 → 供幽灵动画确认"浮窗已定位"（避免量到未定位的静态位置）
      if (panel.dataset.askPositioned !== 'true') panel.dataset.askPositioned = 'true'
      markPositioned(true)

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [visible])

  // 新消息 / 流式增量时自动滚到底部
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    list.scrollTop = list.scrollHeight
  }, [messages])

  // 未浮现：不渲染（无浮窗、无毛玻璃）
  if (!visible) return null

  // 只有"淡入完成 + 几何已写入"才真正显示与可点：
  // 任何几何未就位的瞬间（含重新展开的那几帧）都不会露出错误位置
  const shown = appeared && positioned

  // 找到"最新一条用户气泡"的索引（供幽灵动画定位）
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break }
  }

  return (
    // 包裹层：铺满横向容器，自身不接收事件，避免挡住 Detail 交互
    <div ref={wrapRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 30 }}>
      {/* 1. 毛玻璃遮罩：铺在 Detail 列（Detail 左缘 → 抽屉左缘），点它只收浮窗 */}
      <div
        ref={overlayRef}
        onClick={() => askBranchCloseFloat(activeKey)}
        style={{
          position: 'absolute',
          top: 0,
          pointerEvents: shown ? 'auto' : 'none',
          background: 'rgb(var(--deep-rgb) / 0.35)',
          backdropFilter: 'blur(6px)',
          WebkitBackdropFilter: 'blur(6px)',
          opacity: shown ? 1 : 0,
          transition: 'opacity 220ms ease'
        }}
      />

      {/* 2. 浮窗面板：右贴抽屉左缘、底齐输入行（位置由 rAF 循环写入 style）
          data-ask-float-panel / data-ask-positioned：供幽灵动画确认浮窗已定位 */}
      <div
        ref={panelRef}
        data-ask-float-panel="1"
        style={{
          position: 'absolute',
          display: 'flex',
          flexDirection: 'column',
          pointerEvents: shown ? 'auto' : 'none',
          overflow: 'hidden',
          borderRadius: '14px',
          background: 'rgb(var(--deep-rgb) / 0.8)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgb(var(--ink) / 0.06)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgb(var(--cyan-rgb) / 0.08)',
          opacity: shown ? 1 : 0,
          // 高度变化给 ~200ms 过渡（出现时同样的属性生效）
          transition: 'opacity 220ms ease, height 200ms cubic-bezier(0.16, 1, 0.3, 1)'
        }}
      >
        {/* 右上角小号低对比 ✕：只收浮窗，不影响提问追加（不加任何标题文案） */}
        <div className="flex justify-end px-2 pt-1.5 pb-0.5 flex-shrink-0">
          <button
            type="button"
            onClick={() => askBranchCloseFloat(activeKey)}
            title="收起"
            className="glow-btn p-1 rounded-md text-ink/25 hover:text-ink/50 transition-colors"
          >
            <X size={13} />
          </button>
        </div>

        {/* 消息列表（可滚动；超出阈值时内部滚动） */}
        <div
          ref={listRef}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 pb-3 space-y-2"
        >
          {messages.map((m, i) => (
            m.role === 'user' ? (
              // 用户气泡：右对齐、青色 tint；最新一条打标记供幽灵动画定位
              <div
                key={i}
                className="flex justify-end"
                {...(i === lastUserIdx ? { 'data-ask-bubble-last': 'user' } : {})}
              >
                <div
                  className="max-w-[85%] px-2.5 py-1.5 rounded-xl text-[13px] leading-relaxed text-ink/90 font-sans whitespace-pre-wrap break-words"
                  style={{
                    background: 'rgb(var(--cyan-rgb) / 0.16)',
                    border: '1px solid rgb(var(--cyan-rgb) / 0.28)'
                  }}
                >
                  {m.content}
                </div>
              </div>
            ) : (
              // AI 气泡：左对齐、低饱和玻璃质感，流式用 StreamingMarkdown 渲染
              <div key={i} className="flex justify-start">
                <div
                  className="max-w-[92%] px-2.5 py-1.5 rounded-xl text-[13px] text-ink/85 glass-card break-words"
                  style={{ border: '1px solid rgb(var(--ink) / 0.06)' }}
                >
                  <StreamingMarkdown text={m.content || ''} streaming={!!m.streaming} />
                </div>
              </div>
            )
          ))}

          {/* 错误：小号淡红一行，不弹窗、不回滚气泡 */}
          {inst?.error && (
            <div className="text-rose-300/80 text-[10px] font-sans px-1 leading-relaxed">
              {inst.error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default AskBranchFloat