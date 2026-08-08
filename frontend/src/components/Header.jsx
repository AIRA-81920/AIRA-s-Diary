// Header 顶部导航组件（深空智识美学）
// 功能：展示衬线双色应用名 + 副标题 + 灵感网络按钮 + 玻璃态新建按钮
// 实现方式：纯展示组件；使用 Cormorant Garamond 衬线字 + 玻璃态卡片样式
// K3-f：新增"灵感网络"按钮，触发 ForceGraph 全屏覆盖层
import React, { useState, useRef, useEffect, useCallback } from 'react'
import { Plus, Network, Bookmark, Settings } from 'lucide-react'
import useStore from '../services/store.js'
import {
  LONG_PRESS_THRESHOLD,
  getShakeAmplitude,
  getDecayAmplitude,
  shouldNavigate,
} from '../services/avatarInteraction.js'

// 闭眼/睁眼GIF播放时长（3帧：80+80+400=560ms），GIF设为loop=1只播放一次
const ANIM_DURATION = 560

/**
 * AIRA 动态头像（无闪烁版 + 弹跳/雨刮式抖动交互）：
 *
 * 眨眼动画（原有）：
 * - idle：正常眨眼GIF循环
 * - 鼠标悬停：播放闭眼GIF一次 → loop=1 播完自然停在末帧（>_<）
 * - 鼠标移开：播放睁眼GIF一次 → 回到 idle 眨眼循环
 *
 * 按压交互（新增）：
 * - 单击（150ms内松手）：弹跳动画（translateY，400ms）
 * - 长按（超过150ms）：雨刮式抖动（rotate，底部枢轴），幅度随时间线性增长
 *   - 长按到1500ms：跳转 GitHub（新标签页打开）
 *   - 中途松手：抖动幅度线性衰减到0（约500ms）
 *
 * 架构隔离：
 * - 眨眼动画控制三层 <img> 的 opacity（内层 div 内）
 * - 弹跳动画控制外层 div 的 translateY
 * - 抖动动画控制内层 div 的 rotate（transform-origin: bottom center）
 * - 三者作用在不同 DOM 层级、不同 CSS 属性，互不干扰
 */
function AIRAAvatar() {
  // ==================== 眨眼动画状态（原有） ====================
  // 头像阶段：idle=眨眼循环, closing=闭眼GIF播放中, opening=睁眼GIF播放中
  const [phase, setPhase] = useState('idle')
  const timerRef = useRef(null)
  const closeImgRef = useRef(null) // 闭眼GIF的img引用，用于重启播放
  const openImgRef = useRef(null)  // 睁眼GIF的img引用，用于重启播放

  // ==================== 按压交互状态（新增） ====================
  const bounceRef = useRef(null)       // 外层div引用，用于重启弹跳动画
  const shakeRef = useRef(null)        // 内层div引用，用于更新 --shake-angle CSS变量
  const pressStartRef = useRef(0)      // mousedown 时间戳
  const longPressTimerRef = useRef(null) // 150ms长按检测定时器
  const rafRef = useRef(null)          // requestAnimationFrame ID（增长/衰减循环共用）
  const shakeStateRef = useRef('idle') // 按压状态：idle | shaking | decaying | navigated
  const peakAngleRef = useRef(0)       // 松手时的抖动幅度峰值（衰减起始值）
  const decayStartRef = useRef(0)      // 衰减开始时间戳

  // 预加载所有图片，确保切换时从浏览器缓存即时读取，消除加载延迟
  useEffect(() => {
    const sources = ['/AIRA.gif', '/AIRA_close.gif', '/AIRA_open.gif', '/AIRA_close_static.png']
    sources.forEach((src) => {
      const img = new Image()
      img.src = src
    })
  }, [])

  // 清理眨眼定时器（组件卸载或阶段切换时调用）
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 重启GIF播放：先清空src再恢复，强制浏览器从头加载GIF
  const restartGif = useCallback((imgRef) => {
    const img = imgRef.current
    if (!img) return
    const url = img.dataset.src
    img.src = ''
    img.src = url
  }, [])

  // ==================== 弹跳动画（单击触发） ====================
  // 通过直接操作DOM重启CSS动画：先设none，强制reflow，再设回动画名
  // 这是重启CSS动画最可靠的方式，不依赖React重渲染
  const triggerBounce = useCallback(() => {
    const el = bounceRef.current
    if (!el) return
    el.style.animation = 'none'
    // 强制reflow，使浏览器认识到animation已被重置
    void el.offsetWidth
    el.style.animation = 'avatarBounce 400ms ease-out'
  }, [])

  // ==================== 雨刮式抖动：增长阶段 ====================
  // 150ms定时器触发后开始，RAF循环更新 --shake-angle CSS变量
  // CSS keyframes (avatarShake) 以5Hz频率在 ±angle 之间往返旋转
  const startShake = useCallback(() => {
    shakeStateRef.current = 'shaking'
    // 启动CSS抖动动画（200ms/周期 = 5Hz，ease-in-out 模拟雨刮手感）
    if (shakeRef.current) {
      shakeRef.current.style.animation = 'avatarShake 200ms ease-in-out infinite'
    }

    const growthLoop = () => {
      const holdDuration = Date.now() - pressStartRef.current

      // 达到导航时间 → 跳转GitHub
      if (shouldNavigate(holdDuration)) {
        shakeStateRef.current = 'navigated'
        if (shakeRef.current) {
          shakeRef.current.style.animation = 'none'
          shakeRef.current.style.setProperty('--shake-angle', '0deg')
        }
        // 新标签页打开GitHub（Electron中需主进程处理 shell.openExternal）
        window.open('https://github.com/AIRA-81920/AIRA-s-Diary', '_blank', 'noopener,noreferrer')
        rafRef.current = null
        return
      }

      // 计算当前抖动幅度并更新CSS变量
      const growthElapsed = holdDuration - LONG_PRESS_THRESHOLD
      const amplitude = getShakeAmplitude(growthElapsed)
      if (shakeRef.current) {
        shakeRef.current.style.setProperty('--shake-angle', `${amplitude}deg`)
      }

      rafRef.current = requestAnimationFrame(growthLoop)
    }
    rafRef.current = requestAnimationFrame(growthLoop)
  }, [])

  // ==================== 雨刮式抖动：衰减阶段 ====================
  // 松手后调用，从当前幅度线性衰减到0（约500ms）
  const startDecay = useCallback(() => {
    // 记录松手时的幅度作为衰减峰值
    const holdDuration = Date.now() - pressStartRef.current
    const growthElapsed = holdDuration - LONG_PRESS_THRESHOLD
    peakAngleRef.current = getShakeAmplitude(growthElapsed)

    shakeStateRef.current = 'decaying'
    decayStartRef.current = Date.now()

    // 取消增长阶段的RAF
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
    }

    const decayLoop = () => {
      const decayElapsed = Date.now() - decayStartRef.current
      const amplitude = getDecayAmplitude(peakAngleRef.current, decayElapsed)

      if (shakeRef.current) {
        shakeRef.current.style.setProperty('--shake-angle', `${amplitude}deg`)
      }

      // 衰减完成 → 清理状态
      if (amplitude <= 0) {
        shakeStateRef.current = 'idle'
        if (shakeRef.current) {
          shakeRef.current.style.animation = 'none'
          shakeRef.current.style.setProperty('--shake-angle', '0deg')
        }
        rafRef.current = null
        return
      }

      rafRef.current = requestAnimationFrame(decayLoop)
    }
    rafRef.current = requestAnimationFrame(decayLoop)
  }, [])

  // ==================== 按压事件处理 ====================

  // 鼠标按下：记录时间戳，启动150ms长按检测定时器
  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return // 只响应左键
    e.preventDefault() // 阻止默认行为（文本选择、图片拖拽等）

    pressStartRef.current = Date.now()
    shakeStateRef.current = 'idle'

    // 150ms后如果还没松手，进入抖动阶段
    longPressTimerRef.current = setTimeout(() => {
      startShake()
    }, LONG_PRESS_THRESHOLD)
  }, [startShake])

  // 鼠标松手（在元素上）：单击→弹跳，抖动中→衰减
  const handleMouseUp = useCallback(() => {
    // 清除长按检测定时器
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    const state = shakeStateRef.current
    if (state === 'shaking') {
      // 抖动中松手 → 开始衰减
      startDecay()
    } else if (state === 'idle') {
      // 150ms内松手 → 单击弹跳
      triggerBounce()
    }
    // 'decaying' 或 'navigated' 状态不做处理
  }, [startDecay, triggerBounce])

  // 取消按压（鼠标离开元素时调用，不触发弹跳）
  const cancelPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    if (shakeStateRef.current === 'shaking') {
      startDecay()
    }
    // 'idle' 状态：仅清除定时器，不弹跳（鼠标已离开元素）
  }, [startDecay])

  // 鼠标进入：重启闭眼GIF并播放（loop=1 播一次停住）
  const handleMouseEnter = useCallback(() => {
    clearTimer()
    restartGif(closeImgRef)
    setPhase('closing')
    // GIF的loop=1意味着"播放1遍+循环1遍=总共2遍"，560ms后第一遍播完，
    // 将src改为静态PNG定格在闭眼末帧，阻止第二遍播放（否则会"闭两次眼"）
    timerRef.current = setTimeout(() => {
      const img = closeImgRef.current
      if (img) {
        img.src = '/AIRA_close_static.png'
      }
    }, ANIM_DURATION)
  }, [clearTimer, restartGif])

  // 鼠标离开：取消按压 + 重启睁眼GIF并播放，播完回到 idle 眨眼循环
  const handleMouseLeave = useCallback(() => {
    cancelPress() // 先取消按压状态（如果在按压中）
    clearTimer()
    restartGif(openImgRef)
    setPhase('opening')
    timerRef.current = setTimeout(() => {
      setPhase('idle')
    }, ANIM_DURATION)
  }, [cancelPress, clearTimer, restartGif])

  // 组件卸载时清理所有定时器和RAF，避免内存泄漏
  useEffect(() => {
    return () => {
      clearTimer()
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [clearTimer])

  // 公共图片样式：三层绝对定位堆叠，统一尺寸和圆角
  const baseImgStyle = {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 50,
    height: 50,
    borderRadius: 15,
  }
  // 无过渡：GIF有透明像素，过渡期间两层叠加会导致"闭两次眼"，即时切换确保只有一层可见
  const fadeTransition = 'none'

  return (
    // 外层div：处理所有鼠标事件 + 承载弹跳动画（translateY）
    <div
      ref={bounceRef}
      className="relative cursor-pointer select-none"
      style={{ width: 50, height: 50, userSelect: 'none' }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
    >
      {/* 内层div：承载雨刮式抖动动画（rotate），枢轴在底部中心 */}
      <div
        ref={shakeRef}
        style={{
          width: '100%',
          height: '100%',
          position: 'relative',
          transformOrigin: 'bottom center',
        }}
      >
        {/* 底层：正常眨眼循环 GIF（loop=0 持续播放，idle 阶段可见） */}
        <img
          src="/AIRA.gif"
          alt="AIRA"
          className="object-cover shrink-0"
          style={{ ...baseImgStyle, opacity: phase === 'idle' ? 1 : 0, transition: fadeTransition, zIndex: 1 }}
          draggable={false}
        />
        {/* 中层：闭眼动画 GIF（loop=1 播一次停住，closing 阶段可见）
            data-src 保存原始 URL，用于 restartGif 重置 src 时恢复 */}
        <img
          ref={closeImgRef}
          data-src="/AIRA_close.gif"
          src="/AIRA_close.gif"
          alt=""
          aria-hidden="true"
          className="object-cover shrink-0"
          style={{ ...baseImgStyle, opacity: phase === 'closing' ? 1 : 0, transition: fadeTransition, zIndex: 2 }}
          draggable={false}
        />
        {/* 顶层：睁眼动画 GIF（loop=1 播一次停住，opening 阶段可见）
            data-src 保存原始 URL，用于 restartGif 重置 src 时恢复 */}
        <img
          ref={openImgRef}
          data-src="/AIRA_open.gif"
          src="/AIRA_open.gif"
          alt=""
          aria-hidden="true"
          className="object-cover shrink-0"
          style={{ ...baseImgStyle, opacity: phase === 'opening' ? 1 : 0, transition: fadeTransition, zIndex: 3 }}
          draggable={false}
        />
      </div>
    </div>
  )
}

/**
 * @param {object} props
 * @param {Function} props.onNewInspiration - 点击"新建灵感"按钮时的回调
 */
function Header({ onNewInspiration }) {
  // K3-f：从 store 读取 openForceGraph action
  const openForceGraph = useStore((s) => s.openForceGraph)
  const forceGraphLoading = useStore((s) => s.forceGraphLoading)
  // 待查看的桥梁数量：> 0 时在"灵感网络"按钮上显示红色 pending 徽标
  const pendingBridgeCount = useStore((s) => s.pendingBridgeCount)
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
      <div className="flex items-center justify-between px-8" style={{ height: 80 }}>
        {/* 左侧：应用名 + 副标题 */}
        <div className="flex items-center gap-4">
          {/* 应用 Logo：AIRA 动态头像（悬停闭眼 >_<，移开睁眼 0_0 后回到眨眼） */}
          <AIRAAvatar />
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
          {/* K3-f：灵感网络按钮（触发 ForceGraph 全屏覆盖层）
              外层 div 用于承载 pending 徽标：按钮自身因 .glow-btn 的 overflow:hidden
              会裁切悬出右上角的徽标，故把徽标移到不裁剪的外层容器上，悬出部分不被切掉 */}
          <div className="relative">
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
            {/* pending 徽标：有待查看的桥梁时显示红色圆点 */}
            {pendingBridgeCount > 0 && (
              <span
                className="absolute -top-1 -right-1 w-3 h-3 rounded-full"
                style={{ background: '#ef4444', boxShadow: '0 0 8px rgba(239,68,68,0.6)' }}
                title={`${pendingBridgeCount} 个待查看的桥梁`}
              />
            )}
          </div>

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
