// InspirationModal 灵感录入/编辑弹窗（深空智识美学）
// 功能：玻璃态居中弹窗，含标题/内容字段 + 文件拖放区（新建模式）
// 实现方式：
//   - 遮罩 backdrop-blur + 卡片玻璃态 + 渐变边框
//   - 标题用 Cormorant Garamond，输入框聚焦 cyan 光晕
//   - 通过 inspiration prop 区分新建（null）与编辑（对象）模式
//
// v12 按需提炼改造：
//   - 删除"来源类型"select 与"来源 URL"输入框（Agent 暂不具备网页爬取能力）
//   - DropZone 在新建模式下始终激活（拖入即上传），无需手动选择"文件"来源
//   - 标题/内容输入框始终可编辑；AI 提炼按字段精细化：
//       * 两字段都空 → 可勾选"用 AI 提炼标题和描述"
//       * 仅标题空 → 可勾选"用 AI 提炼标题"（只禁用标题输入框）
//       * 仅内容空 → 可勾选"用 AI 提炼内容"（只禁用内容输入框）
//       * 都填了 → 勾选框禁用，提示"标题和内容均已填写"
//   - 保存流程：拖入文件走多步流程（create → upload → update(source_files) → triggerDistill），
//     后端 DISTILL 按 computeDistillMode 只生成缺失字段
import React, { useState, useEffect } from 'react'
import { X, PenLine, FileText, Trash2, Sparkles, Loader2 } from 'lucide-react'
import DropZone from './DropZone.jsx'
import * as api from '../services/api.js'
import useStore from '../services/store.js'

/**
 * 格式化文件大小为人类可读字符串
 * 功能：把字节数转换为 B/KB/MB 单位的可读文本
 * 实现方式：按 1024 不断除，保留 1 位小数；小于 1KB 直接显示 B
 * @param {number} bytes - 文件字节数
 * @returns {string} 形如 "1.2 KB" 的可读字符串
 */
function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 从文件名提取扩展名（小写）
 * 功能：取文件名最后一个点之后的部分并转小写，无点时返回空字符串
 * @param {string} name - 文件名
 * @returns {string} 小写扩展名（如 'md'、'txt'）
 */
function getFileFormat(name) {
  const parts = name.split('.')
  return parts.length > 1 ? parts.pop().toLowerCase() : ''
}

/**
 * @param {object} props
 * @param {object|null} props.inspiration - null 表示新建，对象表示编辑
 * @param {Function} props.onSave - 保存回调，参数为表单数据对象（仅非 file 流程使用）
 * @param {Function} props.onClose - 关闭弹窗回调
 */
function InspirationModal({ inspiration, onSave, onClose }) {
  // 表单本地状态（v12：删除 sourceType/sourceUrl，来源类型由是否拖入文件自动推导）
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  // v11：拖入的待上传文件列表，每项含 {file, name, size, format}
  const [pendingFiles, setPendingFiles] = useState([])
  // v11：AI 提炼勾选状态（勾选即进入提炼模式；v12 改为按缺失字段精细化）
  const [distillEnabled, setDistillEnabled] = useState(false)
  // v11：保存中状态（多步流程期间禁用按钮）
  const [saving, setSaving] = useState(false)
  // v11：错误提示（如未拖入文件、上传失败等）
  const [errorMsg, setErrorMsg] = useState('')

  // 从 store 获取刷新列表与关闭弹窗（file 流程结束后调用）
  const loadInspirations = useStore((s) => s.loadInspirations)
  const closeModal = useStore((s) => s.closeModal)

  // 是否为新建模式（编辑模式不启用 file 多模态流程，保持原 title/content 编辑行为）
  const isCreateMode = !inspiration

  // 编辑模式下初始化表单（v12：仅回填 title/content，来源字段不再展示）
  useEffect(() => {
    if (inspiration) {
      setTitle(inspiration.title || '')
      setContent(inspiration.content || '')
    }
  }, [inspiration])

  // v12：勾选前提校验——title 和 content 都非空时强制取消勾选并提示
  // 实现方式：在 distillEnabled 变化或 title/content 变化时检查
  //   - 若用户填满了两个字段，强制取消勾选并显示提示"标题和内容均已填写"
  //   - 只要还有空字段，清空提示（允许继续勾选）
  useEffect(() => {
    const bothFilled = title.trim().length > 0 && content.trim().length > 0
    if (distillEnabled && bothFilled) {
      // 两字段都已填写，AI 提炼无必要，强制取消勾选
      setDistillEnabled(false)
      setErrorMsg('')
    }
  }, [title, content, distillEnabled])

  // v12：文件模式下的标题必填校验
  //   - 有文件 + 勾选 AI 提炼 → 标题可空（由 AI 生成）
  //   - 其他情况 → 标题必填
  const canSave = !saving && (
    (pendingFiles.length > 0 && distillEnabled) || title.trim().length > 0
  )

  /**
   * v11：DropZone onFiles 回调
   * 功能：拖入文本文件时被调用，预读每个 File 的元数据后追加到 pendingFiles
   * 实现方式：File 对象自带 name 与 size 属性，无需 FileReader 读取内容
   *   （任务说"FileReader 预读"是指读取元数据展示，File.name/size 已足够）
   *   - 去重：按 file.name + file.size 唯一性过滤，避免重复拖入同一文件
   *   - 不读取文件正文（仅元数据，与"不显示文件内容"约束一致）
   * @param {File[]} files - DropZone 分流后的文本文件数组
   */
  const handleFilesDrop = (files) => {
    setErrorMsg('')
    setPendingFiles((prev) => {
      // 用 name+size 作为唯一键去重
      const existingKeys = new Set(prev.map((p) => `${p.name}_${p.size}`))
      const additions = []
      for (const file of files) {
        const key = `${file.name}_${file.size}`
        if (!existingKeys.has(key)) {
          additions.push({
            file,
            name: file.name,
            size: file.size,
            format: getFileFormat(file.name)
          })
          existingKeys.add(key)
        }
      }
      return [...prev, ...additions]
    })
  }

  /**
   * v12：DropZone onImages 回调
   * 功能：新建灵感仅支持文本文件（.md/.txt），拖入图片时显示错误提示
   * 实现方式：setErrorMsg 提示用户（图片在追加弹窗中才支持，新建灵感不做识图流程）
   */
  const handleImagesDrop = () => {
    setErrorMsg('仅支持文本文件（.md/.txt），不支持图片')
  }

  /**
   * v11：移除某个待上传文件
   * @param {number} idx - pendingFiles 中的索引
   */
  const handleRemoveFile = (idx) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  /**
   * v12：切换"用 AI 提炼"勾选框（按缺失字段精细化）
   * 功能：勾选前提是 title 和 content 至少有一个为空（空字段才需要 AI 生成）
   * 实现方式：
   *   - 两字段都非空 → 勾选无效（无空字段可提炼），直接 return
   *   - 有空字段 → 切换勾选状态（勾选后仅空字段输入框被禁用，已填字段保持可编辑）
   */
  const handleToggleDistill = () => {
    const bothFilled = title.trim().length > 0 && content.trim().length > 0
    if (bothFilled) {
      setDistillEnabled(false)
      setErrorMsg('')
      return
    }
    setDistillEnabled((v) => !v)
    setErrorMsg('')
  }

  /**
   * 处理保存：组装表单数据后调用 onSave
   * v12 扩展：拖入文件（pendingFiles 非空）时走多步异步流程（创建→上传→更新→按需提炼）
   *   - 有文件 + 勾选 AI 提炼：缺失字段由后端 DISTILL 按 computeDistillMode 生成
   *   - 有文件 + 未勾选（用户已填 title/content）：文件仅存档，不触发提炼
   */
  const handleSave = async () => {
    // v12：文件模式的多步流程（判据从 sourceType==='file' 改为 pendingFiles 非空）
    if (isCreateMode && pendingFiles.length > 0) {
      setSaving(true)
      setErrorMsg('')
      try {
        // 步骤 1：先创建灵感拿 id（source_files 暂为空数组）
        // title：用户已填则用真实标题；未填且勾选提炼则 'Loading' 占位（触发前端轮询 + 后端回填）
        const createRes = await api.createInspiration({
          title: title.trim() || (distillEnabled ? 'Loading' : ''),
          content,
          source_type: 'file',
          source_files: []
        })
        if (!createRes.success || !createRes.data) {
          throw new Error(createRes.error || '创建灵感失败')
        }
        const created = createRes.data

        // 步骤 2：上传文件到 /inspirations/:id/files，拿到 uploadedFiles 元数据
        const rawFiles = pendingFiles.map((p) => p.file)
        const uploadRes = await api.uploadInspirationFiles(created.id, rawFiles)
        const uploadedFiles = uploadRes.data || []

        // 步骤 3：把上传后的文件元数据写回灵感（供后端 DISTILL 任务读取 source_files_json）
        await api.updateInspiration(created.id, { source_files: uploadedFiles })

        // 步骤 4：勾选提炼时触发 DISTILL（后端按 computeDistillMode 只生成缺失字段，
        //         已填字段原样保留；triggerDistill 入队时把缺失字段标记"提炼中(3)"供前端轮询）
        if (distillEnabled) {
          await api.triggerDistill(created.id)
        }

        // 步骤 5：刷新灵感列表（让新创建的灵感出现在列表中，DISTILL 完成后再次刷新可见回填）
        await loadInspirations()
        // 步骤 6：关闭弹窗
        closeModal()
      } catch (err) {
        setErrorMsg(err.message || '保存失败')
        setSaving(false)
      }
      return
    }

    // 非文件流程：仅提交 title/content
    // 新建：后端 source_type 默认 'manual'；编辑：updateInspiration 只更新传入字段，保留原 source_type/source_url
    if (!title.trim()) return
    onSave({
      title: title.trim(),
      content
    })
  }

  // v12：是否显示文件区（拖入文件后自动显示，无需手动选择"文件"来源）
  const showFileZone = isCreateMode && pendingFiles.length > 0
  // v12：AI 提炼启用状态与文案（按缺失字段动态化）
  //   - 两字段都空 → "用 AI 提炼标题和描述"（可勾选）
  //   - 仅标题空 → "用 AI 提炼标题"（可勾选）
  //   - 仅内容空 → "用 AI 提炼内容"（可勾选）
  //   - 都填了 → 勾选框禁用（bothFilled=true），无空字段可提炼
  const bothFilled = title.trim().length > 0 && content.trim().length > 0
  const distillLabel = !title.trim() && !content.trim()
    ? '用 AI 提炼标题和描述'
    : !title.trim()
      ? '用 AI 提炼标题'
      : '用 AI 提炼内容'

  return (
    // DropZone 包裹整个弹窗作为 children（v12 改造）：
    //   - active={isCreateMode}：新建模式下始终激活拖放（拖入即上传，无需手动选择"文件"来源）
    //   - existingType：已有文本文件时锁定 'file'（拒绝图片混入）；空时接受任何类型按首类锁定
    //   - onFiles/onImages 回调处理拖入的文件
    <DropZone
      active={isCreateMode}
      existingType={showFileZone ? 'file' : null}
      onFiles={handleFilesDrop}
      onImages={handleImagesDrop}
    >
      {/* 遮罩层：深色 + backdrop-blur，点击关闭 */}
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
            {/* 标题：必填（文件模式 + 勾选 AI 提炼时标题可空，由 AI 生成） */}
            <div>
              <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
                标题 {!(showFileZone && distillEnabled) ? <span style={{ color: 'var(--accent-cyan)' }}>*</span> : null}
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={distillEnabled && !title.trim() ? '将由 AI 提炼标题...' : '给这个灵感起个名字...'}
                autoFocus
                disabled={distillEnabled && !title.trim()}
                className={`input-accent w-full px-4 py-2.5 rounded-xl text-sm text-ink/80 placeholder-ink/25 font-sans ${distillEnabled && !title.trim() ? 'opacity-60 cursor-not-allowed' : ''}`}
              />
            </div>

            {/* 内容：多行文本（文件模式 + 勾选 AI 提炼时内容可空，由 AI 生成） */}
            <div>
              <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
                内容
              </label>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={6}
                placeholder={distillEnabled && !content.trim() ? '将由 AI 提炼内容...' : '详细描述你的灵感...'}
                disabled={distillEnabled && !content.trim()}
                className={`input-accent w-full px-4 py-2.5 rounded-xl text-sm text-ink/80 placeholder-ink/25 resize-none font-sans ${distillEnabled && !content.trim() ? 'opacity-60 cursor-not-allowed' : ''}`}
              />
            </div>

            {/* v12：文件条目区 + AI 提炼区（拖入文件后自动显示；常驻拖放提示区已移除，拖放由 DropZone 全屏浮窗承接） */}
            {showFileZone && (
              <div className="space-y-3">
                {/* 文件条目列表：与 AddendumSection 文件条目风格一致（独立卡片） */}
                {pendingFiles.length > 0 && (
                  <div className="space-y-2">
                    {pendingFiles.map((item, idx) => (
                      <div
                        key={`${item.name}_${item.size}_${idx}`}
                        className="glass-card rounded-lg p-3 flex items-center justify-between gap-3 transition-all"
                        style={{
                          background: 'rgb(var(--deep2-rgb) / 0.5)',
                          border: '1px solid rgb(var(--ink) / 0.05)'
                        }}
                      >
                        {/* 文件元数据：图标 + 名.格式 + 大小 */}
                        <div className="flex items-center gap-2.5 min-w-0 flex-1">
                          <FileText size={14} style={{ color: 'var(--accent-cyan)' }} className="shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-ink/80 text-xs font-sans truncate">
                              {item.name}
                            </p>
                            <p className="text-ink/30 text-[10px] font-sans">
                              {item.format.toUpperCase()} · {formatFileSize(item.size)}
                            </p>
                          </div>
                        </div>
                        {/* 移除按钮 */}
                        <button
                          type="button"
                          onClick={() => handleRemoveFile(idx)}
                          className="p-1.5 rounded-md text-ink/30 hover:text-red-400 hover:bg-red-500/10 transition-all shrink-0"
                          title="移除文件"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* v12：AI 提炼选择框（按缺失字段精细化，勾选即提炼，无需二次点击） */}
                <div
                  className="rounded-xl p-3.5 transition-all"
                  style={{
                    background: 'rgb(var(--cyan-rgb) / 0.04)',
                    border: '1px solid rgb(var(--cyan-rgb) / 0.12)'
                  }}
                >
                  {/* 勾选框行 */}
                  <div className="flex items-start gap-2.5">
                    <button
                      type="button"
                      onClick={handleToggleDistill}
                      disabled={bothFilled}
                      className={`mt-0.5 shrink-0 ${bothFilled ? 'opacity-40 cursor-not-allowed' : ''}`}
                      aria-pressed={distillEnabled}
                    >
                      {/* 自定义勾选框样式：与项目毛玻璃美学一致 */}
                      <div
                        className="w-4 h-4 rounded flex items-center justify-center transition-all"
                        style={{
                          background: distillEnabled
                            ? 'var(--accent-cyan)'
                            : 'rgb(var(--ink) / 0.05)',
                          border: distillEnabled
                            ? '1px solid var(--accent-cyan)'
                            : '1px solid rgb(var(--ink) / 0.2)'
                        }}
                      >
                        {distillEnabled && (
                          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                            <path
                              d="M2.5 6L5 8.5L9.5 3.5"
                              stroke="white"
                              strokeWidth="1.8"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </div>
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <Sparkles size={12} style={{ color: 'var(--accent-cyan)' }} />
                        <span className="text-ink/80 text-xs font-sans font-medium">
                          {distillLabel}
                        </span>
                      </div>
                      {/* 勾选前提提示：两字段都填写时禁用，说明无需 AI 提炼 */}
                      {bothFilled && (
                        <p className="text-ink/40 text-[10px] font-sans mt-0.5">
                          标题和内容均已填写，无需 AI 提炼
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* v11：错误提示（如未拖入文件、上传失败等） */}
            {errorMsg && (
              <div
                className="rounded-lg px-3 py-2 text-xs font-sans"
                style={{
                  background: 'rgb(239 68 68 / 0.1)',
                  border: '1px solid rgb(239 68 68 / 0.2)',
                  color: 'rgb(252 165 165)'
                }}
              >
                {errorMsg}
              </div>
            )}
          </div>

          {/* 底部按钮区 */}
          <div className="flex justify-end gap-3 px-7 py-5 border-t border-line/5">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="glass-card px-5 py-2.5 rounded-xl text-ink/60 hover:text-ink/80 text-sm font-medium transition-colors font-sans disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!canSave}
              className="btn-accent px-5 py-2.5 rounded-xl text-white text-sm font-medium font-sans flex items-center gap-1.5"
            >
              {/* 保存中显示 loading 图标 */}
              {saving && <Loader2 size={13} className="animate-spin" />}
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </DropZone>
  )
}

export default InspirationModal
