// ContinueThinkingPanel 继续思考面板（深空智识美学）
// 功能：全屏列表视图，展示所有灵感的已保存对话卡片
// 实现方式：
//   - 全屏遮罩 + 面板容器
//   - 按 inspiration_id + addendum_id 分组（同一灵感的同一追加合并为一张卡片）
//   - 每张卡片展示灵感标题 + 搁置时间 + 追加摘要 + 统计
//   - 单击卡片展开 ContinueThinkingDetailCard 浮层
//   - 空状态与加载状态处理
import React, { useState, useEffect, useMemo } from 'react'
import { X, Loader2, Bookmark, MessageSquare, ArrowRight } from 'lucide-react'
import useStore from '../services/store.js'
import ContinueThinkingDetailCard from './ContinueThinkingDetailCard.jsx'

/**
 * 相对时间格式化
 * 功能：把 ISO 时间转成"刚刚/N分钟前/N小时前/N天前"
 * @param {string} value - ISO 时间字符串
 * @returns {string}
 */
function relativeTime(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  return `${day}天前`
}

/**
 * 把 savedRepliesList 按 inspiration_id + addendum_id 分组
 * 功能：同一灵感的同一追加条目的所有已保存回答合并为一张卡片
 * @param {Array} replies - savedRepliesList
 * @returns {Array} 分组后的卡片数据
 */
function groupReplies(replies) {
  const map = new Map()
  for (const r of replies) {
    const key = `${r.inspiration_id}_${r.addendum_id}`
    if (!map.has(key)) {
      map.set(key, {
        inspiration_id: r.inspiration_id,
        addendum_id: r.addendum_id,
        inspiration_title: r.inspiration_title || r.inspirationTitle || '未命名灵感',
        addendum_content: r.addendum_content || r.addendumContent || '',
        addendum_links: r.addendum_links || r.addendumLinks || [],
        addendum_images: r.addendum_images || r.addendumImages || [],
        replies: [],
        saved_at: r.saved_at || r.savedAt || r.created_at || r.createdAt,
        comment_count: r.comment_count || r.commentCount || 0
      })
    }
    const group = map.get(key)
    group.replies.push({
      id: r.id || r.reply_id,
      question: r.question,
      answer: r.answer,
      // v9：透传 core/context，供详情卡片预览时优先用 core（更精炼）
      core: r.core || null,
      context: r.context || null,
      saved_at: r.saved_at || r.savedAt || r.created_at || r.createdAt
    })
    // 更新搁置时间为最新的
    const replyTime = r.saved_at || r.savedAt || r.created_at || r.createdAt
    if (replyTime && (!group.saved_at || new Date(replyTime) > new Date(group.saved_at))) {
      group.saved_at = replyTime
    }
  }
  // 按 saved_at 降序排列（最新搁置的在前）
  return Array.from(map.values()).sort((a, b) => {
    const ta = a.saved_at ? new Date(a.saved_at).getTime() : 0
    const tb = b.saved_at ? new Date(b.saved_at).getTime() : 0
    return tb - ta
  })
}

/**
 * ContinueThinkingPanel 继续思考面板
 */
function ContinueThinkingPanel() {
  const savedRepliesList = useStore((s) => s.savedRepliesList)
  const savedRepliesLoading = useStore((s) => s.savedRepliesLoading)
  const loadSavedReplies = useStore((s) => s.loadSavedReplies)
  const closeContinueThinking = useStore((s) => s.closeContinueThinking)

  // 当前展开的卡片（null=无展开）
  const [selectedItem, setSelectedItem] = useState(null)

  // 初始加载
  useEffect(() => {
    loadSavedReplies()
  }, [loadSavedReplies])

  // 分组后的卡片数据
  const groupedItems = useMemo(() => groupReplies(savedRepliesList), [savedRepliesList])

  return (
    // 全屏遮罩
    <div
      className="fixed inset-0 z-40 bg-[rgb(var(--mask-rgb)_/_0.8)] backdrop-blur-md animate-fade-in-up"
      onClick={closeContinueThinking}
    >
      {/* 面板容器 */}
      <div
        className="max-w-3xl mx-auto mt-20 px-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <Bookmark size={20} style={{ color: 'var(--accent-amber)' }} />
            <h2 className="font-display text-2xl font-semibold text-ink" style={{ letterSpacing: '-0.02em' }}>
              继续思考
            </h2>
            {groupedItems.length > 0 && (
              <span className="text-ink/30 text-sm font-sans">（{groupedItems.length}）</span>
            )}
          </div>
          <button
            type="button"
            onClick={closeContinueThinking}
            className="modal-close-btn p-2 rounded-lg text-ink/40"
          >
            <X size={20} />
          </button>
        </div>

        {/* 加载态 */}
        {savedRepliesLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-ink/30" />
          </div>
        )}

        {/* 卡片列表 */}
        {!savedRepliesLoading && groupedItems.length > 0 && (
          <div className="space-y-3 max-h-[70vh] overflow-y-auto pb-8">
            {groupedItems.map((item) => (
              <button
                key={`${item.inspiration_id}_${item.addendum_id}`}
                type="button"
                onClick={() => setSelectedItem(item)}
                className="glow-btn glass-card w-full text-left rounded-2xl p-5 transition-all hover:bg-veil/[0.04] group"
                data-glow="amber"
                style={{ border: '1px solid rgb(var(--ink) / 0.06)' }}
              >
                {/* 灵感标题 + 搁置时间 */}
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h3 className="font-display text-lg font-semibold text-ink/90 line-clamp-1">
                    {item.inspiration_title}
                  </h3>
                  <span className="text-ink/25 text-xs font-sans whitespace-nowrap flex-shrink-0">
                    {relativeTime(item.saved_at)}
                  </span>
                </div>
                {/* 追加条目摘要（1-2行截断） */}
                {item.addendum_content && (
                  <p className="text-ink/50 text-sm leading-[1.6] font-sans line-clamp-2 mb-3">
                    {item.addendum_content}
                  </p>
                )}
                {/* 统计 */}
                <div className="flex items-center gap-4 text-xs text-ink/40 font-sans">
                  <span className="flex items-center gap-1.5">
                    <Bookmark size={12} style={{ color: 'var(--accent-amber)' }} />
                    <span>已保存 {item.replies.length} 条对话</span>
                  </span>
                  {item.comment_count > 0 && (
                    <span className="flex items-center gap-1.5">
                      <MessageSquare size={12} />
                      <span>{item.comment_count} 条评论</span>
                    </span>
                  )}
                </div>
                {/* 悬停时的展开提示 */}
                <div className="flex items-center gap-1 mt-3 text-ink/0 group-hover:text-ink/40 transition-colors text-xs font-sans">
                  <span>查看详情</span>
                  <ArrowRight size={12} />
                </div>
              </button>
            ))}
          </div>
        )}

        {/* 空状态 */}
        {!savedRepliesLoading && groupedItems.length === 0 && (
          <div className="text-center py-16">
            <Bookmark size={32} className="mx-auto text-ink/15 mb-3" />
            <p className="text-ink/25 text-sm font-sans">
              还没有搁置的思考
            </p>
            <p className="text-ink/15 text-xs font-sans mt-1">
              在对话探究中保存 AI 回答后，会在这里显示
            </p>
          </div>
        )}
      </div>

      {/* 卡片展开浮层 */}
      {selectedItem && (
        <ContinueThinkingDetailCard
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  )
}

export default ContinueThinkingPanel
