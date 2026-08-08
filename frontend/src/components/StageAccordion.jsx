// StageAccordion 阶段手风琴容器（K3-d 新建）
// 功能：互斥展开/收起单个阶段的内容区，遵循 §10.4 DetailSlice 契约
// 实现方式：
//   - 顶部 StageBadge 作为可点击的展开/收起手柄
//   - 内容区用 max-height + opacity 过渡（400ms cubic-bezier）实现展开动画
//   - 同一时刻仅一个 stage 展开（由 store.expandedStage 控制，互斥）
//   - 收起时内容不卸载（保留 DOM 便于中间态恢复），仅视觉隐藏
//
// 架构文档 §5.4 UI 层次模型 + §10.4 DetailSlice：
//   expandedStage: 'none' | 'crystal' | 'epitaxy' | 'bridges'（手风琴互斥）
//   切换灵感时 expandedStage → 重置（store.setSelectedInspiration 已处理）
import React from 'react'
import StageBadge from './StageBadge.jsx'
import { ChevronDown } from 'lucide-react'

/**
 * @param {object} props
 * @param {string} props.stage - 阶段标识 'crystal' | 'epitaxy' | 'bridges'
 * @param {string} props.badgeStage - 徽章阶段名 'crystallize' | 'epitaxy' | 'coalesce'
 * @param {string} props.state - 徽章状态枚举
 * @param {object} [props.meta] - 徽章附加计数
 * @param {boolean} props.expanded - 当前是否展开
 * @param {Function} props.onToggle - 切换展开/收起的回调
 * @param {React.ReactNode} props.children - 展开时显示的内容
 */
function StageAccordion({ stage, badgeStage, state, meta = {}, expanded, onToggle, children }) {
  return (
    <div
      className="rounded-xl overflow-hidden transition-all"
      style={{
        background: expanded ? 'rgb(var(--ink) / 0.03)' : 'rgb(var(--ink) / 0.01)',
        border: expanded ? '1px solid rgb(var(--ink) / 0.08)' : '1px solid rgb(var(--ink) / 0.04)',
        transition: 'all 400ms cubic-bezier(0.16, 1, 0.3, 1)'
      }}
    >
      {/*
        头部：整行可点击展开/收起（含 StageBadge + ChevronDown）
        修复：原实现仅 StageBadge 是 button 可点，ChevronDown 与行内空白皆无效
              把 onClick 提到 header div，并阻止 StageBadge 内部 onClick 二次冒泡
      */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          // 键盘可达性：Enter / Space 触发切换
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle?.()
          }
        }}
        className="glow-card flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-veil/[0.02] transition-colors select-none rounded-xl"
      >
        {/* StageBadge 仅作展示，onClick 留空避免与 header 重复触发 */}
        <StageBadge
          stage={badgeStage}
          state={state}
          meta={meta}
          expanded={expanded}
        />
        {/* 展开方向箭头：展开时向上，收起时向下 */}
        <ChevronDown
          size={14}
          className="text-ink/30 transition-transform pointer-events-none"
          style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 400ms cubic-bezier(0.16, 1, 0.3, 1)'
          }}
        />
      </div>

      {/* 内容区：max-height + opacity 过渡（400ms cubic-bezier） */}
      <div
        className="overflow-hidden"
        style={{
          maxHeight: expanded ? '2000px' : '0px',
          opacity: expanded ? 1 : 0,
          transition: 'max-height 400ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms ease'
        }}
      >
        {/* 内边距分隔内容与头部 */}
        <div className="px-4 pb-4 pt-1">
          {children}
        </div>
      </div>
    </div>
  )
}

export default StageAccordion
