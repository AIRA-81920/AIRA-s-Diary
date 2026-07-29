// StageBadge 阶段状态徽章组件（K3-d 新建）
// 功能：显示单个阶段（crystallize/epitaxy/coalesce）的状态徽章
// 实现方式：根据 state 字段映射到颜色与图标，支持脉动动画（in_progress 态）
//
// 架构文档 §9.2 BadgeState 契约：
//   crystallize: 'none' | 'in_progress' | 'done'
//   epitaxy:    'none' | 'has_notes' | 'distilled'  (+ fragmentCount, chunkCount)
//   coalesce:   'unscanned' | 'has_bridges' | 'curated'  (+ bridgeCount, confirmedCount)
//
// 视觉规范：
//   - none / unscanned：灰色（rgb(var(--ink) / 0.2)），无图标
//   - in_progress / has_notes / has_bridges：青色脉动（#22d3ee），Loader2 图标旋转
//   - done / distilled / curated：绿色（#10b981），Check 图标
import React from 'react'
import { Loader2, Check, Circle, FileText, Lightbulb, Link2 } from 'lucide-react'

/**
 * 状态 → 视觉配置映射
 * 功能：把各阶段的状态枚举统一映射到 { color, icon, pulse, label }
 * 实现方式：查表，避免在 JSX 中堆砌三元表达式
 */
const STATE_VISUAL = {
  // Crystallize
  none: { color: 'rgb(var(--ink) / 0.25)', soft: 'transparent', icon: Circle, pulse: false, label: '未开始' },
  in_progress: { color: 'var(--accent-cyan-bright)', soft: 'rgb(var(--cyan-bright-rgb) / 0.25)', icon: Loader2, pulse: true, label: '进行中' },
  // Epitaxy
  has_notes: { color: 'var(--accent-cyan-bright)', soft: 'rgb(var(--cyan-bright-rgb) / 0.25)', icon: FileText, pulse: false, label: '有笔记' },
  // Coalesce
  unscanned: { color: 'rgb(var(--ink) / 0.25)', soft: 'transparent', icon: Circle, pulse: false, label: '未扫描' },
  has_bridges: { color: 'var(--accent-cyan-bright)', soft: 'rgb(var(--cyan-bright-rgb) / 0.25)', icon: Link2, pulse: false, label: '有桥梁' },
  // 共用完成态
  done: { color: '#10b981', soft: 'rgba(16,185,129,0.25)', icon: Check, pulse: false, label: '已完成' },
  distilled: { color: '#10b981', soft: 'rgba(16,185,129,0.25)', icon: Check, pulse: false, label: '已提炼' },
  curated: { color: '#10b981', soft: 'rgba(16,185,129,0.25)', icon: Check, pulse: false, label: '已策展' }
}

/**
 * 阶段图标映射（用于左侧阶段标识）
 */
const STAGE_ICON = {
  crystallize: Lightbulb,
  epitaxy: FileText,
  coalesce: Link2
}

/**
 * @param {object} props
 * @param {'crystallize'|'epitaxy'|'coalesce'} props.stage - 阶段名
 * @param {string} props.state - 状态枚举（STATE_VISUAL 的 key）
 * @param {object} [props.meta] - 附加计数 { fragmentCount, chunkCount, bridgeCount, confirmedCount }
 * @param {boolean} [props.expanded] - 是否展开（影响背景色）
 * @param {Function} [props.onClick] - 点击回调（K3-d 修复后由 StageAccordion header 统一处理，保留兼容）
 */
function StageBadge({ stage, state, meta = {}, expanded = false, onClick }) {
  const visual = STATE_VISUAL[state] || STATE_VISUAL.none
  const StageIcon = STAGE_ICON[stage] || Circle
  const StateIcon = visual.icon

  // 附加计数文本（仅展示有意义的状态）
  let countText = ''
  if (stage === 'epitaxy' && meta.chunkCount > 0) {
    countText = `${meta.chunkCount} 词块`
  } else if (stage === 'epitaxy' && meta.fragmentCount > 0) {
    countText = `${meta.fragmentCount} 片段`
  } else if (stage === 'coalesce' && meta.bridgeCount > 0) {
    countText = `${meta.bridgeCount} 桥梁`
  }

  // K3-d 修复：原为 <button>，但 StageAccordion header 已是可点击行；
  // 改为 <div> 避免嵌套 button（HTML 规范禁止），并保留 onClick 兼容旧调用
  return (
    <div
      onClick={onClick}
      className="flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all group"
      style={{
        background: expanded ? 'rgb(var(--ink) / 0.06)' : 'rgb(var(--ink) / 0.02)',
        border: expanded ? `1px solid ${visual.soft}` : '1px solid rgb(var(--ink) / 0.05)'
      }}
    >
      {/* 阶段图标（左侧固定标识） */}
      <StageIcon
        size={14}
        style={{ color: 'rgb(var(--ink) / 0.4)' }}
        className="transition-transform group-hover:scale-110"
      />

      {/* 阶段名 */}
      <span
        className="text-xs font-sans"
        style={{ color: 'rgb(var(--ink) / 0.6)', letterSpacing: '0.02em' }}
      >
        {stage === 'crystallize' ? '结晶' : stage === 'epitaxy' ? '外延' : '聚合'}
      </span>

      {/* 状态图标 + 标签 */}
      <div className="flex items-center gap-1.5">
        <StateIcon
          size={12}
          style={{
            color: visual.color,
            animation: visual.pulse ? 'spin 2s linear infinite, pulse-soft 2s ease-in-out infinite' : 'none'
          }}
        />
        <span
          className="text-[10px] font-sans"
          style={{ color: visual.color }}
        >
          {visual.label}
        </span>
      </div>

      {/* 计数文本 */}
      {countText && (
        <span
          className="text-[10px] font-sans px-1.5 py-0.5 rounded-md"
          style={{
            color: 'rgb(var(--ink) / 0.5)',
            background: 'rgb(var(--ink) / 0.04)'
          }}
        >
          {countText}
        </span>
      )}
    </div>
  )
}

export default StageBadge
