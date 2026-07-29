// InspirationModal 灵感录入/编辑弹窗（深空智识美学）
// 功能：玻璃态居中弹窗，含标题/内容/来源类型/来源 URL 字段
// 实现方式：
//   - 遮罩 backdrop-blur + 卡片玻璃态 + 渐变边框
//   - 标题用 Cormorant Garamond，输入框聚焦 cyan 光晕
//   - 通过 inspiration prop 区分新建（null）与编辑（对象）模式
import React, { useState, useEffect } from 'react'
import { X, PenLine, FileText } from 'lucide-react'

/**
 * @param {object} props
 * @param {object|null} props.inspiration - null 表示新建，对象表示编辑
 * @param {Function} props.onSave - 保存回调，参数为表单数据对象
 * @param {Function} props.onClose - 关闭弹窗回调
 */
function InspirationModal({ inspiration, onSave, onClose }) {
  // 表单本地状态
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [sourceType, setSourceType] = useState('manual')
  const [sourceUrl, setSourceUrl] = useState('')

  // 编辑模式下初始化表单
  useEffect(() => {
    if (inspiration) {
      setTitle(inspiration.title || '')
      setContent(inspiration.content || '')
      setSourceType(inspiration.source_type || 'manual')
      setSourceUrl(inspiration.source_url || '')
    }
  }, [inspiration])

  const canSave = title.trim().length > 0

  /**
   * 处理保存：组装表单数据后调用 onSave
   */
  const handleSave = () => {
    if (!canSave) return
    onSave({
      title: title.trim(),
      content,
      source_type: sourceType,
      source_url: sourceType !== 'manual' ? sourceUrl : ''
    })
  }

  return (
    // 遮罩层：深色 + backdrop-blur，点击关闭
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--mask-rgb)_/_0.7)] backdrop-blur-md animate-fade-in-up"
      onClick={onClose}
    >
      {/* 卡片本体：玻璃态 + 渐变边框 + 阻止冒泡 */}
      <div
        className="glass-card w-full max-w-lg mx-4 rounded-2xl shadow-2xl overflow-hidden relative"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'rgb(var(--deep2-rgb) / 0.85)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgb(var(--cyan-rgb) / 0.1)'
        }}
      >
        {/* 顶部渐变光带装饰 */}
        <div
          className="absolute top-0 left-0 right-0 h-px"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgb(var(--cyan-rgb) / 0.5), rgb(var(--amber-rgb) / 0.3), transparent)'
          }}
        />

        {/* 头部：衬线标题 + 关闭按钮 */}
        <div className="flex items-center justify-between px-7 py-5 border-b border-line/5">
          <div className="flex items-center gap-3">
            {inspiration ? <PenLine size={18} className="text-accent-400" style={{ color: 'var(--accent-cyan-bright)' }} /> : <FileText size={18} className="text-gold-400" style={{ color: 'var(--sem-gold)' }} />}
            <h2 className="font-display text-xl font-semibold text-ink">
              {inspiration ? '编辑灵感' : '新建灵感'}
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

        {/* 表单主体 */}
        <div className="px-7 py-6 space-y-5">
          {/* 标题：必填 */}
          <div>
            <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
              标题 <span style={{ color: 'var(--accent-cyan)' }}>*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="给这个灵感起个名字..."
              autoFocus
              className="input-accent w-full px-4 py-2.5 rounded-xl text-sm text-ink/80 placeholder-ink/25 font-sans"
            />
          </div>

          {/* 内容：多行文本 */}
          <div>
            <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
              内容
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={6}
              placeholder="详细描述你的灵感..."
              className="input-accent w-full px-4 py-2.5 rounded-xl text-sm text-ink/80 placeholder-ink/25 resize-none font-sans"
            />
          </div>

          {/* 来源类型 */}
          <div>
            <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
              来源类型
            </label>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
              className="input-accent w-full px-4 py-2.5 rounded-xl text-sm text-ink/80 font-sans"
            >
              <option value="manual">手动录入</option>
              <option value="web">网页</option>
              <option value="file">文件</option>
            </select>
          </div>

          {/* 来源 URL：仅当来源类型非 manual 时显示 */}
          {sourceType !== 'manual' && (
            <div>
              <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
                来源 URL
              </label>
              <input
                type="text"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder={sourceType === 'web' ? 'https://example.com/...' : '文件路径或标识'}
                className="input-accent w-full px-4 py-2.5 rounded-xl text-sm text-ink/80 placeholder-ink/25 font-sans"
              />
            </div>
          )}
        </div>

        {/* 底部按钮区 */}
        <div className="flex justify-end gap-3 px-7 py-5 border-t border-line/5">
          <button
            type="button"
            onClick={onClose}
            className="glass-card px-5 py-2.5 rounded-xl text-ink/60 hover:text-ink/80 text-sm font-medium transition-colors font-sans"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="btn-accent px-5 py-2.5 rounded-xl text-white text-sm font-medium font-sans"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  )
}

export default InspirationModal
