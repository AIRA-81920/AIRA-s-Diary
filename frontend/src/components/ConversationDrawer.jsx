// ConversationDrawer 对话探究抽屉（深空智识美学）
// 功能：右侧滑入的对话抽屉，复用 WorkbenchDrawer 的挤压机制
// 实现方式：
//   - mounted 双 rAF + width transition（从 0 到 drawerWidth）
//   - 拖拽调宽手柄（左边缘 8px，双击 reset）
//   - 早返回：drawer !== 'conversation' 或无选中灵感时不渲染
//   - 消息流分"已保存的回答"与"本次对话"两区
//   - 每条 AI 消息带书签按钮（保存/取消保存）
//   - 已保存消息可"转为评论"或删除
//   - 底部提问框支持 Ctrl/Cmd+Enter 发送
import React, { useState, useRef, useCallback, useEffect } from 'react'
import { X, Bookmark, BookmarkCheck, Send, Loader2, MessageSquarePlus, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import useStore from '../services/store.js'
import StreamingMarkdown from './StreamingMarkdown.jsx'

// 对话抽屉的强调色（琥珀色，与继续思考主题一致）
const CONVERSATION_ACCENT = '#f59e0b'

/**
 * ConversationDrawer 对话探究抽屉
 * 功能：与 WorkbenchDrawer 共享 drawer 状态，当 drawer === 'conversation' 时渲染
 */
function ConversationDrawer() {
  // 从 store 读取状态与 actions
  const drawer = useStore((s) => s.drawer)
  const selectedInspiration = useStore((s) => s.selectedInspiration)
  const closeDrawer = useStore((s) => s.closeDrawer)
  const drawerWidth = useStore((s) => s.drawerWidth)
  const drawerWidthDefault = useStore((s) => s.drawerWidthDefault)
  const setDrawerWidth = useStore((s) => s.setDrawerWidth)
  const conversationAddendumId = useStore((s) => s.conversationAddendumId)
  const conversationMessages = useStore((s) => s.conversationMessages)
  // v10：已转化为评论的历史对话（默认折叠在抽屉底部）
  const conversationConvertedHistory = useStore((s) => s.conversationConvertedHistory)
  const conversationLoading = useStore((s) => s.conversationLoading)
  const conversationError = useStore((s) => s.conversationError)
  const addenda = useStore((s) => s.addenda)
  const askConversation = useStore((s) => s.askConversation)
  const saveConversationReply = useStore((s) => s.saveConversationReply)
  const unsaveConversationReply = useStore((s) => s.unsaveConversationReply)
  const setCommentDraft = useStore((s) => s.setCommentDraft)

  // v10：历史区折叠状态（默认折叠，用户点击展开查看已处理历史）
  const [historyCollapsed, setHistoryCollapsed] = useState(true)

  // 拖拽状态
  const [dragging, setDragging] = useState(false)
  const [handleHover, setHandleHover] = useState(false)
  const [liveWidth, setLiveWidth] = useState(null)
  // 挂载动画状态：挂载时从 width=0 过渡到 drawerWidth
  const [mounted, setMounted] = useState(false)
  const dragInfo = useRef({ startX: 0, startWidth: 0 })

  // 提问输入框
  const [question, setQuestion] = useState('')
  // 消息流滚动容器 ref（自动滚动到底部）
  const messagesEndRef = useRef(null)

  // 挂载后下一帧设为 true，触发 width 从 0 → drawerWidth 的 transition
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setMounted(true))
    })
  }, [])

  // 消息流更新时自动滚动到底部
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [conversationMessages, conversationLoading])

  // 早返回：非 conversation 抽屉或无选中灵感时不渲染
  if (drawer !== 'conversation' || !selectedInspiration) {
    return null
  }

  // 找到当前对话的追加条目（用于摘要标题）
  const currentAddendum = addenda.find((a) => a.id === conversationAddendumId)
  const addendumSummary = currentAddendum?.content?.slice(0, 40) || '对话探究'

  /**
   * 拖拽开始：记录起始 X 与起始宽度，绑定全局 mousemove/mouseup
   */
  const handleResizeStart = useCallback(
    (e) => {
      e.preventDefault()
      e.stopPropagation()
      setDragging(true)
      dragInfo.current = { startX: e.clientX, startWidth: drawerWidth }

      const handleMouseMove = (ev) => {
        // 向左拖动 → delta 为负 → 宽度增加
        const delta = dragInfo.current.startX - ev.clientX
        const newWidth = dragInfo.current.startWidth + delta
        setLiveWidth(newWidth)
        setDrawerWidth(newWidth)
      }

      const handleMouseUp = () => {
        setDragging(false)
        setLiveWidth(null)
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    },
    [drawerWidth, setDrawerWidth]
  )

  /** 双击手柄 reset 到默认宽度 */
  const handleDoubleClick = useCallback(() => {
    setDrawerWidth(drawerWidthDefault)
  }, [drawerWidthDefault, setDrawerWidth])

  // 组件卸载时清理光标
  useEffect(() => {
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [])

  /** 发送提问 */
  const handleSend = () => {
    const trimmed = question.trim()
    if (!trimmed || conversationLoading) return
    askConversation(trimmed)
    setQuestion('')
  }

  /** 书签按钮：saved=false 时保存，saved=true 时取消保存 */
  const handleBookmark = (index) => {
    const msg = conversationMessages[index]
    if (!msg || msg.role !== 'ai') return
    if (msg.saved) {
      unsaveConversationReply(index)
    } else {
      saveConversationReply(index)
    }
  }

  /** "转为评论"：把 AI 回答内容带到 AddendumSection 的评论输入框
   *  v9：优先把 core 作为评论核心文本，context 作为折叠的阐释部分；
   *      AI 未标记 [CORE] 时，用完整显示文本作为评论核心，无折叠部分
   *  v10：传 msg.replyId 作为 sourceReplyId，store.createComment 用它调 markReplyConverted */
  const handleConvertToComment = (index) => {
    const msg = conversationMessages[index]
    if (!msg || !conversationAddendumId) return
    console.log('[ConversationDrawer] handleConvertToComment called:', { index, replyId: msg.replyId, hasCore: !!msg.core })
    // 有 core：core 作 content，context 作折叠部分；无 core：text 作 content，无折叠
    // v10：第四个参数 sourceReplyId = msg.replyId（已保存消息必带 replyId）
    if (msg.core) {
      setCommentDraft(conversationAddendumId, msg.core, msg.context, msg.replyId)
    } else {
      setCommentDraft(conversationAddendumId, msg.text || '', null, msg.replyId)
    }
  }

  // 把消息流分为"已保存的回答"与"本次对话"
  // 规则：已保存的 AI 消息连同其紧邻前一条 user 提问一起归入"已保存"区
  // 背景：saveConversationReply 只把 AI 消息标记 saved=true，user 消息保持 saved=false，
  //       所以这里需要通过"后继 AI 是否已保存"反推 user 归属
  const savedMessages = []
  const sessionMessages = []
  conversationMessages.forEach((msg, i) => {
    // 已保存的 AI 消息直接归入已保存区
    if (msg.saved && msg.role === 'ai') {
      savedMessages.push({ msg, index: i })
      return
    }
    // 当前是 user 提问，且紧随其后的 AI 消息已保存 → user 也归入已保存区
    if (
      msg.role === 'user' &&
      i + 1 < conversationMessages.length &&
      conversationMessages[i + 1].role === 'ai' &&
      conversationMessages[i + 1].saved
    ) {
      savedMessages.push({ msg, index: i })
      return
    }
    sessionMessages.push({ msg, index: i })
  })

  return (
    // 抽屉主容器：挤压式（与 Detail 并列），宽度过渡 400ms
    <div
      className={`relative flex-shrink-0 overflow-hidden ${mounted ? 'animate-fade-in' : ''} ${dragging ? 'panel-transitioning' : ''}`}
      style={{
        width: mounted ? `${drawerWidth}px` : '0px',
        transition: dragging ? 'none' : 'width 400ms cubic-bezier(0.16, 1, 0.3, 1)',
        background: dragging ? 'rgb(var(--deep-rgb) / 0.92)' : 'rgb(var(--deep-rgb) / 0.6)',
        backdropFilter: dragging ? 'none' : 'blur(20px)',
        WebkitBackdropFilter: dragging ? 'none' : 'blur(20px)',
        borderLeft: '1px solid rgb(var(--ink) / 0.05)',
        boxShadow: `-8px 0 32px rgba(0,0,0,0.4), 0 0 0 1px ${CONVERSATION_ACCENT}10`
      }}
    >
      {/* 头部：探究标题 + 关闭按钮 */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b border-line/5"
        style={{ background: `linear-gradient(180deg, ${CONVERSATION_ACCENT}08, transparent)` }}
      >
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: CONVERSATION_ACCENT, boxShadow: `0 0 8px ${CONVERSATION_ACCENT}` }}
            />
            <h3
              className="font-display text-base font-semibold text-ink/90 truncate"
              style={{ letterSpacing: '-0.01em' }}
            >
              对话探究
            </h3>
          </div>
          <p className="text-ink/35 text-[10px] mt-0.5 ml-3.5 font-sans truncate">
            {addendumSummary}
          </p>
        </div>
        <button
          type="button"
          onClick={closeDrawer}
          className="modal-close-btn p-1.5 rounded-md text-ink/30 flex-shrink-0"
          title="关闭"
        >
          <X size={14} />
        </button>
      </div>

      {/* 消息流区域（可滚动） */}
      <div
        className="absolute left-0 right-0 overflow-y-auto px-4 py-4 space-y-4"
        style={{ top: '68px', bottom: '88px' }}
      >
        {/* 错误提示 */}
        {conversationError && (
          <div className="rounded-lg p-3 text-xs text-red-300" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
            {conversationError}
          </div>
        )}

        {/* "已保存的回答" 分区 */}
        {savedMessages.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-px flex-1 bg-veil/5" />
              <span className="text-ink/30 text-[10px] uppercase tracking-widest font-sans px-2">
                已保存的回答（{savedMessages.length}）
              </span>
              <div className="h-px flex-1 bg-veil/5" />
            </div>
            {savedMessages.map(({ msg, index }) => (
              <MessageBubble
                key={`saved-${index}`}
                msg={msg}
                index={index}
                accent={CONVERSATION_ACCENT}
                onBookmark={handleBookmark}
                onConvertToComment={handleConvertToComment}
              />
            ))}
          </div>
        )}

        {/* "本次对话" 分区 */}
        {sessionMessages.length > 0 && (
          <div className="space-y-2">
            {(savedMessages.length > 0 || conversationMessages.length === 0) && (
              <div className="flex items-center gap-2 mb-2">
                <div className="h-px flex-1 bg-veil/5" />
                <span className="text-ink/30 text-[10px] uppercase tracking-widest font-sans px-2">
                  本次对话
                </span>
                <div className="h-px flex-1 bg-veil/5" />
              </div>
            )}
            {sessionMessages.map(({ msg, index }) => (
              <MessageBubble
                key={`session-${index}`}
                msg={msg}
                index={index}
                accent={CONVERSATION_ACCENT}
                onBookmark={handleBookmark}
                onConvertToComment={handleConvertToComment}
              />
            ))}
          </div>
        )}

        {/* 加载态 */}
        {conversationLoading && (
          <div className="flex items-center justify-center py-4">
            <Loader2 size={18} className="animate-spin" style={{ color: CONVERSATION_ACCENT }} />
          </div>
        )}

        {/* 空状态 */}
        {conversationMessages.length === 0 && !conversationLoading && (
          <div className="text-center py-8">
            <p className="text-ink/25 text-sm font-sans">
              向 AI 提问，探究这条追加思考的更多可能。
            </p>
          </div>
        )}

        {/* v10："已处理历史"折叠区 — 已转化为评论的对话默认折叠在此 */}
        {conversationConvertedHistory.length > 0 && (
          <div className="space-y-2 mt-4">
            {/* 折叠/展开按钮（默认折叠） */}
            <button
              type="button"
              onClick={() => setHistoryCollapsed((v) => !v)}
              className="w-full flex items-center gap-2 py-1.5 group"
            >
              <span className="text-ink/40 group-hover:text-ink/70 transition-colors flex-shrink-0">
                {historyCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </span>
              <span className="text-ink/30 text-[10px] uppercase tracking-widest font-sans">
                已处理历史（{Math.floor(conversationConvertedHistory.filter((m) => m.role === 'ai').length)} 轮）
              </span>
              <div className="h-px flex-1 bg-veil/5" />
              <span className="text-ink/20 text-[10px] font-sans group-hover:text-ink/40 transition-colors flex-shrink-0">
                {historyCollapsed ? '查看' : '收起'}
              </span>
            </button>
            {/* 折叠内容（max-height + opacity 过渡，与评论区展开保持一致风格） */}
            <div
              className="overflow-hidden"
              style={{
                maxHeight: historyCollapsed ? '0px' : '2000px',
                opacity: historyCollapsed ? 0 : 1,
                transition: 'max-height 400ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms ease'
              }}
            >
              {/* 历史消息列表（灰色、半透明，无操作按钮） */}
              <div className="space-y-2 opacity-50 pt-2">
                {conversationConvertedHistory.map((msg, index) => (
                  <MessageBubble
                    key={`history-${index}`}
                    msg={msg}
                    index={-1 - index}
                    accent={CONVERSATION_ACCENT}
                    isHistory={true}
                  />
                ))}
                <div className="h-px bg-veil/5 mt-3" />
              </div>
            </div>
          </div>
        )}

        {/* 滚动锚点 */}
        <div ref={messagesEndRef} />
      </div>

      {/* 底部提问框 */}
      <div
        className="absolute left-0 right-0 bottom-0 px-4 py-3 border-t border-line/5"
        style={{ background: 'rgb(var(--deep-rgb) / 0.8)' }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter 发送
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="提问...（Ctrl+Enter 发送）"
            rows={2}
            className="input-accent flex-1 px-3 py-2 rounded-lg text-sm text-ink/80 placeholder-ink/25 resize-none font-sans"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!question.trim() || conversationLoading}
            className="btn-accent p-2.5 rounded-lg text-white disabled:opacity-30 transition-all"
            title="发送"
          >
            <Send size={16} />
          </button>
        </div>
      </div>

      {/* 左边缘拖拽手柄 */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={handleResizeStart}
        onDoubleClick={handleDoubleClick}
        onMouseEnter={() => setHandleHover(true)}
        onMouseLeave={() => setHandleHover(false)}
        className="absolute top-0 bottom-0 left-0 z-40"
        style={{ width: '8px', cursor: 'col-resize', background: 'transparent', transition: 'background 200ms ease' }}
        title="拖拽调整宽度，双击恢复默认"
      >
        {/* 可见光带 */}
        <div
          className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2"
          style={{
            width: '2px',
            background: (handleHover || dragging)
              ? `linear-gradient(180deg, transparent, ${CONVERSATION_ACCENT}80, transparent)`
              : 'transparent',
            transition: 'background 200ms ease',
            boxShadow: dragging ? `0 0 8px ${CONVERSATION_ACCENT}80` : 'none'
          }}
        />
        {/* 拖拽时宽度浮窗 */}
        {dragging && liveWidth && (
          <div
            className="absolute top-1/2 -translate-y-1/2 z-50 px-2.5 py-1 rounded-md text-[11px] font-mono pointer-events-none whitespace-nowrap"
            style={{
              left: '16px',
              background: 'rgb(var(--deep-rgb) / 0.95)',
              color: CONVERSATION_ACCENT,
              border: `1px solid ${CONVERSATION_ACCENT}40`,
              boxShadow: `0 0 12px ${CONVERSATION_ACCENT}40, 0 4px 16px rgba(0,0,0,0.6)`
            }}
          >
            {Math.round(liveWidth)}px
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * MessageBubble 单条消息气泡
 * 功能：展示角色标签 + 文本 + 书签按钮，已保存消息额外显示"转为评论"和"删除"
 *   v10：新增 isHistory 属性 — 历史消息（已转化）隐藏所有操作按钮，只读展示
 */
function MessageBubble({ msg, index, accent, onBookmark, onConvertToComment, isHistory = false }) {
  const isUser = msg.role === 'user'
  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      {/* 角色标签 */}
      <span
        className="text-[10px] uppercase tracking-wider font-sans mb-1"
        style={{ color: isUser ? 'rgb(var(--ink) / 0.3)' : accent }}
      >
        {isUser ? '你' : 'AI'}
      </span>
      {/* 消息内容 */}
      <div
        className={`group relative max-w-[85%] rounded-xl px-3 py-2 text-sm font-sans ${isUser ? 'whitespace-pre-wrap' : ''}`}
        style={{
          background: isUser ? 'rgb(var(--ink) / 0.05)' : 'rgb(var(--amber-rgb) / 0.08)',
          border: isUser ? '1px solid rgb(var(--ink) / 0.05)' : `1px solid ${accent}20`,
          color: isUser ? 'rgb(var(--ink) / 0.7)' : 'rgb(var(--ink) / 0.85)'
        }}
      >
        {isUser ? (
          // 用户消息保持纯文本（whitespace-pre-wrap 保留换行）
          msg.text
        ) : (
          // AI 消息用流式 Markdown 渲染：streaming 标记来自 store，流式中显示光标
          <StreamingMarkdown text={msg.text} streaming={!!msg.streaming} />
        )}
        {/* AI 消息的书签 + 操作按钮（历史消息隐藏，只读展示） */}
        {!isUser && !isHistory && (
          <div className="flex items-center gap-1 mt-1.5 pt-1.5 border-t border-line/5 opacity-60 group-hover:opacity-100 transition-opacity">
            {/* 书签按钮 */}
            <button
              type="button"
              onClick={() => onBookmark(index)}
              className="p-1 rounded text-ink/40 hover:text-ink/80 transition-colors"
              title={msg.saved ? '取消保存' : '保存到回答库'}
            >
              {msg.saved ? <BookmarkCheck size={13} style={{ color: accent }} /> : <Bookmark size={13} />}
            </button>
            {/* 已保存消息的"转为评论"按钮 */}
            {msg.saved && (
              <button
                type="button"
                onClick={() => onConvertToComment(index)}
                className="p-1 rounded text-ink/40 hover:text-ink/80 transition-colors"
                title="转为评论"
              >
                <MessageSquarePlus size={13} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default ConversationDrawer
