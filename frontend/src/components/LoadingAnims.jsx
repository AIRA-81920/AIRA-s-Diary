// LoadingAnims 等待动画组件集（fix3）
// 功能：6 个语义化 SVG 动画，替换通用 Loader2 旋转圈
// 实现方式：纯 SVG + CSS keyframes（定义在 index.css），无 JS 状态
//
// 设计原则：
//   - 每个动画都对应一个具体场景的"心智模型"，让用户从视觉上理解"AI 在做什么"
//   - 配色遵循深空智识美学（青/紫/蓝/橙/绿），与各阶段强调色一致
//   - 动画 8-14s 循环，避免太快导致焦躁，也避免太慢显得卡住
//   - 文案两行：主标题（动作）+ 副标题（解释 AI 在做什么）
import React from 'react'

/**
 * 共用容器：玻璃态卡片 + 标题 + 副标题
 * 功能：统一动画外层包装，让 6 个动画共用同一布局
 * 实现方式：纯展示组件，children 是动画 SVG
 */
function AnimShell({ color, title, subtitle, children }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
      {/* 动画主体 */}
      <div className="relative inline-block mb-5">
        {/* 光晕背景：颜色按场景区分 */}
        <div
          className="absolute inset-0 rounded-full blur-xl"
          style={{ background: `${color}25`, animation: 'pulseSoft 2.4s ease-in-out infinite' }}
        />
        {/* SVG 动画画布（96x96） */}
        <div
          className="relative w-20 h-20 rounded-2xl flex items-center justify-center glass-card"
          style={{ borderColor: `${color}40` }}
        >
          {children}
        </div>
      </div>
      <h3 className="font-display text-lg font-semibold text-ink/85 mb-2 animate-fade-in-up">
        {title}
      </h3>
      <p
        className="text-ink/40 text-xs leading-relaxed max-w-[240px] animate-fade-in-up font-sans"
        style={{ animationDelay: '60ms' }}
      >
        {subtitle}
      </p>
    </div>
  )
}

/**
 * 1. CrystalSensingAnim - 结晶感知类型中
 * 场景：用户点击"开始结晶"后，AI 判断灵感属于哪种类型
 * 心智模型：扫描波从中心扩散，像声呐探测
 * 实现：3 个同心圆从内向外扩散+淡出，循环 2.4s
 */
export function CrystalSensingAnim() {
  return (
    <AnimShell
      color="#a855f7"
      title="正在感知灵感类型..."
      subtitle="AI 正在分析你的灵感，判断它属于哪种类型"
    >
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        {/* 中心固定点 */}
        <circle cx="24" cy="24" r="3" fill="#a855f7" />
        {/* 3 层扩散圆环（依次延迟） */}
        <circle cx="24" cy="24" r="6" stroke="#a855f7" strokeWidth="1.5" fill="none" style={{ animation: 'senseWave 2.4s ease-out infinite', transformOrigin: 'center' }} />
        <circle cx="24" cy="24" r="6" stroke="#a855f7" strokeWidth="1.5" fill="none" opacity="0.6" style={{ animation: 'senseWave 2.4s ease-out infinite 0.8s', transformOrigin: 'center' }} />
        <circle cx="24" cy="24" r="6" stroke="#a855f7" strokeWidth="1.5" fill="none" opacity="0.3" style={{ animation: 'senseWave 2.4s ease-out infinite 1.6s', transformOrigin: 'center' }} />
      </svg>
    </AnimShell>
  )
}

/**
 * 2. CrystalQuestioningAnim - 结晶生成问题中
 * 场景：类型确定后，AI 生成定制化追问问题
 * 心智模型：问号符号闪烁 + 文字线条逐行出现，像在草拟问卷
 * 实现：3 个问号依次浮现+淡出，下方 3 行文字线条逐行绘制
 */
export function CrystalQuestioningAnim() {
  return (
    <AnimShell
      color="#06b6d4"
      title="正在生成追问问题..."
      subtitle="基于灵感类型，AI 在定制化追问维度"
    >
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        {/* 3 个问号依次闪烁（错峰 0.6s） */}
        <text x="10" y="20" fontSize="14" fill="#06b6d4" style={{ animation: 'blinkFade 1.8s ease-in-out infinite', transformOrigin: '10px 16px' }}>?</text>
        <text x="20" y="32" fontSize="18" fill="#06b6d4" style={{ animation: 'blinkFade 1.8s ease-in-out infinite 0.6s', transformOrigin: '20px 26px' }}>?</text>
        <text x="32" y="18" fontSize="12" fill="#06b6d4" style={{ animation: 'blinkFade 1.8s ease-in-out infinite 1.2s', transformOrigin: '32px 14px' }}>?</text>
        {/* 底部文字线条（3 条，依次绘制） */}
        <line x1="6" y1="40" x2="42" y2="40" stroke="#06b6d4" strokeWidth="1" opacity="0.4" style={{ animation: 'drawLine 1.8s ease-in-out infinite', transformOrigin: 'left center' }} />
        <line x1="10" y1="44" x2="38" y2="44" stroke="#06b6d4" strokeWidth="1" opacity="0.25" style={{ animation: 'drawLine 1.8s ease-in-out infinite 0.6s', transformOrigin: 'left center' }} />
      </svg>
    </AnimShell>
  )
}

/**
 * 3. CrystalGeneratingAnim - 结晶生成结晶体中
 * 场景：问题答完后，AI 生成结构化结晶体
 * 心智模型：晶体多边形逐步成形，像晶簇在生长
 * 实现：6 边形轮廓+内部辐射线，逐段绘制
 */
export function CrystalGeneratingAnim() {
  return (
    <AnimShell
      color="#f59e0b"
      title="正在生成结晶体..."
      subtitle="把你的回答组装成结构化字段"
    >
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        {/* 6 边形轮廓（描边动画） */}
        <polygon
          points="24,6 40,15 40,33 24,42 8,33 8,15"
          stroke="#f59e0b"
          strokeWidth="1.5"
          fill="none"
          style={{ animation: 'drawPolygon 2.4s ease-in-out infinite', transformOrigin: 'center' }}
        />
        {/* 内部辐射线：从中心向 6 个顶点 */}
        <line x1="24" y1="24" x2="24" y2="6" stroke="#f59e0b" strokeWidth="1" opacity="0.5" style={{ animation: 'radiateLine 2.4s ease-in-out infinite' }} />
        <line x1="24" y1="24" x2="40" y2="15" stroke="#f59e0b" strokeWidth="1" opacity="0.5" style={{ animation: 'radiateLine 2.4s ease-in-out infinite 0.4s' }} />
        <line x1="24" y1="24" x2="40" y2="33" stroke="#f59e0b" strokeWidth="1" opacity="0.5" style={{ animation: 'radiateLine 2.4s ease-in-out infinite 0.8s' }} />
        <line x1="24" y1="24" x2="24" y2="42" stroke="#f59e0b" strokeWidth="1" opacity="0.5" style={{ animation: 'radiateLine 2.4s ease-in-out infinite 1.2s' }} />
        <line x1="24" y1="24" x2="8" y2="33" stroke="#f59e0b" strokeWidth="1" opacity="0.5" style={{ animation: 'radiateLine 2.4s ease-in-out infinite 1.6s' }} />
        <line x1="24" y1="24" x2="8" y2="15" stroke="#f59e0b" strokeWidth="1" opacity="0.5" style={{ animation: 'radiateLine 2.4s ease-in-out infinite 2.0s' }} />
        {/* 中心点 */}
        <circle cx="24" cy="24" r="2" fill="#f59e0b" />
      </svg>
    </AnimShell>
  )
}

/**
 * 4. RootsSpreadAnim - 外延生成方向卡片中
 * 场景：进入外延台后，AI 基于结晶体生成 3-5 个方向提案
 * 心智模型：根须从中心向下/外蔓延，象征"分叉探索"
 * 实现：1 个主根 + 4 条分叉根，逐段生长
 */
export function RootsSpreadAnim() {
  return (
    <AnimShell
      color="#3b82f6"
      title="正在生成探究方向..."
      subtitle="AI 基于你的结晶寻找延伸方向"
    >
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        {/* 中心种子 */}
        <circle cx="24" cy="10" r="3" fill="#3b82f6" />
        {/* 主根（向下生长） */}
        <path
          d="M 24 13 Q 24 24 24 38"
          stroke="#3b82f6"
          strokeWidth="1.5"
          fill="none"
          style={{ animation: 'growRoot 2.4s ease-in-out infinite' }}
        />
        {/* 4 条分叉根（依次生长） */}
        <path d="M 24 20 Q 18 24 12 30" stroke="#3b82f6" strokeWidth="1" fill="none" opacity="0.7" style={{ animation: 'growRoot 2.4s ease-in-out infinite 0.6s' }} />
        <path d="M 24 22 Q 30 26 36 32" stroke="#3b82f6" strokeWidth="1" fill="none" opacity="0.7" style={{ animation: 'growRoot 2.4s ease-in-out infinite 0.9s' }} />
        <path d="M 24 30 Q 20 34 16 40" stroke="#3b82f6" strokeWidth="1" fill="none" opacity="0.5" style={{ animation: 'growRoot 2.4s ease-in-out infinite 1.2s' }} />
        <path d="M 24 32 Q 28 36 32 42" stroke="#3b82f6" strokeWidth="1" fill="none" opacity="0.5" style={{ animation: 'growRoot 2.4s ease-in-out infinite 1.5s' }} />
      </svg>
    </AnimShell>
  )
}

/**
 * 5. ExcavateAnim - 外延深挖研究中
 * 场景：用户点击方向卡片后，AI 深挖这个方向
 * 心智模型：向下挖掘的层级，像考古地层
 * 实现：3 层向下平移+渐显，象征"逐层深入"
 */
export function ExcavateAnim() {
  return (
    <AnimShell
      color="#3b82f6"
      title="正在深挖这个方向..."
      subtitle="AI 搜索已有案例、概念和陷阱"
    >
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        {/* 顶部地面线 */}
        <line x1="6" y1="10" x2="42" y2="10" stroke="#3b82f6" strokeWidth="1" opacity="0.4" />
        {/* 3 层挖掘条纹（从上到下依次出现） */}
        <rect x="10" y="14" width="28" height="6" stroke="#3b82f6" strokeWidth="1" fill="none" opacity="0.6" style={{ animation: 'excavateLayer 2.4s ease-in-out infinite' }} />
        <rect x="10" y="22" width="28" height="6" stroke="#3b82f6" strokeWidth="1" fill="none" opacity="0.5" style={{ animation: 'excavateLayer 2.4s ease-in-out infinite 0.8s' }} />
        <rect x="10" y="30" width="28" height="6" stroke="#3b82f6" strokeWidth="1" fill="none" opacity="0.4" style={{ animation: 'excavateLayer 2.4s ease-in-out infinite 1.6s' }} />
        {/* 挖掘工具：小箭头向下 */}
        <path d="M 24 6 L 24 8 M 22 7 L 24 9 L 26 7" stroke="#3b82f6" strokeWidth="1.5" fill="none" style={{ animation: 'digArrow 2.4s ease-in-out infinite', transformOrigin: '24px 8px' }} />
      </svg>
    </AnimShell>
  )
}

/**
 * 6. NodeLinkAnim - 聚合扫描中
 * 场景：用户点击"扫描桥梁"，AI 在所有灵感间寻找连接
 * 心智模型：节点之间连线逐渐形成，象征"发现隐藏联系"
 * 实现：4 个节点 + 连线逐条出现
 */
export function NodeLinkAnim() {
  return (
    <AnimShell
      color="#22d3ee"
      title="正在扫描桥梁..."
      subtitle="AI 在所有灵感间寻找语义连接"
    >
      <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
        {/* 4 个节点 */}
        <circle cx="10" cy="12" r="2.5" fill="#22d3ee" style={{ animation: 'nodePulse 2.4s ease-in-out infinite' }} />
        <circle cx="38" cy="14" r="2.5" fill="#22d3ee" style={{ animation: 'nodePulse 2.4s ease-in-out infinite 0.6s' }} />
        <circle cx="14" cy="36" r="2.5" fill="#22d3ee" style={{ animation: 'nodePulse 2.4s ease-in-out infinite 1.2s' }} />
        <circle cx="36" cy="34" r="2.5" fill="#22d3ee" style={{ animation: 'nodePulse 2.4s ease-in-out infinite 1.8s' }} />
        {/* 连线（逐条出现） */}
        <line x1="10" y1="12" x2="38" y2="14" stroke="#22d3ee" strokeWidth="1" opacity="0.4" style={{ animation: 'linkDraw 2.4s ease-in-out infinite' }} />
        <line x1="10" y1="12" x2="14" y2="36" stroke="#22d3ee" strokeWidth="1" opacity="0.4" style={{ animation: 'linkDraw 2.4s ease-in-out infinite 0.6s' }} />
        <line x1="38" y1="14" x2="36" y2="34" stroke="#22d3ee" strokeWidth="1" opacity="0.4" style={{ animation: 'linkDraw 2.4s ease-in-out infinite 1.2s' }} />
        <line x1="14" y1="36" x2="36" y2="34" stroke="#22d3ee" strokeWidth="1" opacity="0.4" style={{ animation: 'linkDraw 2.4s ease-in-out infinite 1.8s' }} />
        {/* 对角连线（最后出现） */}
        <line x1="10" y1="12" x2="36" y2="34" stroke="#22d3ee" strokeWidth="0.8" opacity="0.2" style={{ animation: 'linkDraw 2.4s ease-in-out infinite 2.0s' }} />
      </svg>
    </AnimShell>
  )
}

export default {
  CrystalSensingAnim,
  CrystalQuestioningAnim,
  CrystalGeneratingAnim,
  RootsSpreadAnim,
  ExcavateAnim,
  NodeLinkAnim
}
