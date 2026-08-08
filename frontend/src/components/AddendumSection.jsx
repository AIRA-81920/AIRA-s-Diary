// AddendumSection 追加思考区块（深空智识美学）
// 功能：Detail 面板中"追加思考"区块，展示追加条目时间线 + 评论 + 操作入口
// 实现方式：
//   - 从 store 读取 addenda 列表与 CRUD actions
//   - 每条追加条目用 AddendumCard 展示（文本 + 链接 + 图片 + 时间 + 操作按钮）
//   - 评论默认折叠，点击展开后可查看/新增/编辑/删除
//   - 新建/编辑追加条目用 AddendumInputModal 子组件（三段式弹窗）
//   - 监听 store.commentDraft 实现"转为评论"（对话抽屉的 AI 回答带入评论输入框）
import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Plus, Pencil, Trash2, MessageSquare, Search, Link2, Image as ImageIcon,
  X, Send, Loader2, ExternalLink, ChevronDown,
  // 任务 16 新增：图片卡片四态 UI 与文件区所需图标
  RefreshCw, Check, FileText
} from 'lucide-react'
import { formatTime } from '../services/store.js'
import useStore from '../services/store.js'
// 任务 16 新增：uploadAddendumFile 用于拖入文本文件立即上传
import { uploadAddendumImage, uploadAddendumFile } from '../services/api.js'
// 任务 16 新增：DropZone 全屏拖放浮窗组件（任务 14 已完成）
import DropZone from './DropZone.jsx'
// v11 多模态扩展：长文本折叠 + 自适应高度 textarea
import CollapsibleText from './CollapsibleText.jsx'
import AutoTextArea from './AutoTextArea.jsx'

/**
 * @param {object} props
 * @param {string} props.inspirationId - 当前灵感 ID
 */
function AddendumSection({ inspirationId }) {
  // 从 store 读取状态与 actions
  const addenda = useStore((s) => s.addenda)
  const addendaLoading = useStore((s) => s.addendaLoading)
  const loadAddenda = useStore((s) => s.loadAddenda)
  const createAddendum = useStore((s) => s.createAddendum)
  const updateAddendum = useStore((s) => s.updateAddendum)
  const deleteAddendum = useStore((s) => s.deleteAddendum)
  const createComment = useStore((s) => s.createComment)
  const updateComment = useStore((s) => s.updateComment)
  const deleteComment = useStore((s) => s.deleteComment)
  const openConversation = useStore((s) => s.openConversation)
  const commentDraft = useStore((s) => s.commentDraft)
  const clearCommentDraft = useStore((s) => s.clearCommentDraft)
  // v10：commentSourceReplyId 独立于 commentDraft，不会被 onDraftConsumed 清空
  // 用途：createComment 时透传给 store，触发 markReplyConverted 标记源对话
  const commentSourceReplyId = useStore((s) => s.commentSourceReplyId)

  // 弹窗状态：null=关闭，{mode:'create'} 或 {mode:'edit', addendum}
  const [modalState, setModalState] = useState(null)
  // 评论展开状态：记录哪些 addendum 的评论区展开了（按 id 记录）
  const [expandedComments, setExpandedComments] = useState({})

  // 初始加载追加条目列表
  useEffect(() => {
    if (inspirationId) loadAddenda(inspirationId)
  }, [inspirationId, loadAddenda])

  // 监听 commentDraft：对话抽屉"转为评论"时，展开对应评论区并预填输入框
  useEffect(() => {
    if (commentDraft) {
      setExpandedComments((prev) => ({ ...prev, [commentDraft.addendumId]: true }))
    }
  }, [commentDraft])

  // v16 异步识图：判断是否还有"识图中"的图片（status==='generating'）
  // 实现方式：遍历 addenda.images，只要存在 generating 状态的图片即视为"后台仍在识图"
  const hasGeneratingImage = addenda.some((a) =>
    (a.images || []).some((img) => img && typeof img === 'object' && img.status === 'generating')
  )

  // v16 异步识图轮询：保存后用户无需留在弹窗等待，识图在后台进行，
  // 此处一旦发现存在"识图中"图片就周期性 loadAddenda，直到全部识别完成自动停止
  // （create / edit 保存后都生效；与灵感列表 DISTILL 回填的体验保持一致）
  useEffect(() => {
    if (!inspirationId || !hasGeneratingImage) return
    const timer = setInterval(() => {
      // silent=true：后台静默刷新，避免周期性切换 addendaLoading 导致列表抽搐
      loadAddenda(inspirationId, true)
    }, 3000)
    return () => clearInterval(timer)
  }, [inspirationId, hasGeneratingImage, loadAddenda])

  /** 切换评论区展开/收起 */
  const toggleComments = (addendumId) => {
    setExpandedComments((prev) => ({ ...prev, [addendumId]: !prev[addendumId] }))
  }

  /** 打开新建弹窗 */
  const handleCreate = () => setModalState({ mode: 'create' })

  /** 打开编辑弹窗 */
  const handleEdit = (addendum) => setModalState({ mode: 'edit', addendum })

  /** 关闭弹窗 */
  const handleCloseModal = () => setModalState(null)

  /** 保存（新建或编辑） */
  const handleSave = async (data) => {
    if (modalState.mode === 'create') {
      await createAddendum(inspirationId, data)
    } else {
      await updateAddendum(modalState.addendum.id, data, inspirationId)
    }
    handleCloseModal()
  }

  /** 删除追加条目（确认逻辑在 AddendumCard 内联实现，不用浏览器弹窗） */
  const handleDelete = async (addendum) => {
    await deleteAddendum(addendum.id, inspirationId)
  }

  /** 打开对话探究抽屉 */
  const handleExplore = (addendum) => {
    openConversation(addendum.id)
  }

  return (
    <div
      className="mt-6 mb-10 animate-fade-in-up"
      style={{ animationDelay: '160ms' }}
    >
      {/* 区块标题行 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="h-px w-8 bg-veil/10" />
          <span className="text-ink/30 text-[11px] uppercase tracking-widest font-sans">
            追加思考
          </span>
          {addenda.length > 0 && (
            <span className="text-ink/25 text-[11px] font-sans">（{addenda.length} 条）</span>
          )}
        </div>
        {/* [+ 追加] 按钮 */}
        <button
          type="button"
          onClick={handleCreate}
          className="glow-btn glass-card flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ink/60 hover:text-ink/90 text-xs font-medium transition-all group"
        >
          <Plus size={13} className="transition-transform group-hover:scale-110" style={{ color: 'var(--accent-cyan)' }} />
          <span>追加</span>
        </button>
      </div>

      {/* 加载态 */}
      {addendaLoading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 size={18} className="animate-spin text-ink/30" />
        </div>
      )}

      {/* 追加条目列表（按 created_at 升序） */}
      {!addendaLoading && addenda.length > 0 && (
        <div className="space-y-3">
          {addenda.map((addendum) => (
            <AddendumCard
              key={addendum.id}
              addendum={addendum}
              inspirationId={inspirationId}
              expanded={!!expandedComments[addendum.id]}
              onToggleComments={() => toggleComments(addendum.id)}
              onEdit={() => handleEdit(addendum)}
              onDelete={() => handleDelete(addendum)}
              onExplore={() => handleExplore(addendum)}
              commentDraft={commentDraft && commentDraft.addendumId === addendum.id ? commentDraft : null}
              onCommentDraftConsumed={clearCommentDraft}
              // v10：onCreateComment 透传 commentSourceReplyId（从 store 读取，不依赖 commentDraft）
              // 此值在 setCommentDraft 时设置，在 createComment 末尾清空
              onCreateComment={(content, context) => createComment(addendum.id, content, inspirationId, context, commentSourceReplyId)}
              onUpdateComment={(commentId, content, context) => updateComment(commentId, content, inspirationId, context)}
              onDeleteComment={(commentId) => deleteComment(commentId, inspirationId)}
            />
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!addendaLoading && addenda.length === 0 && (
        <div className="text-center py-6">
          <p className="text-ink/25 text-sm font-sans">
            还没有追加思考。点击"追加"记录新的想法。
          </p>
        </div>
      )}

      {/* 新建/编辑弹窗 */}
      {modalState && (
        <AddendumInputModal
          mode={modalState.mode}
          addendum={modalState.addendum}
          // 任务 16 新增：传入 inspirationId 供编辑模式下轮询 loadAddenda 刷新图片识图状态
          inspirationId={inspirationId}
          onSave={handleSave}
          onClose={handleCloseModal}
        />
      )}
    </div>
  )
}

/**
 * AddendumCard 单条追加条目卡片
 * 功能：展示文本/链接/图片 + 时间戳 + 操作按钮行 + 评论展开区
 */
function AddendumCard({
  addendum, inspirationId, expanded, onToggleComments, onEdit, onDelete, onExplore,
  commentDraft, onCommentDraftConsumed,
  onCreateComment, onUpdateComment, onDeleteComment
}) {
  const links = addendum.links || []
  const images = addendum.images || []
  // 图片预览状态：点击缩略图时存 url，非 null 时弹出大图浮层
  const [previewImg, setPreviewImg] = useState(null)
  // 内联删除确认状态：第一次点删除进入确认态，3 秒后自动退出
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const comments = addendum.comments || []

  // 确认态 3 秒后自动退出
  useEffect(() => {
    if (!confirmingDelete) return
    const t = setTimeout(() => setConfirmingDelete(false), 3000)
    return () => clearTimeout(t)
  }, [confirmingDelete])

  return (
    <>
    <div
      className="glow-card glass-card rounded-xl p-4 transition-all"
      style={{
        background: 'rgb(var(--deep2-rgb) / 0.5)',
        border: '1px solid rgb(var(--ink) / 0.05)'
      }}
    >
      {/* 文本内容（保留换行，长文本折叠到 6 行 + 展开按钮） */}
      {addendum.content && (
        <CollapsibleText
          text={addendum.content}
          maxLines={6}
          className="text-ink/70 text-sm leading-[1.7] font-sans"
          wrapperClassName="mb-3"
        />
      )}

      {/* 链接列表 */}
      {links.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
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

      {/* 图片缩略图列表：每张图缩略图 + 其下展示识图描述/状态
          实现方式：遍历 images 对象数组，缩略图可点击预览大图；缩略图下方按 status 显示
          - generating：蓝转圈"识图中..."（后台识图进行中）
          - ready/confirmed：显示识别到的 description 全文（识图完成自动浮现）
          - failed：红色小字"识别失败" */}
      {images.length > 0 && (
        <div className="space-y-2 mb-3">
          {images.map((img, i) => {
            const filename = typeof img === 'string' ? img : img.filename
            const status = typeof img === 'string' ? 'ready' : (img.status || 'ready')
            const desc = (typeof img === 'string' ? '' : (img.description || '')).trim()
            return (
              <div
                key={i}
                className="glass-card rounded-md p-2 flex items-start gap-2.5"
                style={{
                  background: 'rgb(var(--deep2-rgb) / 0.35)',
                  border: '1px solid rgb(var(--ink) / 0.05)'
                }}
              >
                <img
                  src={`/uploads/addenda/${filename}`}
                  alt={`追加图片 ${i + 1}`}
                  onClick={() => setPreviewImg(`/uploads/addenda/${filename}`)}
                  className="w-16 h-16 object-cover rounded-md border border-line/5 cursor-pointer hover:opacity-80 transition-opacity flex-shrink-0"
                />
                <div className="flex-1 min-w-0 py-0.5">
                  {status === 'generating' ? (
                    <div className="flex items-center gap-2 text-ink/50 text-xs font-sans">
                      <Loader2 size={13} className="animate-spin" style={{ color: 'var(--accent-cyan)' }} />
                      <span>识图中...</span>
                    </div>
                  ) : status === 'failed' ? (
                    <p className="text-xs font-sans" style={{ color: 'var(--accent-amber)' }}>
                      识别失败
                    </p>
                  ) : desc ? (
                    <p className="text-ink/60 text-xs leading-[1.6] whitespace-pre-wrap font-sans">
                      {desc}
                    </p>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 时间戳 + 操作按钮行 */}
      <div className="flex items-center justify-between pt-2 border-t border-line/5">
        <span className="text-ink/25 text-[11px] font-sans">
          {formatTime(addendum.created_at)}
        </span>
        <div className="flex items-center gap-1">
          {/* 编辑 */}
          <button
            type="button"
            onClick={onEdit}
            className="glow-btn p-1.5 rounded-md text-ink/30 hover:text-ink/80 hover:bg-veil/5 transition-all"
            title="编辑"
          >
            <Pencil size={13} />
          </button>
          {/* 删除（内联二次确认，不用浏览器弹窗） */}
          <button
            type="button"
            onClick={() => {
              if (confirmingDelete) {
                onDelete()
              } else {
                setConfirmingDelete(true)
              }
            }}
            className={`glow-btn rounded-md transition-all flex items-center gap-1 ${
              confirmingDelete
                ? 'px-2 py-1 bg-red-500/20 text-red-400'
                : 'p-1.5 text-ink/30 hover:text-red-400 hover:bg-red-500/10'
            }`}
            title={confirmingDelete ? '再次点击确认删除' : '删除'}
          >
            <Trash2 size={13} />
            {confirmingDelete && <span className="text-[11px] font-medium">确认删除?</span>}
          </button>
          {/* 评论 */}
          <button
            type="button"
            onClick={onToggleComments}
            className="flex items-center gap-1 px-2 py-1 rounded-md text-ink/30 hover:text-ink/80 hover:bg-veil/5 transition-all"
            title="评论"
          >
            <MessageSquare size={13} />
            <span className="text-[11px]">{comments.length}</span>
          </button>
          {/* 探究 */}
          <button
            type="button"
            onClick={onExplore}
            className="glow-btn p-1.5 rounded-md text-ink/30 hover:text-ink/80 hover:bg-veil/5 transition-all"
            title="探究"
          >
            <Search size={13} />
          </button>
        </div>
      </div>

      {/* 评论展开区（max-height + opacity 过渡） */}
      <div
        className="overflow-hidden"
        style={{
          maxHeight: expanded ? '1000px' : '0px',
          opacity: expanded ? 1 : 0,
          transition: 'max-height 400ms cubic-bezier(0.16, 1, 0.3, 1), opacity 300ms ease'
        }}
      >
        <div className="pt-3 mt-2 border-t border-line/5 space-y-2">
          {/* 评论列表 */}
          {comments.length > 0 && (
            <div className="space-y-2">
              {comments.map((comment) => (
                <CommentItem
                  key={comment.id}
                  comment={comment}
                  onUpdate={(content) => onUpdateComment(comment.id, content)}
                  onDelete={() => onDeleteComment(comment.id)}
                />
              ))}
            </div>
          )}
          {/* 评论输入框 */}
          <CommentInput
            draft={commentDraft}
            onDraftConsumed={onCommentDraftConsumed}
            onSubmit={onCreateComment}
          />
        </div>
      </div>
    </div>
    {/* 图片预览浮层（用 Portal 渲染到 body，避免被父级 transform 影响 fixed 定位） */}
    {previewImg && createPortal(
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgb(var(--mask-rgb)_/_0.6)] backdrop-blur-md animate-fade-in-up"
        onClick={() => setPreviewImg(null)}
      >
        <img
          src={previewImg}
          alt="预览"
          onClick={(e) => e.stopPropagation()}
          className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
        />
        <button
          type="button"
          onClick={() => setPreviewImg(null)}
          className="glow-btn modal-close-btn absolute top-4 right-4 p-2 rounded-lg glass-card text-ink/60"
        >
          <X size={20} />
        </button>
      </div>,
      document.body
    )}
    </>
  )
}

/**
 * CommentItem 单条评论（支持内联编辑 + context 折叠展示）
 * 功能：
 *   - comment.content 始终可见（核心文本）
 *   - comment.context 存在时折叠展示（点击"展开"查看阐释部分）
 *   - 点击核心文本进入编辑态（仅编辑 content，context 保持不变）
 * v9：新增 context 折叠区，用于 AI 回复"转为评论"后的分层展示
 */
function CommentItem({ comment, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(comment.content || '')
  // context 折叠状态：默认折叠（false=收起，true=展开）
  const [contextExpanded, setContextExpanded] = useState(false)
  // 内联删除确认状态
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const inputRef = useRef(null)
  const hasContext = !!(comment.context && comment.context.trim())

  // 进入编辑态时聚焦
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  // 确认态 3 秒后自动退出
  useEffect(() => {
    if (!confirmingDelete) return
    const t = setTimeout(() => setConfirmingDelete(false), 3000)
    return () => clearTimeout(t)
  }, [confirmingDelete])

  /** 保存编辑（仅更新 content，context 不变） */
  const handleSave = () => {
    const trimmed = text.trim()
    if (trimmed && trimmed !== comment.content) {
      // v9：编辑时 context 传 undefined，store/api 判断后不更新该字段，保留原值
      onUpdate(trimmed, undefined)
    } else {
      setText(comment.content || '')
    }
    setEditing(false)
  }

  if (editing) {
    return (
      <div className="flex items-start gap-2">
        <AutoTextArea
          ref={inputRef}
          value={text}
          onChange={(v) => setText(v)}
          onBlur={handleSave}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSave()
            }
          }}
          minRows={2}
          maxHeight={300}
          className="input-accent flex-1 px-3 py-1.5 rounded-md text-xs text-ink/80 font-sans"
        />
      </div>
    )
  }

  return (
    <div className="group flex items-start gap-2 px-2 py-1.5 rounded-md hover:bg-veil/[0.02] transition-colors">
      <div className="flex-1 min-w-0">
        {/* 核心文本（始终可见，点击进入编辑；长文本折叠到 6 行） */}
        <div onClick={() => setEditing(true)} className="cursor-text">
          <CollapsibleText
            text={comment.content}
            maxLines={6}
            className="text-ink/60 text-xs leading-[1.6] font-sans"
          />
        </div>
        {/* v9：context 折叠区（阐释部分，点击展开/收起） */}
        {hasContext && (
          <div className="mt-1">
            <button
              type="button"
              onClick={() => setContextExpanded((v) => !v)}
              className="flex items-center gap-1 text-ink/30 hover:text-ink/60 text-[10px] font-sans transition-colors"
            >
              <ChevronDown
                size={10}
                className={`transition-transform duration-200 ${contextExpanded ? 'rotate-180' : ''}`}
              />
              <span>{contextExpanded ? '收起' : '展开阐释'}</span>
            </button>
            {/* 折叠内容（max-height + opacity 过渡，与评论区展开保持一致风格） */}
            <div
              className="overflow-hidden"
              style={{
                maxHeight: contextExpanded ? '500px' : '0px',
                opacity: contextExpanded ? 1 : 0,
                transition: 'max-height 300ms cubic-bezier(0.16, 1, 0.3, 1), opacity 200ms ease'
              }}
            >
              <p className="text-ink/40 text-xs leading-[1.6] whitespace-pre-wrap font-sans pt-1 pl-2 border-l border-line/10">
                {comment.context}
              </p>
            </div>
          </div>
        )}
        <span className="text-ink/20 text-[10px] font-sans">
          {formatTime(comment.created_at)}
        </span>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="p-1 rounded text-ink/30 hover:text-ink/70 transition-colors"
          title="编辑评论"
        >
          <Pencil size={11} />
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirmingDelete) {
              onDelete()
            } else {
              setConfirmingDelete(true)
            }
          }}
          className={`rounded transition-all flex items-center gap-0.5 ${
            confirmingDelete
              ? 'px-1.5 py-0.5 bg-red-500/20 text-red-400'
              : 'p-1 text-ink/30 hover:text-red-400'
          }`}
          title={confirmingDelete ? '再次点击确认删除' : '删除评论'}
        >
          <Trash2 size={11} />
          {confirmingDelete && <span className="text-[10px]">确认?</span>}
        </button>
      </div>
    </div>
  )
}

/**
 * CommentInput 评论输入框
 * 功能：textarea + 发送按钮，支持 commentDraft 预填
 *   v9：当 draft 携带 context（来自 AI 回复的阐释部分）时，
 *        展示可折叠的"阐释"输入区，提交时同时传递 content 与 context
 */
function CommentInput({ draft, onDraftConsumed, onSubmit }) {
  const [text, setText] = useState('')
  // v9：context 草稿状态（仅 draft 携带时启用）
  const [contextText, setContextText] = useState('')
  const [contextOpen, setContextOpen] = useState(false)
  const contextRef = useRef(null)

  // 监听 draft：有草稿时预填 content（与可选 context）到输入框
  useEffect(() => {
    if (draft && draft.content) {
      setText(draft.content)
      // v9：若草稿携带 context，预填并自动展开阐释区
      if (draft.context) {
        setContextText(draft.context)
        setContextOpen(true)
      } else {
        setContextText('')
        setContextOpen(false)
      }
      onDraftConsumed?.()
    }
  }, [draft, onDraftConsumed])

  /** 发送评论 */
  const handleSubmit = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    // v9：context 仅在非空时传递，空字符串转为 null
    const ctx = contextText.trim() || null
    onSubmit(trimmed, ctx)
    setText('')
    setContextText('')
    setContextOpen(false)
  }

  return (
    <div className="mt-2 space-y-1.5">
      {/* 主输入框（核心文本） */}
      <div className="flex items-end gap-2">
        <AutoTextArea
          value={text}
          onChange={(v) => setText(v)}
          placeholder="写下你的评论..."
          minRows={1}
          maxHeight={200}
          className="input-accent flex-1 px-3 py-1.5 rounded-md text-xs text-ink/80 placeholder-ink/25 font-sans"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              handleSubmit()
            }
          }}
        />
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!text.trim()}
          className="glow-btn glass-card p-1.5 rounded-md text-ink/40 hover:text-ink/80 disabled:opacity-30 transition-all"
          title="发送评论"
        >
          <Send size={13} />
        </button>
      </div>
      {/* v9：阐释输入区（可折叠，仅在 contextOpen 或已有 contextText 时显示） */}
      {(contextOpen || contextText) && (
        <div className="pl-2 border-l border-line/10">
          <div className="flex items-center justify-between mb-1">
            <span className="text-ink/30 text-[10px] font-sans">阐释（可选，折叠展示）</span>
            <button
              type="button"
              onClick={() => setContextOpen((v) => !v)}
              className="text-ink/30 hover:text-ink/60 text-[10px] font-sans transition-colors"
            >
              {contextOpen ? '收起' : '展开'}
            </button>
          </div>
          {contextOpen && (
            <AutoTextArea
              ref={contextRef}
              value={contextText}
              onChange={(v) => setContextText(v)}
              placeholder="补充阐释..."
              minRows={2}
              maxHeight={300}
              className="input-accent w-full px-3 py-1.5 rounded-md text-xs text-ink/60 placeholder-ink/25 font-sans"
            />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * AddendumInputModal 追加条目输入弹窗（三段式结构）
 * 功能：文本输入 + 链接添加 + 图片上传（四态状态机）+ 文件区，复用新建与编辑
 * 实现方式：参照 InspirationModal.jsx 三段式（遮罩 + 卡片 + 头部/主体/底部）
 *
 * 任务 16 改造点：
 *   - 集成 DropZone：弹窗打开时激活全屏拖放浮窗，按文件类型分流到图片/文件回调
 *   - images state 升级：从 string[]（文件名数组）改为 AddendumImage[] 对象数组
 *     [{filename, description, status}]，status ∈ generating|ready|confirmed|failed
 *   - 图片卡片四态 UI：generating（识图中）/ ready（描述可编辑 + 纳入正文）/ confirmed（已纳入）/ failed（重试识图）
 *   - 文件区：拖入 .md/.txt 立即上传 + 显示独立条目（名.格式+大小），不进 content
 *   - 单类型限制：existingType 传给 DropZone，已有图片时拒绝文本，已有文件时拒绝图片
 *   - 编辑模式轮询：loadAddenda 定时刷新，同步后端 generating → ready/failed 的状态变化
 */
function AddendumInputModal({ mode, addendum, inspirationId, onSave, onClose }) {
  // 表单状态
  const [content, setContent] = useState(addendum?.content || '')
  const [links, setLinks] = useState(addendum?.links || [])
  // images state 升级：AddendumImage[] 对象数组
  // 兼容旧数据：string[]（纯文件名）转换为 {filename, description:'', status:'ready'}
  // 后端返回的对象数组直接复用，缺省字段补默认值
  const [images, setImages] = useState(
    (addendum?.images || []).map((img) => {
      if (typeof img === 'string') {
        return { filename: img, description: '', status: 'ready' }
      }
      return {
        filename: img.filename,
        description: img.description || '',
        status: img.status || 'ready'
      }
    })
  )
  // 文件区 state：[{filename, original_name, size, url}]
  const [files, setFiles] = useState(addendum?.files || [])
  const [uploading, setUploading] = useState(false)
  const [linkInput, setLinkInput] = useState('')
  // 图片预览状态：点击缩略图时存 url，非 null 时弹出大图浮层（与 AddendumCard 一致）
  const [previewImg, setPreviewImg] = useState(null)

  // 从 store 读取 addenda 与 loadAddenda，用于编辑模式下轮询刷新图片识图状态
  const addenda = useStore((s) => s.addenda)
  const loadAddenda = useStore((s) => s.loadAddenda)

  // existingType 动态计算：images 非空 → 'image'，files 非空 → 'file'，都为空 → null
  // 传给 DropZone 实现单类型限制（已有图片时拒绝文本，已有文件时拒绝图片）
  const existingType = images.length > 0 ? 'image' : (files.length > 0 ? 'file' : null)

  // 允许仅添加图片/文件或仅添加链接：文本/链接/图片/文件任一非空即可保存
  const canSave = content.trim().length > 0 || links.length > 0 || images.length > 0 || files.length > 0

  // 编辑模式下轮询 loadAddenda，定时刷新 addendum 数据以同步图片识图状态
  // 实现方式：setInterval 每 3 秒调用 loadAddenda(inspirationId)，组件卸载时清理
  // 注意：silent=true 静默刷新，避免切换 addendaLoading 导致弹窗/列表画面抽搐
  useEffect(() => {
    if (mode !== 'edit' || !addendum?.id || !inspirationId) return
    const timer = setInterval(() => {
      loadAddenda(inspirationId, true)
    }, 3000)
    return () => clearInterval(timer)
  }, [mode, addendum?.id, inspirationId, loadAddenda])

  // 监听 addenda 变化：当后端图片状态从 generating 变为 ready/failed/confirmed 时同步本地
  // 仅更新 generating 状态的条目，保留用户对 ready/confirmed 条目的本地编辑
  useEffect(() => {
    if (mode !== 'edit' || !addendum?.id) return
    const latestAddendum = addenda.find((a) => a.id === addendum.id)
    if (!latestAddendum || !Array.isArray(latestAddendum.images)) return

    setImages((prevImages) =>
      prevImages.map((localImg) => {
        // 仅更新 generating 状态的条目（ready/confirmed/failed 保留用户编辑）
        if (localImg.status !== 'generating') return localImg
        // 按 filename 匹配后端返回的图片条目
        const serverImg = latestAddendum.images.find(
          (si) => (typeof si === 'string' ? si : si.filename) === localImg.filename
        )
        if (!serverImg) return localImg
        // 规范化后端返回的图片对象
        const serverImgObj = typeof serverImg === 'string'
          ? { filename: serverImg, description: '', status: 'ready' }
          : serverImg
        // 后端 status 变为 ready/failed/confirmed 时更新本地（同步描述）
        if (['ready', 'failed', 'confirmed'].includes(serverImgObj.status)) {
          return {
            ...localImg,
            status: serverImgObj.status,
            description: serverImgObj.description || ''
          }
        }
        return localImg
      })
    )
  }, [addenda, mode, addendum?.id])

  /** 添加链接 */
  const handleAddLink = () => {
    const trimmed = linkInput.trim()
    if (trimmed && !links.includes(trimmed)) {
      setLinks([...links, trimmed])
      setLinkInput('')
    }
  }

  /** 删除链接 */
  const handleRemoveLink = (idx) => {
    setLinks(links.filter((_, i) => i !== idx))
  }

  /**
   * DropZone onImages 回调：拖入图片立即上传 + 添加到 images state
   * 实现方式：遍历图片文件逐个上传，成功后添加 {filename, description:'', status:'generating'}
   * 多图串行上传（for...of + await），后端 taskQueue 也会串行处理 VISION 任务
   */
  const handleDropImages = async (fileList) => {
    setUploading(true)
    try {
      for (const file of fileList) {
        try {
          const result = await uploadAddendumImage(file)
          if (result.success !== false && result.data?.filename) {
            setImages((prev) => [
              ...prev,
              { filename: result.data.filename, description: '', status: 'generating' }
            ])
          }
        } catch (err) {
          console.warn('[AddendumInputModal] 拖入图片上传失败:', err.message)
        }
      }
    } finally {
      setUploading(false)
    }
  }

  /**
   * DropZone onFiles 回调：拖入文本文件立即上传 + 添加到 files state
   * 实现方式：遍历文件逐个上传，成功后添加 {filename, original_name, size, url}
   * 文件不进 content，仅作为独立条目展示
   */
  const handleDropFiles = async (fileList) => {
    for (const file of fileList) {
      try {
        const result = await uploadAddendumFile(file)
        if (result.success !== false && result.data) {
          setFiles((prev) => [...prev, result.data])
        }
      } catch (err) {
        console.warn('[AddendumInputModal] 拖入文件上传失败:', err.message)
      }
    }
  }

  /**
   * 点击选择图片上传（保留现有交互，与 DropZone 拖放并存）
   * 上传成功后存为 {filename, description:'', status:'generating'}（与拖入一致）
   */
  const handleUploadImage = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const result = await uploadAddendumImage(file)
      if (result.success !== false && result.data?.filename) {
        setImages((prev) => [
          ...prev,
          { filename: result.data.filename, description: '', status: 'generating' }
        ])
      }
    } catch (err) {
      console.warn('[AddendumInputModal] 图片上传失败:', err.message)
    } finally {
      setUploading(false)
      // 重置 input 以便重复上传同一文件
      e.target.value = ''
    }
  }

  /** 删除图片（按索引移除） */
  const handleRemoveImage = (idx) => {
    setImages(images.filter((_, i) => i !== idx))
  }

  /** 删除文件（按索引移除） */
  const handleRemoveFile = (idx) => {
    setFiles(files.filter((_, i) => i !== idx))
  }

  /**
   * 编辑图片描述（仅 ready 状态可编辑）
   * 实现方式：按索引更新 description 字段，保留其他字段不变
   */
  const handleEditImageDescription = (idx, description) => {
    setImages(images.map((img, i) => (i === idx ? { ...img, description } : img)))
  }

  /**
   * "纳入正文"按钮：描述作为一段文字插入 content textarea（追加到末尾，纯文本无标记）
   * 仅 ready 状态可点击；点击后 status 改为 'confirmed'，卡片显示"已纳入正文"标记
   */
  const handleConfirmImage = (idx) => {
    const img = images[idx]
    if (!img || img.status !== 'ready') return
    const desc = (img.description || '').trim()
    if (desc) {
      // 追加到 content 末尾：已有内容时换行拼接，空内容时直接用描述
      setContent((prev) => (prev ? `${prev}\n${desc}` : desc))
    }
    setImages(images.map((im, i) => (i === idx ? { ...im, status: 'confirmed' } : im)))
  }

  /**
   * "重试识图"按钮：仅 failed 状态显示
   * 点击后 status 改回 'generating'，保存时后端扫描 generating 条目自动入队 VISION 任务
   */
  const handleRetryImage = (idx) => {
    setImages(images.map((img, i) => (i === idx ? { ...img, status: 'generating' } : img)))
  }

  /** 保存：createAddendum/updateAddendum 携带 {content, links, images, files} */
  const handleSave = () => {
    if (!canSave) return
    onSave({ content: content.trim(), links, images, files })
  }

  /**
   * 格式化文件大小（B/KB/MB）
   * 用于文件区条目显示
   */
  const formatFileSize = (bytes) => {
    if (!bytes) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  return createPortal(
    // DropZone 包裹弹窗内容：active=true 激活全屏拖放浮窗
    // existingType 控制 DropZone 单类型限制（已有图片拒文本，已有文件拒图片）
    <DropZone
      active={true}
      existingType={existingType}
      onImages={handleDropImages}
      onFiles={handleDropFiles}
    >
      {/* 遮罩层：用 Portal 渲染到 document.body，避免父级 transform 导致 fixed 失效 */}
      {/* bg-black/40（非 /70）让 backdrop-blur 的毛玻璃效果可见 */}
      <div
        className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgb(var(--mask-rgb)_/_0.4)] backdrop-blur-md animate-fade-in-up"
        onClick={onClose}
      >
        {/* 卡片本体：毛玻璃效果（半透明 + backdrop-blur 让背景透出模糊感） */}
        <div
          className="glass-card w-full max-w-lg mx-4 rounded-2xl shadow-2xl overflow-hidden relative backdrop-blur-2xl"
          onClick={(e) => e.stopPropagation()}
          style={{
            background: 'rgb(var(--deep2-rgb) / 0.55)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgb(var(--cyan-rgb) / 0.1)'
          }}
        >
          {/* 顶部渐变光带装饰 */}
          <div
            className="absolute top-0 left-0 right-0 h-px"
            style={{
              background: 'linear-gradient(90deg, transparent, rgb(var(--cyan-rgb) / 0.5), rgb(var(--amber-rgb) / 0.3), transparent)'
            }}
          />

          {/* 头部 */}
          <div className="flex items-center justify-between px-7 py-5 border-b border-line/5">
            <div className="flex items-center gap-3">
              <Plus size={18} style={{ color: 'var(--accent-cyan)' }} />
              <h2 className="font-display text-xl font-semibold text-ink">
                {mode === 'edit' ? '编辑追加' : '追加思考'}
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="modal-close-btn p-1.5 rounded-lg text-ink/40"
            >
              <X size={18} />
            </button>
          </div>

          {/* 主体 */}
          <div className="px-7 py-6 space-y-5 max-h-[70vh] overflow-y-auto">
            {/* 文本输入 */}
            <div>
              <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
                内容
              </label>
              <AutoTextArea
                value={content}
                onChange={(v) => setContent(v)}
                autoFocus
                placeholder="记录你的追加思考...（可拖入图片/文件）"
                minRows={5}
                maxHeight={400}
                className="input-accent w-full px-4 py-2.5 rounded-xl text-sm text-ink/80 placeholder-ink/25 font-sans"
              />
            </div>

            {/* 链接添加区 */}
            <div>
              <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
                链接
              </label>
              {/* 已添加的链接列表 */}
              {links.length > 0 && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {links.map((link, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-1.5 glass-card px-2.5 py-1 rounded-md text-xs text-ink/60"
                      style={{ borderColor: 'rgb(var(--cyan-rgb) / 0.15)' }}
                    >
                      <Link2 size={11} style={{ color: 'var(--accent-cyan)' }} />
                      <span className="max-w-[180px] truncate">{link}</span>
                      <button
                        type="button"
                        onClick={() => handleRemoveLink(i)}
                        className="text-ink/30 hover:text-red-400 transition-colors"
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {/* 链接输入框 + 添加按钮 */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={linkInput}
                  onChange={(e) => setLinkInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      handleAddLink()
                    }
                  }}
                  placeholder="粘贴链接地址..."
                  className="input-accent flex-1 px-3 py-2 rounded-lg text-xs text-ink/80 placeholder-ink/25 font-sans"
                />
                <button
                  type="button"
                  onClick={handleAddLink}
                  className="glow-btn glass-card flex items-center gap-1 px-3 py-2 rounded-lg text-ink/60 hover:text-ink/90 text-xs transition-all"
                >
                  <Plus size={12} />
                  <span>添加</span>
                </button>
              </div>
            </div>

            {/* 图片区（四态状态机） */}
            {images.length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
                  图片
                </label>
                {/* 图片卡片列表：每个图片独立卡片，按 status 显示对应状态 UI */}
                <div className="space-y-2 mb-2">
                  {images.map((img, i) => (
                    <ImageCard
                      key={i}
                      image={img}
                      onRemove={() => handleRemoveImage(i)}
                      onEditDescription={(desc) => handleEditImageDescription(i, desc)}
                      onConfirm={() => handleConfirmImage(i)}
                      onRetry={() => handleRetryImage(i)}
                      onPreview={() => setPreviewImg(`/uploads/addenda/${img.filename}`)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* 文件区（独立条目，不进 content） */}
            {files.length > 0 && (
              <div>
                <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
                  文件
                </label>
                <div className="space-y-2 mb-2">
                  {files.map((file, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 glass-card px-3 py-2 rounded-md text-xs text-ink/60"
                      style={{ borderColor: 'rgb(var(--amber-rgb) / 0.15)' }}
                    >
                      <FileText size={14} style={{ color: 'var(--accent-amber)' }} />
                      <span className="truncate flex-1">{file.original_name || file.filename}</span>
                      <span className="text-ink/30 text-[10px] flex-shrink-0">
                        {formatFileSize(file.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveFile(i)}
                        className="text-ink/30 hover:text-red-400 transition-colors flex-shrink-0"
                        title="移除文件"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 上传按钮（保留点击选择图片的交互，与 DropZone 拖放并存） */}
            {images.length === 0 && files.length === 0 && (
              <label className="glow-card glass-card flex items-center gap-1.5 px-3 py-2 rounded-lg text-ink/60 hover:text-ink/90 text-xs cursor-pointer transition-all w-fit">
                {uploading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <ImageIcon size={12} style={{ color: 'var(--accent-cyan)' }} />
                )}
                <span>{uploading ? '上传中...' : '添加图片（或拖入文件）'}</span>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleUploadImage}
                  className="hidden"
                  disabled={uploading}
                />
              </label>
            )}
          </div>

          {/* 底部按钮区 */}
          <div className="flex justify-end gap-3 px-7 py-5 border-t border-line/5">
            <button
              type="button"
              onClick={onClose}
              className="glow-btn glass-card px-5 py-2.5 rounded-xl text-ink/60 hover:text-ink/80 text-sm font-medium transition-colors font-sans"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="glow-btn btn-accent px-5 py-2.5 rounded-xl text-white text-sm font-medium font-sans"
            >
              保存
            </button>
          </div>
        </div>
      </div>

      {/* 图片预览浮层：点击缩略图时弹出大图，z-index 高于弹窗（z-[110] > z-[100]） */}
      {/* 与 AddendumCard 的预览浮层保持一致风格：毛玻璃遮罩 + 点击关闭 */}
      {previewImg && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-[rgb(var(--mask-rgb)_/_0.6)] backdrop-blur-md animate-fade-in-up"
          onClick={() => setPreviewImg(null)}
        >
          <img
            src={previewImg}
            alt="预览"
            onClick={(e) => e.stopPropagation()}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl shadow-2xl"
          />
          <button
            type="button"
            onClick={() => setPreviewImg(null)}
            className="glow-btn modal-close-btn absolute top-4 right-4 p-2 rounded-lg glass-card text-ink/60"
          >
            <X size={20} />
          </button>
        </div>
      )}
    </DropZone>,
    document.body
  )
}

/**
 * ImageCard 图片卡片（四态状态机）
 * 功能：根据 image.status 显示对应状态 UI
 *   - generating（识图中）：loading 图标 + "识图中..."文字
 *   - ready（描述可编辑）：描述 textarea + "纳入正文"按钮
 *   - confirmed（已纳入正文）："已纳入正文"标记（不可再编辑）
 *   - failed（识图失败）："重试识图"按钮
 * 缩略图始终可点击预览（无论 status）
 */
function ImageCard({ image, onRemove, onEditDescription, onConfirm, onRetry, onPreview }) {
  const { filename, description, status } = image

  return (
    <div
      className="glass-card rounded-lg p-3 transition-all"
      style={{
        background: 'rgb(var(--deep2-rgb) / 0.4)',
        border: '1px solid rgb(var(--ink) / 0.05)'
      }}
    >
      <div className="flex items-start gap-3">
        {/* 缩略图：点击预览大图（所有状态均可点击） */}
        <img
          src={`/uploads/addenda/${filename}`}
          alt="追加图片"
          onClick={onPreview}
          className="w-20 h-20 object-cover rounded-md border border-line/5 cursor-pointer hover:opacity-80 transition-opacity flex-shrink-0"
        />

        <div className="flex-1 min-w-0">
          {/* generating 状态：loading 图标 + "识图中..."文字 */}
          {status === 'generating' && (
            <div className="flex items-center gap-2 text-ink/50 text-xs font-sans py-2">
              <Loader2 size={14} className="animate-spin" style={{ color: 'var(--accent-cyan)' }} />
              <span>识图中...</span>
            </div>
          )}

          {/* ready 状态：描述 textarea + "纳入正文"按钮 */}
          {status === 'ready' && (
            <div className="space-y-2">
              <AutoTextArea
                value={description}
                onChange={(v) => onEditDescription(v)}
                placeholder="图片描述（可编辑，纳入正文后插入到内容末尾）..."
                minRows={2}
                maxHeight={200}
                className="input-accent w-full px-2 py-1 rounded-md text-xs text-ink/80 placeholder-ink/25 font-sans"
              />
              <button
                type="button"
                onClick={onConfirm}
                className="glow-btn flex items-center gap-1 px-2 py-1 rounded-md text-xs text-ink/60 hover:text-ink/90 transition-all glass-card"
                style={{ borderColor: 'rgb(var(--cyan-rgb) / 0.2)' }}
                title="将描述作为一段文字插入到内容末尾"
              >
                <Check size={11} style={{ color: 'var(--accent-cyan)' }} />
                <span>纳入正文</span>
              </button>
            </div>
          )}

          {/* confirmed 状态："已纳入正文"标记（不可再编辑） */}
          {status === 'confirmed' && (
            <div className="flex items-center gap-2 text-xs font-sans py-2" style={{ color: 'var(--accent-cyan)' }}>
              <Check size={14} />
              <span>已纳入正文</span>
            </div>
          )}

          {/* failed 状态："重试识图"按钮 */}
          {status === 'failed' && (
            <button
              type="button"
              onClick={onRetry}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-all"
              style={{ color: 'var(--accent-amber)' }}
              title="重新识图（保存时后端自动入队 VISION 任务）"
            >
              <RefreshCw size={11} />
              <span>重试识图</span>
            </button>
          )}
        </div>

        {/* 移除按钮：所有状态均可移除 */}
        <button
          type="button"
          onClick={onRemove}
          className="text-ink/30 hover:text-red-400 transition-colors flex-shrink-0"
          title="移除图片"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

export default AddendumSection
