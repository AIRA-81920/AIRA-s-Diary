// FolderEditModal 文件夹编辑弹窗（v8 新增）
// 功能：重命名文件夹 + 选择颜色（预设色板 + 取色盘）+ 删除文件夹
// 实现方式：玻璃态浮窗，与 InspirationModal 风格一致
import React, { useState, useEffect } from 'react'
import { X, Folder as FolderIcon, Trash2 } from 'lucide-react'
import useStore from '../services/store.js'
import { getFolderPresetColors } from '../services/themeTokens.js'

function FolderEditModal() {
  const folder = useStore((s) => s.folderEditModal)
  const closeFolderEdit = useStore((s) => s.closeFolderEdit)
  const updateFolder = useStore((s) => s.updateFolder)
  const deleteFolder = useStore((s) => s.deleteFolder)

  const [name, setName] = useState('')
  const [color, setColor] = useState('#60a5fa')
  const [confirmDelete, setConfirmDelete] = useState(false)

  // 初始化表单
  useEffect(() => {
    if (folder) {
      setName(folder.name || '')
      setColor(folder.color || '#60a5fa')
      setConfirmDelete(false)
    }
  }, [folder])

  if (!folder) return null

  const presetColors = getFolderPresetColors()
  const presetEntries = Object.entries(presetColors)

  const handleSave = () => {
    updateFolder(folder.id, { name: name.trim() || '未命名文件夹', color })
    closeFolderEdit()
  }

  const handleDelete = () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    deleteFolder(folder.id)
    closeFolderEdit()
  }

  return (
    // 遮罩层
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgb(var(--mask-rgb)_/_0.7)] backdrop-blur-md animate-fade-in-up"
      onClick={closeFolderEdit}
    >
      {/* 卡片本体 */}
      <div
        className="glass-card w-full max-w-sm mx-4 rounded-2xl shadow-2xl overflow-hidden relative"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'rgb(var(--deep2-rgb) / 0.85)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgb(var(--cyan-rgb) / 0.1)'
        }}
      >
        {/* 顶部渐变光带 */}
        <div
          className="absolute top-0 left-0 right-0 h-px"
          style={{
            background: `linear-gradient(90deg, transparent, ${color}80, transparent)`
          }}
        />

        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line/5">
          <div className="flex items-center gap-2.5">
            <FolderIcon size={16} style={{ color }} />
            <h2 className="font-display text-lg font-semibold text-ink">编辑文件夹</h2>
          </div>
          <button
            type="button"
            onClick={closeFolderEdit}
            className="modal-close-btn p-1.5 rounded-lg text-ink/40"
          >
            <X size={16} />
          </button>
        </div>

        {/* 表单 */}
        <div className="px-6 py-5 space-y-5">
          {/* 名称 */}
          <div>
            <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
              名称
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="文件夹名称..."
              autoFocus
              className="input-accent w-full px-4 py-2.5 rounded-xl text-sm text-ink/80 placeholder-ink/25 font-sans"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave() }}
            />
          </div>

          {/* 预设色板 */}
          <div>
            <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
              颜色
            </label>
            <div className="flex items-center gap-2.5 flex-wrap">
              {presetEntries.map(([key, val]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setColor(val)}
                  className={`w-7 h-7 rounded-full transition-all duration-200 ${
                    color === val
                      ? 'ring-2 ring-offset-2 ring-offset-[rgb(var(--deep2-rgb))] scale-110'
                      : 'hover:scale-110'
                  }`}
                  style={{
                    backgroundColor: val,
                    ringColor: val
                  }}
                  title={key}
                />
              ))}
            </div>
          </div>

          {/* 取色盘 */}
          <div>
            <label className="block text-[11px] font-medium text-ink/50 mb-2 uppercase tracking-wider font-sans">
              自定义颜色
            </label>
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-10 h-10 rounded-lg border border-line/10 cursor-pointer bg-transparent p-0.5"
              />
              <span className="text-ink/40 text-xs font-mono">{color}</span>
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-line/5">
          {/* 删除按钮 */}
          <button
            type="button"
            onClick={handleDelete}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
              confirmDelete
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                : 'text-ink/30 hover:text-red-400/80 hover:bg-red-500/10'
            }`}
          >
            <Trash2 size={13} />
            {confirmDelete ? '确认删除？' : '删除'}
          </button>

          {/* 完成按钮 */}
          <button
            type="button"
            onClick={handleSave}
            className="btn-accent px-5 py-2.5 rounded-xl text-white text-sm font-medium font-sans"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  )
}

export default FolderEditModal
