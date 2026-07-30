// ContinueThinkingDetailCard 继续思考详情卡片（深空智识美学）
// 功能：卡片展开后的毛玻璃浮层，展示完整上下文 + Enter 跳转按钮
// 实现方式：
//   - 毛玻璃浮层（fixed inset-0 z-50）
//   - 卡片展示：灵感标题 + 追加条目完整内容 + 链接/图片 + 已保存对话列表 + 评论数
//   - Enter 按钮：关闭面板 → 选中灵感 → 加载追加条目 → 打开对话抽屉
import React, { useState } from 'react'
import { X, Link2, Bookmark, MessageSquare, ArrowRight, ExternalLink, ChevronDown } from 'lucide-react'
import useStore from '../services/store.js'

/**
 * 从可能含 [CORE] 标签的原文派生显示文本（v9）
 * 功能：移除 [CORE]/[/CORE] 标签，保留标签内文本作为正常内容显示
 * @param {string} rawText - 可能含标签的原文
 * @returns {string} 移除标签后的显示文本
 */
function stripCoreTags(rawText) {
  if (!rawText) return ''
  return rawText.replace(/\[CORE\]/g, '').replace(/\[\/CORE\]/g, '')
}

/**
 * @param {object} props
 * @param {object} props.item - 分组后的数据，含 inspiration_id, addendum_id, inspiration_title,
 *   addendum_content, addendum_links, addendum_images, replies[], comment_count
 * @param {Function} props.onClose - 关闭浮层回调
 */
function ContinueThinkingDetailCard({ item, onClose }) {
  // 从 store 读取 actions
  const setSelectedInspiration = useStore((s) => s.setSelectedInspiration)
  const openConversation = useStore((s) => s.openConversation)
  const closeContinueThinking = useStore((s) => s.closeContinueThinking)
  const loadAddenda = useStore((s) => s.loadAddenda)
  const inspirations = useStore((s) => s.inspirations)

  const links = item.addendum_links || []
  const images = item.addendum_images || []
  const replies = item.replies || []
  const commentCount = item.comment_count || 0

  /**
   * Enter 跳转按钮逻辑
   * 功能：关闭继续思考面板 → 选中灵感 → 等待 Detail 加载后加载追加条目并打开对话抽屉
   * 实现方式：
   *   1. closeContinueThinking() 关闭面板
   *   2. 从 inspirations 列表查找灵感并 setSelectedInspiration
   *   3. 用 setTimeout 等待 Detail 渲染，先 loadAddenda 再 openConversation
   */
  const handleEnter = () => {
    closeContinueThinking()
    const target = inspirations.find((i) => i.id === item.inspiration_id)
    if (target) {
      setSelectedInspiration(target)
    }
    // 延迟等待 Detail 渲染 + addenda 加载后再打开对话抽屉
    setTimeout(async () => {
      await loadAddenda(item.inspiration_id)
      openConversation(item.addendum_id)
    }, 600)
  }

  return (
    // 毛玻璃浮层
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--mask-rgb)_/_0.6)] backdrop-blur-lg animate-fade-in-up p-4"
      onClick={onClose}
    >
      {/* 卡片本体 */}
      <div
        className="glass-card w-full max-w-2xl rounded-2xl max-h-[80vh] overflow-y-auto relative"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'rgb(var(--deep2-rgb) / 0.9)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgb(var(--amber-rgb) / 0.1)'
        }}
      >
        {/* 顶部渐变光带 */}
        <div
          className="absolute top-0 left-0 right-0 h-px"
          style={{
            background: 'linear-gradient(90deg, transparent, rgb(var(--amber-rgb) / 0.5), rgb(var(--cyan-rgb) / 0.3), transparent)'
          }}
        />

        {/* 头部：灵感标题 + 关闭按钮 */}
        <div className="flex items-center justify-between px-7 py-5 border-b border-line/5 sticky top-0 z-10"
          style={{ background: 'rgb(var(--deep2-rgb) / 0.95)', backdropFilter: 'blur(8px)' }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <Bookmark size={18} style={{ color: 'var(--accent-amber)' }} className="flex-shrink-0" />
            <h2 className="font-display text-xl font-semibold text-ink truncate">
              {item.inspiration_title}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="modal-close-btn p-1.5 rounded-lg text-ink/40 flex-shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* 主体内容 */}
        <div className="px-7 py-6 space-y-5">
          {/* 追加条目完整内容 */}
          {item.addendum_content && (
            <div>
              <span className="text-[11px] font-medium text-ink/40 uppercase tracking-wider font-sans mb-2 block">
                追加条目
              </span>
              <p className="text-ink/70 text-sm leading-[1.75] whitespace-pre-wrap font-sans">
                {item.addendum_content}
              </p>
            </div>
          )}

          {/* 链接 */}
          {links.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {links.map((link, i) => (
                <a
                  key={i}
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="glass-card flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-ink/60 hover:text-ink/90 transition-all"
                  style={{ borderColor: 'rgb(var(--cyan-rgb) / 0.15)' }}
                >
                  <Link2 size={11} style={{ color: 'var(--accent-cyan)' }} />
                  <span className="max-w-[200px] truncate">{link}</span>
                  <ExternalLink size={10} className="text-ink/30" />
                </a>
              ))}
            </div>
          )}

          {/* 图片 */}
          {images.length > 0 && (
            <div className="grid grid-cols-4 gap-2">
              {images.map((img, i) => (
                <img
                  key={i}
                  src={`/uploads/addenda/${typeof img === 'string' ? img : img.filename}`}
                  alt={`图片 ${i + 1}`}
                  className="w-full h-20 object-cover rounded-md border border-line/5"
                />
              ))}
            </div>
          )}

          {/* 分隔线 */}
          <div className="h-px bg-veil/5" />

          {/* 已保存的对话列表 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Bookmark size={14} style={{ color: 'var(--accent-amber)' }} />
              <span className="text-ink/50 text-sm font-medium font-sans">
                已保存的对话（{replies.length} 条）
              </span>
            </div>
            <div className="space-y-3">
              {replies.map((reply, i) => (
                <ReplyPreview key={reply.id || i} reply={reply} />
              ))}
            </div>
          </div>

          {/* 分隔线 */}
          {commentCount > 0 && <div className="h-px bg-veil/5" />}

          {/* 评论数 */}
          {commentCount > 0 && (
            <div className="flex items-center gap-2">
              <MessageSquare size={14} className="text-ink/40" />
              <span className="text-ink/50 text-sm font-sans">
                已有评论（{commentCount} 条）
              </span>
            </div>
          )}
        </div>

        {/* 底部：Enter 跳转按钮 */}
        <div className="flex justify-end px-7 py-5 border-t border-line/5 sticky bottom-0"
          style={{ background: 'rgb(var(--deep2-rgb) / 0.95)', backdropFilter: 'blur(8px)' }}
        >
          <button
            type="button"
            onClick={handleEnter}
            className="btn-accent flex items-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-medium font-sans"
          >
            <span>Enter</span>
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}

export default ContinueThinkingDetailCard

/**
 * ReplyPreview 单条已保存回答的预览卡片（v9 新增）
 * 功能：
 *   - 优先用 reply.core 作为核心预览（更精炼，直接回应用户提问）
 *   - reply.core 缺失时降级为 reply.answer（移除 [CORE] 标签后的全文）
 *   - 当 reply.context 存在时，提供"展开阐释"折叠查看完整内容
 * 实现方式：
 *   - 有 core：显示 core（高亮），context 折叠展示
 *   - 无 core：显示 answer（移除标签），无折叠区
 *   - 旧数据（v9 前）core/context 均为 null，自动降级为 answer 显示
 */
function ReplyPreview({ reply }) {
  // context 折叠状态：默认收起
  const [expanded, setExpanded] = useState(false)
  // 从 answer（含 [CORE] 标签原文）派生显示文本
  const displayAnswer = stripCoreTags(reply.answer)
  // core 优先作为预览；无 core 时用 displayAnswer 兜底
  const previewText = reply.core || displayAnswer
  // 仅当 core 存在且 context 非空时显示折叠区
  const hasContext = !!(reply.core && reply.context && reply.context.trim())

  return (
    <div
      className="rounded-lg p-3"
      style={{ background: 'rgb(var(--amber-rgb) / 0.05)', border: '1px solid rgb(var(--amber-rgb) / 0.1)' }}
    >
      {/* 提问 */}
      {reply.question && (
        <p className="text-ink/50 text-xs leading-[1.6] font-sans mb-2">
          <span className="text-ink/30">Q: </span>
          {reply.question}
        </p>
      )}
      {/* 核心预览（截断到 2 行） */}
      <p className="text-ink/70 text-sm leading-[1.6] font-sans line-clamp-2">
        <span style={{ color: 'var(--accent-amber)' }}>A: </span>
        {previewText}
      </p>
      {/* v9：阐释折叠区（仅 core 存在且有 context 时显示） */}
      {hasContext && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-ink/30 hover:text-ink/60 text-[11px] font-sans transition-colors"
          >
            <ChevronDown
              size={11}
              className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            />
            <span>{expanded ? '收起阐释' : '展开阐释'}</span>
          </button>
          <div
            className="overflow-hidden"
            style={{
              maxHeight: expanded ? '400px' : '0px',
              opacity: expanded ? 1 : 0,
              transition: 'max-height 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease'
            }}
          >
            <p className="text-ink/50 text-xs leading-[1.6] font-sans pt-1.5 pl-2 border-l border-line/10 whitespace-pre-wrap">
              {reply.context}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
