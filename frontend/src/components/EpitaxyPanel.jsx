// EpitaxyPanel 外延探究面板（深空智识美学）
// 功能：三阶段状态机（proposing → excavating → distilled），基于结晶体生成方向提案 → 深挖笔记 → 选词提炼
// 实现方式：
//   - 从 Zustand store 读取 epitaxy* 状态与 actions
//   - proposing：加载态，自动调用 startEpitaxyPropose
//   - proposing_done：展示方向卡片列表，用户点击某卡片进入深挖
//   - excavating：加载态
//   - excavating_done：展示研究笔记片段，词块可点击高亮，底部固定提炼区
//   - distilled：展示已保留词块，点击"完成提炼"关闭抽屉，词块沉淀到 Detail 档案
//
// K3-g：fragment_type 映射全部由 fragmentMeta.js 单一来源驱动（架构 §10.5 R9）
// K3-g：移除"转新灵感"出口——繁殖交给 Coalesce 桥梁→转新灵感，Epitaxy 专注深挖+提炼
import React, { useEffect } from 'react'
import {
  Sparkles,
  Loader2,
  Check,
  CheckCircle2,
  ArrowLeft,
  AlertCircle,
  BookOpen,
  Plus,
  Lightbulb
} from 'lucide-react'
import useStore from '../services/store.js'
import {
  KIND_COLORS,
  KIND_LABELS,
  getFragmentLabel,
  getFragmentKind,
  getFragmentColor
} from '../services/fragmentMeta.js'
// fix3：引入语义化等待动画（proposing 用 RootsSpreadAnim，excavating 用 ExcavateAnim）
import { RootsSpreadAnim, ExcavateAnim } from './LoadingAnims.jsx'

/**
 * EpitaxyPanel 主组件
 * @param {object} props
 * @param {object} props.inspiration - 当前选中灵感
 * @param {Function} props.onCollapse - 收起面板回调
 */
function EpitaxyPanel({ inspiration, onCollapse }) {
  // 从 store 读取 Epitaxy 状态与 actions
  const stage = useStore((s) => s.epitaxyStage)
  const proposals = useStore((s) => s.epitaxyProposals)                 // 未浏览
  const viewedProposals = useStore((s) => s.epitaxyViewedProposals)     // 已浏览（灰色归档区）
  const selectedProposal = useStore((s) => s.epitaxySelectedProposal)
  const fragments = useStore((s) => s.epitaxyFragments)
  const selectedChunks = useStore((s) => s.epitaxySelectedChunks)
  const distilledChunks = useStore((s) => s.epitaxyDistilledChunks)
  const loading = useStore((s) => s.epitaxyLoading)
  const error = useStore((s) => s.epitaxyError)

  const startEpitaxyPropose = useStore((s) => s.startEpitaxyPropose)
  const excavateProposal = useStore((s) => s.excavateProposal)
  const backToProposals = useStore((s) => s.backToProposals)
  const toggleChunk = useStore((s) => s.toggleChunk)
  const distillChunks = useStore((s) => s.distillChunks)
  // K3-g：distilled 阶段改为"完成提炼"关闭抽屉，不再调 chunkToInspiration
  const closeDrawer = useStore((s) => s.closeDrawer)

  // 进入面板时自动触发 propose（仅 empty 阶段）
  useEffect(() => {
    if (inspiration && stage === 'empty') {
      startEpitaxyPropose(inspiration)
    }
  }, [inspiration, stage, startEpitaxyPropose])

  // 顶部标题栏
  const renderHeader = (subtitle) => (
    <div className="flex items-center justify-between px-4 py-3 border-b border-line/5">
      <div className="flex items-center gap-2">
        <Sparkles size={14} style={{ color: '#3b82f6' }} />
        <span className="font-display text-sm font-semibold text-ink/85 tracking-wide">Epitaxy</span>
        {subtitle && <span className="text-ink/30 text-[10px] font-sans">/ {subtitle}</span>}
      </div>
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          className="p-1 rounded-md text-ink/30 hover:text-ink/70 hover:bg-veil/5 transition-colors"
          title="收起面板"
        >
          <ArrowLeft size={14} />
        </button>
      )}
    </div>
  )

  // proposing / excavating：加载态
  // fix3：用语义化动画替换 Loader2——proposing 用 RootsSpreadAnim（根须蔓延象征分叉探索），
  //       excavating 用 ExcavateAnim（挖掘层级象征逐层深挖）
  if (stage === 'proposing' || stage === 'excavating' || loading) {
    const isExcavating = stage === 'excavating'
    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        {renderHeader(isExcavating ? '深挖中' : '生成方向')}
        {isExcavating ? <ExcavateAnim /> : <RootsSpreadAnim />}
      </aside>
    )
  }

  // proposing_done：方向卡片列表（分"未浏览"和"已浏览"两区）
  // M3 补丁：已浏览的 proposal 灰色显示在底部归档区，点击复用已保存的 fragments
  if (stage === 'proposing_done') {
    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        {renderHeader('方向提案')}
        <div className="flex-1 px-4 py-4 overflow-y-auto">
          {/* 未浏览区 */}
          {proposals.length > 0 ? (
            <>
              <p className="text-ink/50 text-xs mb-3 font-sans animate-fade-in-up">
                基于你的结晶，我提议 {proposals.length} 个方向：
              </p>
              <div className="space-y-2">
                {proposals.map((p, idx) => (
                  <button
                    key={p.id || idx}
                    type="button"
                    onClick={() => excavateProposal(inspiration, p)}
                    disabled={loading}
                    className="w-full text-left px-3 py-3 rounded-xl border transition-all hover:scale-[1.01] disabled:opacity-40 animate-fade-in-up glass-card font-sans"
                    style={{
                      borderColor: 'rgba(59,130,246,0.15)',
                      background: 'rgba(59,130,246,0.05)',
                      animationDelay: `${idx * 50}ms`
                    }}
                  >
                    <div className="flex items-start gap-2.5">
                      {/* 序号圆圈 */}
                      <div
                        className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold"
                        style={{ background: 'rgba(59,130,246,0.2)', color: 'var(--sem-blue)' }}
                      >
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-ink/90 text-sm font-medium mb-1">{p.direction}</p>
                        <p className="text-ink/40 text-[11px] leading-relaxed mb-1.5">{p.reasoning}</p>
                        {p.expected_yield && (
                          <p className="text-ink/30 text-[10px] flex items-center gap-1">
                            <Lightbulb size={9} />
                            <span>预期收获：{p.expected_yield}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              {/* K4-b 改进点 4：卡片用完时显示"再探索"入口 */}
              <p className="text-ink/30 text-xs text-center py-4 font-sans">
                {viewedProposals.length > 0 ? '所有方向都已浏览，可在下方查看历史' : '暂无方向提案'}
              </p>
              <button
                type="button"
                onClick={() => startEpitaxyPropose(inspiration)}
                disabled={loading}
                className="w-full text-left px-4 py-3 rounded-xl border transition-all hover:scale-[1.01] disabled:opacity-40 animate-fade-in-up glass-card font-sans"
                style={{
                  borderColor: 'rgba(168,85,247,0.25)',
                  background: 'rgba(168,85,247,0.06)'
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ background: 'rgba(168,85,247,0.2)', color: 'var(--sem-purple)' }}
                  >
                    <Plus size={14} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-ink/85 text-sm font-medium">再探索一些方向</p>
                    <p className="text-ink/35 text-[11px] mt-0.5 leading-relaxed">
                      基于 crystal 换个角度延伸
                    </p>
                  </div>
                </div>
              </button>
            </>
          )}

          {/* 已浏览归档区 */}
          {viewedProposals.length > 0 && (
            <div className="mt-6 pt-4 border-t border-line/5">
              <p className="text-ink/30 text-[10px] uppercase tracking-wider mb-2 font-sans flex items-center gap-1">
                <BookOpen size={10} />
                <span>已浏览（{viewedProposals.length}）</span>
              </p>
              <div className="space-y-1.5">
                {viewedProposals.map((p, idx) => {
                  const isDistilled = p.status === 'distilled'
                  return (
                    <button
                      key={p.id || `v-${idx}`}
                      type="button"
                      onClick={() => excavateProposal(inspiration, p)}
                      disabled={loading}
                      className="w-full text-left px-3 py-2 rounded-lg border transition-all hover:scale-[1.01] disabled:opacity-40 animate-fade-in-up font-sans opacity-60 hover:opacity-90"
                      style={{
                        borderColor: 'rgb(var(--ink) / 0.06)',
                        background: 'rgb(var(--ink) / 0.02)',
                        animationDelay: `${idx * 30}ms`
                      }}
                    >
                      <div className="flex items-center gap-2">
                        {/* 已浏览标记：灰色圆点 */}
                        <div
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{
                            background: isDistilled ? '#10b981' : 'rgb(var(--ink) / 0.3)'
                          }}
                          title={isDistilled ? '已提炼' : '已深挖'}
                        />
                        <p className="text-ink/55 text-xs flex-1 truncate">{p.direction}</p>
                        {/* 状态标签 */}
                        <span
                          className="text-[9px] px-1.5 py-0.5 rounded flex-shrink-0"
                          style={{
                            background: isDistilled ? 'rgba(16,185,129,0.1)' : 'rgb(var(--ink) / 0.05)',
                            color: isDistilled ? '#10b981' : 'rgb(var(--ink) / 0.4)'
                          }}
                        >
                          {isDistilled ? '已提炼' : '已深挖'}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {error && (
            <div className="mt-3 flex items-start gap-2 text-rose-300 text-xs">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>
      </aside>
    )
  }

  // excavating_done：研究笔记 + 句子（整段）选择
  // M3 调整：选择单位从"词块"改为"整段 fragment"，词块仅作视觉高亮
  if (stage === 'excavating_done') {
    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        {renderHeader(selectedProposal?.direction || '深挖')}
        {/* 返回按钮 */}
        <div className="px-4 pt-2">
          <button
            type="button"
            onClick={backToProposals}
            className="flex items-center gap-1 text-ink/40 hover:text-ink/70 text-[11px] transition-colors font-sans"
          >
            <ArrowLeft size={11} />
            <span>返回方向列表</span>
          </button>
        </div>

        {/* 操作提示 */}
        <div className="px-4 pt-2">
          <p className="text-ink/35 text-[10px] font-sans">点击卡片选中整段笔记，可多选</p>
        </div>

        {/* 片段列表（可滚动）：每张卡片即一个可选句子/段落 */}
        <div className="flex-1 px-4 py-3 overflow-y-auto">
          {fragments.map((frag, fIdx) => {
            const isSelected = selectedChunks.some((c) => c.id === frag.id)
            // K3-g：从 fragmentMeta.js 取 kind/color/label（单一来源驱动）
            const fragKind = getFragmentKind(frag.type)
            const fragColor = getFragmentColor(frag.type)
            const typeLabel = getFragmentLabel(frag.type)
            return (
              <div
                key={frag.id || fIdx}
                onClick={() => toggleChunk(frag.id, frag)}
                className="mb-3 animate-fade-in-up cursor-pointer transition-all rounded-xl p-3 border"
                style={{
                  borderColor: isSelected ? fragColor : 'rgb(var(--ink) / 0.08)',
                  background: isSelected ? `${fragColor}10` : 'transparent',
                  boxShadow: isSelected ? `0 0 12px ${fragColor}25` : 'none',
                  animationDelay: `${fIdx * 50}ms`
                }}
              >
                {/* 片段标题行 */}
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span
                    className="px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider"
                    style={{ background: `${fragColor}20`, color: fragColor }}
                  >
                    {typeLabel}
                  </span>
                  <span className="text-ink/60 text-xs font-medium font-sans truncate">{frag.title}</span>
                  {isSelected && (
                    <Check size={14} style={{ color: fragColor }} className="ml-auto flex-shrink-0" />
                  )}
                </div>
                {/* 片段正文：词块仅作视觉高亮，不可单独点击 */}
                <ChunkText fullText={frag.full_text} chunks={frag.chunks} />
              </div>
            )
          })}
          {fragments.length === 0 && (
            <p className="text-ink/30 text-xs text-center py-8 font-sans">暂无深挖结果</p>
          )}
        </div>

        {/* 底部提炼区：固定，半透明背景 */}
        {selectedChunks.length > 0 && (
          <div
            className="px-4 py-3 border-t border-line/5"
            style={{ background: 'rgb(var(--deep-rgb) / 0.8)', backdropFilter: 'blur(8px)' }}
          >
            <p className="text-ink/40 text-[10px] mb-2 uppercase tracking-wider font-sans">
              我的提炼（{selectedChunks.length} 段笔记）
            </p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {selectedChunks.map((c) => (
                <span
                  key={c.id}
                  className="px-2 py-0.5 rounded-md text-[10px] cursor-pointer font-sans flex items-center gap-1 max-w-[220px] truncate"
                  style={{
                    background: `${KIND_COLORS[c.kind] || '#6b7280'}15`,
                    color: KIND_COLORS[c.kind] || '#9ca3af',
                    border: `1px solid ${KIND_COLORS[c.kind] || '#6b7280'}30`
                  }}
                  onClick={() => toggleChunk(c.id, c.originalFrag)}
                  title={c.title || (c.text || '').slice(0, 50)}
                >
                  {c.title || (c.text || '').slice(0, 16) + '…'}
                  <span className="text-ink/30">×</span>
                </span>
              ))}
            </div>
            <button
              type="button"
              onClick={() => distillChunks(inspiration.id)}
              disabled={loading}
              className="btn-accent w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-white text-xs font-medium font-sans"
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
              <span>完成保留</span>
            </button>
          </div>
        )}
      </aside>
    )
  }

  // distilled：提炼完成
  if (stage === 'distilled') {
    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        {renderHeader('提炼完成')}
        <div className="flex-1 px-4 py-4 overflow-y-auto">
          {/* 成功提示 */}
          <div
            className="glass-card rounded-xl px-4 py-3 mb-4 animate-fade-in-up flex items-center gap-2"
            style={{ borderColor: 'rgba(16,185,129,0.2)' }}
          >
            <CheckCircle2 size={16} style={{ color: '#10b981' }} />
            <p className="text-ink/80 text-sm font-sans">已保留 {distilledChunks.length} 段笔记</p>
          </div>

          {/* 词块列表 */}
          <div className="space-y-2 mb-4">
            {distilledChunks.map((c, idx) => {
              const fragColor = KIND_COLORS[c.kind] || '#6b7280'
              // K3-g：c.subkind 是 LLM 自由生成的细分标签（如"爵士钢琴家"），非 fragment_type；
              //       标签直接用 KIND_LABELS[c.kind]（如"引用"/"技法"），c.subkind 在副标题展示
              const typeLabel = KIND_LABELS[c.kind] || c.kind
              return (
                <div
                  key={c.id || idx}
                  className="px-3 py-2 rounded-lg animate-fade-in-up font-sans"
                  style={{
                    background: `${fragColor}08`,
                    border: `1px solid ${fragColor}20`,
                    animationDelay: `${idx * 40}ms`
                  }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="px-1.5 py-0.5 rounded text-[9px] font-medium"
                      style={{ background: `${fragColor}20`, color: fragColor }}
                    >
                      {typeLabel}
                    </span>
                    {c.title && <span className="text-ink/70 text-[11px] font-medium">{c.title}</span>}
                  </div>
                  <p className="text-ink/65 text-xs leading-relaxed">{c.chunk_text || c.text}</p>
                </div>
              )
            })}
          </div>

          {error && (
            <div className="mb-3 flex items-start gap-2 text-rose-300 text-xs">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>

        {/* 底部操作栏（K3-g 改造：移除"转新灵感"，词块沉淀到 Detail 档案） */}
        <div className="flex gap-2 px-4 py-3 border-t border-line/5">
          <button
            type="button"
            onClick={backToProposals}
            className="glass-card flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-ink/55 hover:text-ink/85 text-xs transition-colors font-sans"
          >
            <BookOpen size={12} />
            <span>查看其他方向</span>
          </button>
          <button
            type="button"
            onClick={() => closeDrawer()}
            disabled={loading}
            className="btn-accent flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-white text-xs font-medium font-sans"
            title="关闭抽屉，词块已沉淀到档案"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            <span>完成提炼</span>
          </button>
        </div>
      </aside>
    )
  }

  // 兜底：空状态（理论上不会到达，useEffect 会触发 propose）
  return (
    <aside className="flex flex-col h-full w-full border-r border-line/5">
      {renderHeader()}
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-ink/30" />
      </div>
    </aside>
  )
}

/**
 * ChunkText — 含词块高亮的文本渲染组件（纯展示，不可单独点击）
 * 功能：将 full_text 中的词块标记为彩色高亮，作为视觉引导
 * 实现方式：遍历 chunks，用词块 text 在 full_text 中定位并分割
 * 注：M3 调整后选择单位是整个 fragment（卡片），词块仅用于视觉提示哪些是引用/技法/概念
 */
function ChunkText({ fullText, chunks }) {
  if (!fullText) return null
  if (!chunks || chunks.length === 0) {
    return <p className="text-ink/60 text-xs leading-relaxed font-sans">{fullText}</p>
  }

  // 按 chunks 在 fullText 中的出现位置排序，避免分割错乱
  const sortedChunks = [...chunks].sort((a, b) => {
    const posA = fullText.indexOf(a.text)
    const posB = fullText.indexOf(b.text)
    return posA - posB
  })

  // 逐段分割 fullText
  const parts = []
  let currentPos = 0
  for (const chunk of sortedChunks) {
    const chunkPos = fullText.indexOf(chunk.text, currentPos)
    if (chunkPos === -1) continue  // 词块未在文本中找到，跳过
    // 前面的普通文本
    if (chunkPos > currentPos) {
      parts.push({ type: 'text', content: fullText.slice(currentPos, chunkPos) })
    }
    // 词块
    parts.push({ type: 'chunk', content: chunk })
    currentPos = chunkPos + chunk.text.length
  }
  // 末尾普通文本
  if (currentPos < fullText.length) {
    parts.push({ type: 'text', content: fullText.slice(currentPos) })
  }

  return (
    <p className="text-ink/60 text-xs leading-relaxed font-sans">
      {parts.map((part, idx) => {
        if (part.type === 'text') {
          return <span key={idx}>{part.content}</span>
        }
        // 词块：仅视觉高亮，不可单独点击（选择单位是整张卡片）
        const chunk = part.content
        const color = KIND_COLORS[chunk.kind] || '#6b7280'
        return (
          <span
            key={idx}
            className="rounded px-0.5"
            style={{
              color: 'rgb(var(--ink) / 0.85)',
              borderBottom: `1px dashed ${color}80`,
              background: `${color}08`
            }}
            title={`${KIND_LABELS[chunk.kind] || chunk.kind}${chunk.subkind ? ' · ' + chunk.subkind : ''}`}
          >
            {chunk.text}
          </span>
        )
      })}
    </p>
  )
}

export default EpitaxyPanel
