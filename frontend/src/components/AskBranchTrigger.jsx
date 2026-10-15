// AskBranchTrigger 提问支路 · 右侧「提问追加」区（放大镜开关版）
// 功能：结晶追问屏每题下方的一条支路入口——
//   默认收起（提问面板不显露）；点右下角「有问题」放大镜按钮（位于「下一题」上方）才展开面板：
//     第一行：选项A..N 芯片（左对齐，按真实选项数生成）+ 小号「阐释题目」按钮（右对齐同一行）
//     第二行：输入框 + 发送（用户点发送才真正调用，流式）
//   芯片与「阐释题目」点选只预填、不发送；再点放大镜收起（浮窗跟着收，内容保留）
// 实现方式：
//   - 读 store 中该 instanceKey 的 draft/collapsed/loading/messages，写操作走 askBranch* actions
//   - 挂载与 instanceKey 变化时 askBranchActivate（换题即换实例 → 自动清空旧实例）
//   - 点发送：先存输入框矩形与文本快照 → 调 askBranchSend（不 await）→
//     用 createPortal 到 document.body 的幽灵 span 沿水平线滑到目标气泡后淡出
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HelpCircle, Search, Send, Loader2 } from 'lucide-react'
import useStore from '../services/store.js'

/**
 * 幽灵 span（水平平移动画）
 * 功能：点发送时把输入框文字沿同一条水平线向左滑入浮窗，成为用户气泡
 * 实现方式：
 *   - 用 createPortal 挂到 document.body，避免被带 backdrop-filter 的祖先当作包含块
 *   - position:fixed，起点=输入框位置；y 恒定（只做水平位移，不斜飞不缩放）
 *   - 下一帧设置 transform: translate3d(Δx, 0, 0)，360ms cubic-bezier 过渡
 *   - 到点后淡出并回调 onFinish 移除
 * @param {{ghost: {text, x, y, fontSize, color, dx}, onFinish: () => void}} props
 */
function AskBranchGhost({ ghost, onFinish }) {
  const ref = useRef(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 起始帧：起点处（Δx=0）、不透明
    el.style.transform = 'translate3d(0, 0, 0)'
    el.style.opacity = '1'
    // 双 rAF 确保起始样式已上屏，再触发过渡
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        el.style.transition = 'transform 360ms cubic-bezier(0.16, 1, 0.3, 1)'
        el.style.transform = `translate3d(${ghost.dx}px, 0, 0)`
      })
    })
    // 到点后淡出 → 回调移除（真实气泡在此间淡入）
    const fadeTimer = setTimeout(() => {
      el.style.transition = 'opacity 160ms ease'
      el.style.opacity = '0'
    }, 400)
    const removeTimer = setTimeout(onFinish, 580)
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
      clearTimeout(fadeTimer)
      clearTimeout(removeTimer)
    }
  }, [ghost, onFinish])

  return createPortal(
    <span
      ref={ref}
      aria-hidden="true"
      style={{
        position: 'fixed',
        left: `${ghost.x}px`,
        top: `${ghost.y}px`,
        fontSize: ghost.fontSize,
        color: ghost.color,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        zIndex: 2000,
        willChange: 'transform, opacity'
      }}
    >
      {ghost.text}
    </span>,
    document.body
  )
}

/**
 * AskBranchTrigger 提问支路入口区
 * @param {{instanceKey: string, question: object, context: object}} props
 *   question / context 即请求体里的两个对象，由调用点拼好传入
 */
function AskBranchTrigger({ instanceKey, question, context }) {
  // 该实例的状态（未激活前为 undefined，用默认值兜底；默认收起）
  const inst = useStore((s) => s.explainBranch[instanceKey])
  const draft = inst?.draft ?? ''
  const collapsed = inst?.collapsed ?? true
  const loading = inst?.loading ?? false
  // 是否已有支路对话：收起后放大镜保持点亮，提示"这里还留着一段问答"
  const hasChat = (inst?.messages || []).length > 0

  // actions
  const askBranchActivate = useStore((s) => s.askBranchActivate)
  const askBranchPrefill = useStore((s) => s.askBranchPrefill)
  const askBranchSetDraft = useStore((s) => s.askBranchSetDraft)
  const askBranchSend = useStore((s) => s.askBranchSend)
  const askBranchCollapse = useStore((s) => s.askBranchCollapse)
  const askBranchExpand = useStore((s) => s.askBranchExpand)

  const inputRef = useRef(null)
  // 幽灵动画的局部状态（{ text, x, y, fontSize, color, dx }）
  const [ghost, setGhost] = useState(null)
  // 稳定的移除回调（避免流式期间的频繁重渲染重启幽灵动画）
  const finishGhost = useCallback(() => setGhost(null), [])

  // 挂载与换题时激活该实例（清掉其它实例，实现"换题清空"）
  useEffect(() => {
    askBranchActivate(instanceKey)
  }, [instanceKey, askBranchActivate])

  // 选项字母：按真实选项数生成（多选可能有 5 个以上，不能写死到 D）
  const options = Array.isArray(question?.options) ? question.options : []
  const letters = options.map((_, i) => String.fromCharCode(65 + i))

  /**
   * 点发送：预存输入框几何 + 文本快照 → 调发送（不 await）→ 播幽灵动画
   * 实现方式：
   *   1. 立刻快照输入框矩形/字号/颜色与文本
   *   2. askBranchSend 触发 store 更新（浮窗浮现、气泡追加），不等待
   *   3. 轮询查找目标气泡（[data-ask-bubble-last="user"]），待它落到输入行左侧再算 Δx
   *   4. 找不到 / 超时 → 不播动画（回退）
   */
  const handleSend = () => {
    const text = draft.trim()
    if (!text || loading) return
    const input = inputRef.current
    askBranchSend(instanceKey, { question, context })
    if (!input) return
    const rect = input.getBoundingClientRect()
    const cs = window.getComputedStyle(input)
    const padLeft = parseFloat(cs.paddingLeft) || 0
    const fontSize = cs.fontSize || '14px'
    // 纵向居中：起点 y 恒定在输入框文字中线附近
    const lineH = (parseFloat(fontSize) || 14) * 1.4
    setGhost({
      text,
      x: rect.left + padLeft,
      y: rect.top + (rect.height - lineH) / 2,
      fontSize,
      color: cs.color || 'rgb(255 255 255 / 0.85)',
      dx: 0
    })
    // 浮窗几何由 AskBranchFloat 的 rAF 循环写入，需等气泡落到输入行左侧再定位
    const inputLeft = rect.left
    let attempts = 0
    const seekTarget = () => {
      // 只在"已定位"的浮窗面板内找目标气泡：避免量到浮窗尚未写入几何时的静态位置
      const target = document.querySelector(
        '[data-ask-float-panel][data-ask-positioned="true"] [data-ask-bubble-last="user"]'
      )
      if (target) {
        const tr = target.getBoundingClientRect()
        // 气泡已可见且位于输入行左侧 → 认为就位
        if (tr.width > 0 && tr.left < inputLeft) {
          setGhost((g) => (g ? { ...g, dx: tr.left + 10 - g.x } : g))
          return
        }
      }
      attempts += 1
      if (attempts > 12) {
        // 超时兜底：跳过动画
        setGhost(null)
        return
      }
      requestAnimationFrame(seekTarget)
    }
    requestAnimationFrame(() => requestAnimationFrame(seekTarget))
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSend()
    }
  }

  // 放大镜开关：收起 ↔ 展开
  const toggle = () => (collapsed ? askBranchExpand(instanceKey) : askBranchCollapse(instanceKey))
  // 点亮条件：面板展开中，或已有一段支路对话（收起后仍提示）
  const lit = !collapsed || hasChat

  return (
    <div className="px-4">
      {/* 提问面板：默认隐藏，仅放大镜展开后出现 */}
      {!collapsed && (
        <div className="pt-3 pb-1 border-t border-line/5 animate-fade-in-up">
          {/* 第一行：选项芯片（左对齐、按真实选项数生成）+ 小号「阐释题目」（右对齐同一行） */}
          <div className="flex items-center gap-2 mb-2">
            {letters.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                {letters.map((letter) => (
                  <button
                    key={letter}
                    type="button"
                    onClick={() => askBranchPrefill(instanceKey, `关于『选项${letter}』，我不明白`)}
                    className="glow-btn px-2.5 py-1 rounded-md text-[11px] font-sans transition-all"
                    style={{
                      border: '1px solid rgb(var(--ink) / 0.08)',
                      background: 'rgb(var(--cyan-rgb) / 0.06)',
                      color: 'rgb(var(--ink) / 0.6)'
                    }}
                  >
                    {`选项${letter}`}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => askBranchPrefill(instanceKey, '这题到底在问什么？')}
              className="glow-btn ml-auto flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-sans transition-all"
              style={{
                border: '1px dashed rgb(var(--cyan-rgb) / 0.35)',
                background: 'transparent',
                color: 'var(--accent-cyan-bright)'
              }}
            >
              <HelpCircle size={11} className="flex-shrink-0" />
              <span>阐释题目</span>
            </button>
          </div>

          {/* 第二行：输入行（单行输入框 + 发送；Enter 等同点发送）
              该行是浮窗几何锚点（AskBranchFloat 量测它来对齐浮窗底边） */}
          <div id="ask-branch-input-row" className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => askBranchSetDraft(instanceKey, e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="继续写…"
              className="input-accent flex-1 rounded-lg px-2.5 py-1.5 text-sm text-ink/85 placeholder-ink/25 font-sans"
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={loading || !draft.trim()}
              className="glow-btn btn-accent flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-white text-[11px] font-medium font-sans disabled:opacity-40"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              <span>发送</span>
            </button>
          </div>
        </div>
      )}

      {/* 「有问题」放大镜开关：右对齐、位于「下一题」上方；收起时也可见（面板唯一入口） */}
      <div className="flex justify-end py-1.5">
        <button
          type="button"
          onClick={toggle}
          title={collapsed ? '有问题？问 AI' : '收起提问追加'}
          className="glow-btn w-7 h-7 rounded-full flex items-center justify-center transition-all"
          style={{
            border: `1px solid ${lit ? 'rgb(var(--cyan-rgb) / 0.38)' : 'rgb(var(--ink) / 0.1)'}`,
            background: lit ? 'rgb(var(--cyan-rgb) / 0.1)' : 'transparent',
            color: lit ? 'var(--accent-cyan-bright)' : 'rgb(var(--ink) / 0.4)'
          }}
        >
          <Search size={13} />
        </button>
      </div>

      {/* 幽灵动画：水平平移的输入文字快照（portal 到 body） */}
      {ghost && <AskBranchGhost ghost={ghost} onFinish={finishGhost} />}
    </div>
  )
}

export default AskBranchTrigger