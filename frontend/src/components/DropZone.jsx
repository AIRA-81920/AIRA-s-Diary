// DropZone 全屏拖放浮窗（深空智识美学）
// 功能：在父组件激活时（如弹窗打开期间）接管 document 级 dragenter/dragover/dragleave/drop 事件，
//      显示毛玻璃 + 虚线边框的全屏浮窗，按文件类型分流到 onImages / onFiles 回调，
//      并根据 existingType 强制单类型限制（图片与文本不可混入）
// 实现方式：
//   - 仅在 active=true 时绑定 document 级事件，与列表拖拽（@dnd-kit）天然互斥
//   - dragCounter 用 ref 计数，避免子元素 dragleave 误触隐藏浮窗
//   - 文件类型判断采用 MIME type 与扩展名双重兜底
//   - 浮窗通过 createPortal 渲染到 document.body（与项目其他弹窗一致，规避父级 transform 影响 fixed）
//   - 用 ref 同步最新 props/state 给事件 handler，避免闭包陷阱；useEffect 只依赖 active 重绑事件
import React, { useState, useEffect, useRef, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { UploadCloud } from 'lucide-react'

/**
 * 文件类型分类（MIME type 优先，扩展名兜底）
 * @param {File} file
 * @returns {'image'|'file'|null} — image 表示图片，file 表示文本/markdown，null 表示不支持
 */
function classifyFile(file) {
  // 1. 优先按 MIME type 判断
  if (file.type.startsWith('image/')) return 'image'
  const textTypes = ['text/markdown', 'text/plain', 'text/x-markdown']
  if (textTypes.includes(file.type)) return 'file'
  // 2. MIME 未知或为空时按扩展名兜底（部分系统 .md 会给出 application/octet-stream）
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (['md', 'txt', 'markdown'].includes(ext)) return 'file'
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) return 'image'
  return null
}

/**
 * 从 DataTransfer.items 实时探测拖入文件类型（dragover 阶段用于动态文案）
 * 注意：items 在 dragover 期间可读 type（MIME），但读不到 name；此处仅按 MIME 推断
 * @param {DataTransferItemList} items
 * @returns {'image'|'file'|'mixed'|'unknown'|null}
 */
function detectTypeFromItems(items) {
  if (!items || items.length === 0) return null
  const types = new Set()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue
    const mt = item.type
    if (mt.startsWith('image/')) {
      types.add('image')
    } else if (['text/markdown', 'text/plain', 'text/x-markdown'].includes(mt)) {
      types.add('file')
    } else if (mt === '') {
      // 浏览器未给出 MIME（如某些 .md 文件），跳过；等 drop 时按扩展名精确判断
    } else {
      // 其他类型暂记为 unknown，等 drop 时再精确分类
      types.add('unknown')
    }
  }
  if (types.size === 0) return null
  // 同时含图片与文本 → mixed
  if (types.has('image') && types.has('file')) return 'mixed'
  if (types.has('unknown')) return 'unknown'
  if (types.has('image')) return 'image'
  if (types.has('file')) return 'file'
  return null
}

/**
 * @param {object} props
 * @param {boolean} props.active - 是否激活拖放区（父组件控制，例如弹窗打开时为 true）
 * @param {'image'|'file'|null} props.existingType - 当前已有文件类型，null 表示空，允许任何类型
 * @param {(files: File[]) => void} [props.onImages] - 图片文件回调
 * @param {(files: File[]) => void} [props.onFiles] - 文本文件回调
 * @param {React.ReactNode} [props.children] - 父组件渲染内容，DropZone 作为 overlay 覆盖其上
 */
function DropZone({ active, existingType, onImages, onFiles, children }) {
  // 是否显示浮窗（dragenter 后 true，drop/dragleave 后 false）
  const [isDragging, setIsDragging] = useState(false)
  // 当前拖入文件类型（dragover 阶段探测，用于动态文案）
  const [currentType, setCurrentType] = useState(null)
  // drop 后的临时提示文案（如冲突/忽略提示），存在时浮窗保持显示，setTimeout 后清空
  const [pinnedMsg, setPinnedMsg] = useState(null)
  // dragenter/dragleave 计数器，避免子元素 dragleave 误触隐藏浮窗
  const dragCounter = useRef(0)
  // drop 后延迟隐藏浮窗的 timer 引用
  const hideTimer = useRef(null)

  // 用 ref 同步最新的 props/state 给 document 级事件 handler，避免闭包陷阱
  // 这样 useEffect 只需依赖 active 即可，事件不会因 existingType/回调变化而频繁重绑
  const ctxRef = useRef({ existingType, onImages, onFiles })
  useEffect(() => {
    ctxRef.current = { existingType, onImages, onFiles }
  })

  // 组件卸载时清理 timer，避免内存泄漏
  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  // active 变化时绑定/解绑 document 级事件
  useEffect(() => {
    if (!active) {
      // 关闭时重置所有拖放状态
      dragCounter.current = 0
      setIsDragging(false)
      setCurrentType(null)
      setPinnedMsg(null)
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      return
    }

    // dragenter：仅响应文件拖入，显示浮窗并探测类型
    const handleDragEnter = (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return
      e.preventDefault()
      dragCounter.current++
      // 若 drop 后仍有 pinned 提示（延迟隐藏期间），用户再次拖入时清掉旧提示
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }
      setPinnedMsg(null)
      const t = detectTypeFromItems(e.dataTransfer.items)
      setCurrentType(t)
      setIsDragging(true)
    }

    // dragover：必须 preventDefault 才能触发后续 drop；不更新状态（dragenter 已设过）
    const handleDragOver = (e) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
    }

    // dragleave：计数器归零时才隐藏浮窗（避免子元素 dragleave 误触）
    const handleDragLeave = (e) => {
      e.preventDefault()
      dragCounter.current--
      if (dragCounter.current <= 0) {
        dragCounter.current = 0
        // 若有 pinned 提示则保留（drop 后的延迟隐藏期间不响应 dragleave）
        if (!hideTimer.current) {
          setIsDragging(false)
          setCurrentType(null)
        }
      }
    }

    // drop：preventDefault 拦截浏览器默认打开文件 → 按类型分流 → 调用回调 → 隐藏浮窗
    const handleDrop = (e) => {
      e.preventDefault()
      dragCounter.current = 0
      if (hideTimer.current) {
        clearTimeout(hideTimer.current)
        hideTimer.current = null
      }

      const files = Array.from(e.dataTransfer.files || [])
      if (files.length === 0) {
        setIsDragging(false)
        setCurrentType(null)
        setPinnedMsg(null)
        return
      }

      // 取最新的 existingType / 回调（ref 同步）
      const { existingType: et, onImages: oi, onFiles: of_ } = ctxRef.current

      // 对每个文件做精确分类
      const classified = files.map((f) => ({ file: f, type: classifyFile(f) }))
      const images = classified.filter((c) => c.type === 'image').map((c) => c.file)
      const texts = classified.filter((c) => c.type === 'file').map((c) => c.file)

      // 浮窗延迟隐藏：保留 pinnedMsg 一段时间让用户看到提示
      const closeAfter = (delay) => {
        hideTimer.current = setTimeout(() => {
          hideTimer.current = null
          setIsDragging(false)
          setCurrentType(null)
          setPinnedMsg(null)
        }, delay)
      }
      // 浮窗立即隐藏：无提示时直接关闭
      const closeNow = () => {
        setIsDragging(false)
        setCurrentType(null)
        setPinnedMsg(null)
      }

      // 1. 全部不支持
      if (images.length === 0 && texts.length === 0) {
        setPinnedMsg('不支持的文件类型')
        closeAfter(1500)
        return
      }

      // 2. 混合拖入（同时含图片和文本）
      if (images.length > 0 && texts.length > 0) {
        if (et === 'image') {
          // 已有图片，仅接受图片，忽略文本
          oi?.(images)
          setPinnedMsg(`已添加 ${images.length} 张图片，忽略 ${texts.length} 个文本文件`)
        } else if (et === 'file') {
          // 已有文本，仅接受文本，忽略图片
          of_?.(texts)
          setPinnedMsg(`已添加 ${texts.length} 个文本文件，忽略 ${images.length} 张图片`)
        } else {
          // existingType 为 null：按首类决定后续接受类型，另一类被忽略
          const firstType = classified[0].type
          if (firstType === 'image') {
            oi?.(images)
            setPinnedMsg(`已添加 ${images.length} 张图片，忽略 ${texts.length} 个文本文件`)
          } else {
            of_?.(texts)
            setPinnedMsg(`已添加 ${texts.length} 个文本文件，忽略 ${images.length} 张图片`)
          }
        }
        closeAfter(1800)
        return
      }

      // 3. 单类型 - 仅图片
      if (images.length > 0) {
        if (et === 'file') {
          // 已有文本文件，拒绝图片
          setPinnedMsg('已有文本文件，不可混入图片')
          closeAfter(1800)
          return
        }
        oi?.(images)
        closeNow()
        return
      }

      // 4. 单类型 - 仅文本
      if (texts.length > 0) {
        if (et === 'image') {
          // 已有图片，拒绝文本
          setPinnedMsg('已有图片，不可混入文本文件')
          closeAfter(1800)
          return
        }
        of_?.(texts)
        closeNow()
        return
      }
    }

    // 绑定到 document（capture 阶段更早拦截，避免被内部元素 stopPropagation 阻断）
    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('drop', handleDrop)
    }
  }, [active])

  // 文案推导：pinned 提示优先，其次按 currentType / existingType 推导动态文案
  const displayMsg = useMemo(() => {
    if (pinnedMsg) return pinnedMsg
    if (!currentType) return '拖放文件到此处'
    if (currentType === 'mixed') return '不可混合拖入图片与文本文件'
    if (currentType === 'unknown') return '不支持的文件类型'
    if (existingType === 'image' && currentType === 'file') return '已有图片，不可混入文本文件'
    if (existingType === 'file' && currentType === 'image') return '已有文本文件，不可混入图片'
    if (currentType === 'image') return '松手添加到图片区'
    if (currentType === 'file') return '松手添加到文件区'
    return '拖放文件到此处'
  }, [pinnedMsg, currentType, existingType])

  return (
    <>
      {/* 父组件渲染内容：DropZone 作为 overlay 覆盖其上 */}
      {children}
      {/* 浮窗 overlay：仅 active=true 时挂载，用 createPortal 渲染到 body，避免父级 transform 影响 fixed
          z-[200] 确保在所有 Modal 之上（Modal 遮罩 z-[100]，图片预览 z-[110]） */}
      {active && createPortal(
        <div
          className={`fixed inset-0 z-[200] flex items-center justify-center bg-[rgb(var(--mask-rgb)_/_0.6)] backdrop-blur-md transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
            isDragging ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          aria-hidden={!isDragging}
        >
          {/* 中央卡片：glass-card 毛玻璃 + 虚线边框 + 圆角 + padding */}
          <div
            className={`glass-card rounded-2xl border-2 border-dashed px-12 py-10 flex flex-col items-center gap-4 transition-all duration-[400ms] ease-[cubic-bezier(0.16,1,0.3,1)] ${
              isDragging ? 'scale-100' : 'scale-95'
            }`}
            style={{
              borderColor: 'var(--accent-cyan)',
              background: 'rgb(var(--deep2-rgb) / 0.55)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgb(var(--cyan-rgb) / 0.1)'
            }}
          >
            {/* 图标：UploadCloud（cyan 强调色） */}
            <UploadCloud size={48} style={{ color: 'var(--accent-cyan)' }} />
            {/* 动态文案 */}
            <p className="text-ink/80 text-sm font-sans text-center max-w-xs">
              {displayMsg}
            </p>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

export default DropZone
