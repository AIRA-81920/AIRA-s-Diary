// Sidebar 灵感列表组件（v8 文件夹分组 + dnd-kit 拖拽 + Android 式合并创建）
// 功能：
//   - 展开态：搜索框 + 文件夹树（可展开/折叠）+ 散灵感列表
//   - 挤压态（抽屉打开时）：80px 图标模式
//   - 拖拽：灵感移入/移出文件夹、文件夹/散灵感排序
//   - 合并：拖拽灵感到另一散灵感上悬停 500ms → 创建文件夹
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { openExternalLink } from '../services/openLink.js'
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  rectIntersection,
  useDroppable
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Search, Brain, Plus, ChevronRight, Folder as FolderIcon, FolderPlus, Pencil } from 'lucide-react'
import { formatTime } from '../services/store.js'
// UI 精修：类型色小色点 + 微光系统动态色工具
import { getInspirationTypeColor } from '../services/themeTokens.js'
import { hexToRgb } from '../services/glowSystem.js'

// ========== 渐变色工具 ==========

function folderGradientIdle(color) {
  return `linear-gradient(to right, ${color}38 0%, ${color}15 30%, transparent 60%)`
}

function folderGradientActive(color) {
  return `linear-gradient(to right, ${color}45 0%, ${color}20 25%, ${color}08 45%, transparent 65%)`
}

// 展开态：颜色从左侧渐变色带向右扩散，梯度衰减，100% 处完全透明
function folderGradientExpanded(color) {
  return `linear-gradient(to right, ${color}45 0%, ${color}28 30%, ${color}15 60%, transparent 100%)`
}

// 获取拖拽项的当前 rect（优先 translated，为空时用 initial + delta 精确计算）
// 原因：dnd-kit 源码中 active.rect.current 是在 useEffect 里赋值的，拖拽初期/帧间可能为 null
function getDragRect(event) {
  const { active, delta } = event
  const translated = active?.rect?.current?.translated
  if (translated) return translated
  const initial = active?.rect?.current?.initial
  if (initial && delta) {
    return {
      top: initial.top + delta.y,
      bottom: initial.bottom + delta.y,
      left: initial.left + delta.x,
      right: initial.right + delta.x,
      width: initial.width,
      height: initial.height
    }
  }
  return null
}

// 校验拖拽项中心是否真正落入目标区域 rect 内
// 严格模式：拿不到 rect 时返回 false（不触发加入），彻底杠绝 closestCenter“最近即命中”的误判
// 底部缩进 16px：让加入判定区域比文件夹视觉区域略小，防止中心在边缘时误触发
function isReallyOver(event, over) {
  const aRect = getDragRect(event)
  const oRect = over?.rect
  if (!aRect || !oRect) return false
  const cx = aRect.left + aRect.width / 2
  const cy = aRect.top + aRect.height / 2
  return cx >= oRect.left && cx <= oRect.right && cy >= oRect.top && cy <= oRect.bottom - 16
}

// 自定义碰撞检测：文件夹优先
// 只要拖拽项与某个文件夹的矩形相交，就强制把该文件夹作为 over 目标（优先级最高），
// 避免 closestCenter 把文件夹内的灵感报告为 over 导致判定混乱。
// 其余情况回退到 closestCenter（保证散灵感排序正常）。
function folderFirstCollision(args) {
  const { droppableContainers } = args
  const folderContainers = droppableContainers.filter((c) =>
    String(c.id).startsWith('folder-')
  )
  const folderCollisions = rectIntersection({ ...args, droppableContainers: folderContainers })
  if (folderCollisions.length > 0) return folderCollisions
  return closestCenter(args)
}

// ========== 子组件：灵感条目 ==========

function InspirationItem({
  inspiration,
  isSelected,
  folderColor,
  onSelect,
  dragHandleProps,
  isMergeTarget,
  isMergeReady,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
  onContextMenu
}) {
  const accentColor = folderColor || 'var(--accent-cyan)'
  const [renameText, setRenameText] = useState(inspiration.title || '')
  const renameRef = useRef(null)

  // UI 精修：类型色小色点（9 种类型各一色，未知类型不显示）
  const typeColor = getInspirationTypeColor(inspiration.inspiration_type)
  // UI 精修：文件夹内条目微光用文件夹色（动态 RGB），散灵感用默认青色
  const glowRgb = folderColor ? hexToRgb(folderColor) : null

  // 进入重命名态时聚焦并全选
  useEffect(() => {
    if (isRenaming && renameRef.current) {
      setRenameText(inspiration.title || '')
      renameRef.current.focus()
      renameRef.current.select()
    }
  }, [isRenaming])

  const handleRenameSubmit = () => {
    const trimmed = renameText.trim()
    if (trimmed && trimmed !== inspiration.title) {
      onRenameSubmit(inspiration.id, trimmed)
    } else {
      onRenameCancel()
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !isRenaming && onSelect(inspiration)}
      onContextMenu={(e) => {
        e.preventDefault()
        // 关键：阻止冒泡到 window，避免 window 的 contextmenu 监听器立即关闭刚打开的菜单
        e.stopPropagation()
        if (!isRenaming && onContextMenu) onContextMenu(e, inspiration)
      }}
      className={`glow-card glass-card w-full text-left px-4 py-3 rounded-xl relative overflow-hidden group transition-all duration-300 cursor-pointer ${
        isSelected ? 'bg-veil/[0.06]' : 'hover:bg-veil/[0.04]'
      } ${isMergeTarget ? 'scale-[1.03] ring-1 ring-cyan-400/50' : ''}`}
      style={{
        // UI 精修：文件夹内条目 --glow 用文件夹色，微光跟随鼠标并同色呼应
        '--glow': glowRgb || undefined,
        ...(isSelected
          ? { boxShadow: `inset 3px 0 0 ${accentColor}, 0 0 20px rgb(var(--cyan-rgb) / 0.08)` }
          : isMergeTarget
            ? { boxShadow: '0 0 24px rgb(var(--cyan-rgb) / 0.15)', transform: 'scale(1.03)' }
            : {})
      }}
      {...dragHandleProps}
    >
      {/* 标题行：重命名态显示输入框，否则显示文本；右侧为类型小色点 */}
      <div className="flex items-center gap-1.5">
        {isRenaming ? (
          <input
            ref={renameRef}
            type="text"
            value={renameText}
            onChange={(e) => setRenameText(e.target.value)}
            onBlur={handleRenameSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameSubmit()
              if (e.key === 'Escape') onRenameCancel()
            }}
            onClick={(e) => e.stopPropagation()}
            className="input-accent w-full px-2 py-0.5 rounded-md text-ink/85 font-medium text-sm font-sans flex-1 min-w-0"
          />
        ) : (
          <p className="text-ink/85 font-medium text-sm truncate font-sans flex-1 min-w-0">
            {inspiration.title}
          </p>
        )}
        {/* UI 精修：8px 类型色小色点（与网络图节点同色板，不占位） */}
        {typeColor && (
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ background: typeColor, boxShadow: `0 0 6px ${typeColor}80` }}
            title={inspiration.inspiration_type || ''}
          />
        )}
      </div>
      <p className="text-ink/35 text-[11px] mt-1 font-sans tracking-wide">
        {formatTime(inspiration.created_at)}
      </p>

      {/* 合并提示标语 */}
      {isMergeTarget && (
        <div className={`absolute inset-0 flex items-center justify-center bg-[rgb(var(--deep-rgb)_/_0.85)] rounded-xl transition-opacity duration-200 ${isMergeReady ? 'opacity-100' : 'opacity-0'}`}>
          <div className="flex items-center gap-1.5 text-cyan-300 text-xs font-medium font-sans">
            <FolderPlus size={13} />
            <span>释放以建立文件夹</span>
          </div>
        </div>
      )}

      {/* 悬停态装饰：右侧渐变光带 */}
      <div
        className="absolute right-0 top-0 bottom-0 w-px opacity-0 group-hover:opacity-100 transition-opacity"
        style={{ background: `linear-gradient(180deg, transparent, ${accentColor}66, transparent)` }}
      />
    </div>
  )
}

// ========== 子组件：可拖拽灵感条目 ==========

function SortableInspirationItem({
  inspiration,
  isSelected,
  folderColor,
  onSelect,
  isMergeTarget,
  isMergeReady,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
  onContextMenu,
  disableShift,
  disabled = false
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: `insp-${inspiration.id}`, disabled })

  // 核心修复：不用 DragOverlay，让 sortable 项目本身就是拖拽视觉
  // Bug4 修复：锁定 X 轴，只跟随 Y 坐标（x 强制为 0）；scaleX/scaleY 强制 1 消除缩放
  // 修改4：disableShift 时不应用 transform（文件夹拖拽时散灵感不被挤开）
  const style = {
    transform: disableShift ? undefined : CSS.Transform.toString(transform ? { ...transform, x: 0, scaleX: 1, scaleY: 1 } : null),
    transition: disableShift ? undefined : transition,
    zIndex: isDragging ? 50 : undefined,
    position: 'relative',
    ...(isDragging ? {
      boxShadow: '0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgb(var(--cyan-rgb) / 0.3)',
      cursor: 'grabbing'
    } : {})
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <InspirationItem
        inspiration={inspiration}
        isSelected={isSelected}
        folderColor={folderColor}
        onSelect={onSelect}
        dragHandleProps={listeners}
        isMergeTarget={isMergeTarget}
        isMergeReady={isMergeReady}
        isRenaming={isRenaming}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={onRenameCancel}
        onContextMenu={onContextMenu}
      />
    </div>
  )
}

// ========== 子组件：文件夹条目 ==========

function FolderItem({
  folder,
  isExpanded,
  isSelected,
  inspirations,
  selectedInspiration,
  onSelectInspiration,
  onToggleExpand,
  onEdit,
  isJoinTarget,
  isChildDragging,
  disableShift,
  isRenaming,
  onRenameSubmit,
  onRenameCancel,
  onContextMenu
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging
  } = useSortable({ id: `folder-${folder.id}` })

  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `folder-drop-${folder.id}`
  })

  const style = {
    // Bug4 修复：锁定 X 轴；强制 scaleX/scaleY=1 消除“诡异缩放”
    // 修改4：disableShift 时不应用 transform（灵感拖拽时文件夹不被挤开）
    transform: disableShift ? undefined : CSS.Transform.toString(transform ? { ...transform, x: 0, scaleX: 1, scaleY: 1 } : null),
    transition: disableShift ? undefined : transition,
    // Bug3 修复：子灵感被拖拽时提升整个文件夹的 z-index
    zIndex: isDragging ? 50 : (isChildDragging ? 40 : undefined),
    position: 'relative',
    ...(isDragging ? {
      boxShadow: '0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgb(var(--cyan-rgb) / 0.3)',
      cursor: 'grabbing'
    } : {})
  }

  const count = folder.inspiration_count ?? inspirations.length

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      {/* 文件夹标题行 */}
      <div
        ref={setDropRef}
        className={`glow-card relative rounded-xl transition-all duration-300 cursor-pointer select-none overflow-hidden ${
          isOver ? 'ring-1 ring-cyan-400/50' : ''
        }`}
        style={{
          background: folderGradientIdle(folder.color),
          // UI 精修：文件夹条目微光用文件夹色（与内部灵感同色，强化分组认知）
          '--glow': hexToRgb(folder.color) || undefined
        }}
        onClick={() => onToggleExpand(folder.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          onEdit(folder)
        }}
        {...listeners}
      >
        {/* 展开态渐变覆盖层：linear-gradient 无法直接 transition，
            用独立图层 + opacity 过渡实现平滑颜色扩散动画 */}
        <div
          className="absolute inset-0 rounded-xl pointer-events-none transition-opacity duration-300 ease-out"
          style={{
            background: folderGradientExpanded(folder.color),
            opacity: (isExpanded || isSelected) ? 1 : 0
          }}
        />
        <div className="relative flex items-center gap-2.5 px-4 py-3">
          <ChevronRight
            size={14}
            className={`text-ink/40 transition-transform duration-300 flex-shrink-0 ${
              isExpanded ? 'rotate-90' : ''
            }`}
          />
          <FolderIcon size={15} className="flex-shrink-0" style={{ color: folder.color }} />
          <span className="text-ink/80 text-sm font-medium font-sans truncate flex-1">
            {folder.name}
          </span>
          <span className="text-ink/30 text-[10px] font-mono tabular-nums flex-shrink-0">
            {count}
          </span>
        </div>

        {/* 拖拽悬停反馈：“加入文件夹”标语（只用 isJoinTarget，移除 isOver 避免 closestCenter 误报） */}
        {isJoinTarget && (
          <div className="absolute inset-0 flex items-center justify-center bg-[rgb(var(--deep-rgb)_/_0.8)] rounded-xl">
            <div className="flex items-center gap-1.5 text-cyan-300 text-xs font-medium font-sans">
              <FolderIcon size={13} />
              <span>加入文件夹</span>
            </div>
          </div>
        )}
      </div>

      {/* 展开的灵感列表（max-height 动画）
          Bug3 修复：子灵感被拖拽时 overflow:visible，避免被裁剪
          修正：isJoinTarget 的 72px 展开仅对已展开文件夹生效，折叠态始终保持 0
                 斩断“展开→rect变大→isReallyOver通过→保持展开”的反馈循环 */}
      <div
        className={`transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${isChildDragging ? 'overflow-visible' : 'overflow-hidden'}`}
        style={{
          maxHeight: (isExpanded && !isDragging)
            ? `${Math.max((inspirations.length + (isJoinTarget ? 1 : 0)) * 72, 72)}px`
            : '0px',
          opacity: (isExpanded && !isDragging) ? 1 : 0
        }}
      >
        <div className="pl-3 pr-1 pt-1 pb-1 space-y-1.5">
          {inspirations.map((ins) => (
            <SortableInspirationItem
              key={ins.id}
              inspiration={ins}
              isSelected={selectedInspiration?.id === ins.id}
              folderColor={folder.color}
              onSelect={onSelectInspiration}
              isMergeTarget={false}
              isMergeReady={false}
              isRenaming={isRenaming === ins.id}
              onRenameSubmit={onRenameSubmit}
              onRenameCancel={onRenameCancel}
              onContextMenu={onContextMenu}
              disabled={!isExpanded}
            />
          ))}
          {inspirations.length === 0 && isExpanded && (
            <p className="text-ink/20 text-xs text-center py-3 font-sans">空文件夹</p>
          )}
        </div>
      </div>
    </div>
  )
}

// ========== 主组件 ==========

function Sidebar({
  inspirations,
  folders = [],
  folderExpanded = {},
  selectedInspiration,
  searchQuery,
  onSelectInspiration,
  onSearchChange,
  onToggleFolderExpanded,
  onEditFolder,
  onMoveInspiration,
  onReorderItems,
  onCreateFolder,
  onRenameInspiration,
  compressed = false,
  onNewInspiration
}) {
  const [activeDrag, setActiveDrag] = useState(null)
  // 合并状态：mergeTarget = 被悬停的灵感 ID，mergeReady = 是否达到 500ms 阈值
  const [mergeTarget, setMergeTarget] = useState(null)
  const [mergeReady, setMergeReady] = useState(false)
  // 加入文件夹状态：joinFolderTarget = 散灵感悬停的文件夹 ID（悬停标题行或其内部灵感）
  const [joinFolderTarget, setJoinFolderTarget] = useState(null)
  // 修改3：右键菜单状态 { inspId, x, y } | null
  const [contextMenu, setContextMenu] = useState(null)
  // 修改3：正在重命名的灵感 ID | null
  const [renamingId, setRenamingId] = useState(null)
  const mergeTimerRef = useRef(null)

  // 修改4：当前拖拽类型（'folder' | 'inspiration' | null），用于控制跨级不挤压
  const dragType = activeDrag?.type || null

  // 搜索模式：有搜索词时不区分文件夹、全部平铺、禁用拖拽
  const isSearching = searchQuery.trim() !== ''

  // 右键菜单处理
  const handleContextMenu = useCallback((e, inspiration) => {
    setContextMenu({ inspId: inspiration.id, x: e.clientX, y: e.clientY })
  }, [])

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  // 点击“重命名”→ 进入重命名态
  const handleStartRename = useCallback(() => {
    if (contextMenu) {
      setRenamingId(contextMenu.inspId)
      setContextMenu(null)
    }
  }, [contextMenu])

  const handleRenameSubmit = useCallback((inspId, newTitle) => {
    setRenamingId(null)
    if (onRenameInspiration) onRenameInspiration(inspId, newTitle)
  }, [onRenameInspiration])

  const handleRenameCancel = useCallback(() => setRenamingId(null), [])

  // 点击其他地方关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
    }
  }, [contextMenu])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor)
  )

  // 按文件夹分组灵感，每组内按 sort_order 排序
  // 核心修复：排序依据 sort_order 而非数组顺序，这样 store 更新 sort_order 后视觉立即跟随
  const { folderInspirations, looseInspirations } = useMemo(() => {
    const folderMap = {}
    const loose = []
    for (const f of folders) folderMap[f.id] = []
    for (const ins of inspirations) {
      if (ins.folder_id && folderMap[ins.folder_id]) {
        folderMap[ins.folder_id].push(ins)
      } else {
        loose.push(ins)
      }
    }
    // 每组内按 sort_order 升序，同序号按创建时间倒序
    const sortFn = (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || new Date(b.created_at) - new Date(a.created_at)
    for (const key of Object.keys(folderMap)) {
      folderMap[key].sort(sortFn)
    }
    loose.sort(sortFn)
    return { folderInspirations: folderMap, looseInspirations: loose }
  }, [inspirations, folders])

  // 文件夹按 sort_order 排序（核心修复：与灵感一致，store 更新 sort_order 后视觉立即换位）
  // 文件夹始终渲染在散灵感上方，活动范围严格限制在“散灵感上方”区域
  const sortedFolders = useMemo(() => {
    return [...folders].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
  }, [folders])

  // 构建排序用的 ID 列表（包含所有项目：文件夹 + 文件夹内灵感 + 散灵感）
  // 核心：必须包含文件夹内灵感，dnd-kit 才能在跨组移动时计算过渡动画
  const sortableIds = useMemo(() => {
    const ids = []
    for (const f of sortedFolders) {
      ids.push(`folder-${f.id}`)
      for (const ins of folderInspirations[f.id] || []) {
        ids.push(`insp-${ins.id}`)
      }
    }
    for (const ins of looseInspirations) ids.push(`insp-${ins.id}`)
    return ids
  }, [sortedFolders, folderInspirations, looseInspirations])

  // ========== 合并计时器管理 ==========

  const clearMergeTimer = useCallback(() => {
    if (mergeTimerRef.current) {
      clearTimeout(mergeTimerRef.current)
      mergeTimerRef.current = null
    }
    setMergeTarget(null)
    setMergeReady(false)
  }, [])

  const startMergeTimer = useCallback((targetId) => {
    // 如果已经是同一个目标，不重复启动
    if (mergeTarget === targetId) return
    clearMergeTimer()
    setMergeTarget(targetId)
    setMergeReady(false)
    mergeTimerRef.current = setTimeout(() => {
      setMergeReady(true)
    }, 500)
  }, [mergeTarget, clearMergeTimer])

  // ========== 拖拽处理 ==========

  const handleDragStart = useCallback((event) => {
    const { active } = event
    const id = active.id
    if (id.startsWith('folder-')) {
      const folderId = id.replace('folder-', '')
      const folder = sortedFolders.find((f) => f.id === folderId)
      setActiveDrag({ type: 'folder', ...folder })
    } else if (id.startsWith('insp-')) {
      const inspId = id.replace('insp-', '')
      const ins = inspirations.find((i) => i.id === inspId)
      setActiveDrag({ type: 'inspiration', ...ins })
    }
  }, [sortedFolders, inspirations])

  const handleDragOver = useCallback((event) => {
    const { active, over } = event
    if (!over) {
      clearMergeTimer()
      setJoinFolderTarget(null)
      return
    }

    const activeId = active.id
    const overId = over.id

    // 只处理拖拽散灵感的情况
    if (activeId.startsWith('insp-')) {
      const activeInspId = activeId.replace('insp-', '')
      const activeInsp = inspirations.find((i) => i.id === activeInspId)

      if (activeInsp && !activeInsp.folder_id) {
        // 情况1：散灵感悬停在另一个散灵感上 → 合并计时器
        if (overId.startsWith('insp-')) {
          const overInspId = overId.replace('insp-', '')
          const overInsp = inspirations.find((i) => i.id === overInspId)
          if (overInsp && !overInsp.folder_id && activeInspId !== overInspId) {
            startMergeTimer(overInspId)
            setJoinFolderTarget(null)
            return
          }
          // 情况2：散灵感悬停在文件夹内灵感上 → 加入该文件夹
          // 核心修复：折叠文件夹内的灵感虽被 disabled 但仍是碰撞目标，且布局 rect 与散灵感区重叠，
          //          会被 closestCenter 误报为 over。必须校验目标文件夹处于展开态（灵感真实可见）才允许加入。
          if (overInsp && overInsp.folder_id) {
            if (folderExpanded[overInsp.folder_id] && isReallyOver(event, over)) {
              setJoinFolderTarget(overInsp.folder_id)
              clearMergeTimer()
            } else {
              setJoinFolderTarget(null)
            }
            return
          }
        }
        // 情况3：散灵感悬停在文件夹标题行/文件夹上 → 加入该文件夹（需真实重叠）
        if (overId.startsWith('folder-drop-') || overId.startsWith('folder-')) {
          const folderId = overId.startsWith('folder-drop-')
            ? overId.replace('folder-drop-', '')
            : overId.replace('folder-', '')
          if (isReallyOver(event, over)) {
            setJoinFolderTarget(folderId)
            clearMergeTimer()
          } else {
            setJoinFolderTarget(null)
          }
          return
        }
      }
    }

    // 其他情况：清除所有状态
    clearMergeTimer()
    setJoinFolderTarget(null)
  }, [inspirations, folderExpanded, startMergeTimer, clearMergeTimer])

  const handleDragEnd = useCallback((event) => {
    const { active, over } = event
    const dragItem = activeDrag
    setActiveDrag(null)
    clearMergeTimer()
    // joinFolderTarget 仅用于拖拽过程反馈；加入判定以松手时的最终 over + 真实重叠为准
    setJoinFolderTarget(null)

    // ===== 合并创建文件夹 =====
    if (mergeReady && mergeTarget && dragItem?.type === 'inspiration') {
      const targetInsp = inspirations.find((i) => i.id === mergeTarget)
      if (targetInsp) {
        onCreateFolder(dragItem.id, targetInsp.id)
      }
      return
    }

    if (!over) return

    const activeId = active.id
    const overId = over.id

    // ===== 散灵感落到文件夹（标题行/整个文件夹）→ 移入 =====
    // 核心修复：必须真实重叠才移入，避免拖拽“路过”文件夹附近时被 closestCenter 误判
    if (activeId.startsWith('insp-') && (overId.startsWith('folder-drop-') || overId.startsWith('folder-'))) {
      if (isReallyOver(event, over)) {
        const inspId = activeId.replace('insp-', '')
        const folderId = overId.startsWith('folder-drop-')
          ? overId.replace('folder-drop-', '')
          : overId.replace('folder-', '')
        onMoveInspiration(inspId, folderId)
      }
      return
    }

    // ===== 灵感拖到灵感上 =====
    if (activeId.startsWith('insp-') && overId.startsWith('insp-')) {
      const inspId = activeId.replace('insp-', '')
      const overInspId = overId.replace('insp-', '')
      const ins = inspirations.find((i) => i.id === inspId)
      const overInsp = inspirations.find((i) => i.id === overInspId)

      // 落到文件夹内灵感上 → 移入该文件夹
      // 核心修复：同样需校验目标文件夹展开（折叠时其内灵感为隐藏态，rect 与散灵感区重叠，不可信）
      if (overInsp?.folder_id && ins && ins.folder_id !== overInsp.folder_id) {
        if (folderExpanded[overInsp.folder_id] && isReallyOver(event, over)) {
          onMoveInspiration(inspId, overInsp.folder_id)
        }
        return
      }
      // 拖拽项在文件夹内，落到散灵感上 → 散出
      if (ins?.folder_id) {
        onMoveInspiration(inspId, null)
        return
      }
      // 两者都是散灵感 → 排序
      const oldIndex = looseInspirations.findIndex((i) => i.id === inspId)
      const newIndex = looseInspirations.findIndex((i) => i.id === overInspId)
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reordered = arrayMove(looseInspirations, oldIndex, newIndex)
        onReorderItems({
          inspirations: reordered.map((ins, idx) => ({ id: ins.id, sort_order: idx, folder_id: null }))
        })
      }
      return
    }

    // ===== 文件夹之间排序（基于 sortedFolders，与渲染顺序一致，实现挤压+换位） =====
    if (activeId.startsWith('folder-') && overId.startsWith('folder-')) {
      const oldIndex = sortedFolders.findIndex((f) => `folder-${f.id}` === activeId)
      const newIndex = sortedFolders.findIndex((f) => `folder-${f.id}` === overId)
      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reordered = arrayMove(sortedFolders, oldIndex, newIndex)
        onReorderItems({ folders: reordered.map((f, idx) => ({ id: f.id, sort_order: idx })) })
      }
      return
    }
  }, [activeDrag, mergeReady, mergeTarget, inspirations, folderExpanded, sortedFolders, looseInspirations, onMoveInspiration, onReorderItems, onCreateFolder, clearMergeTimer])

  const handleDragCancel = useCallback(() => {
    setActiveDrag(null)
    clearMergeTimer()
    setJoinFolderTarget(null)
  }, [clearMergeTimer])

  // ========== 挤压态 ==========
  if (compressed) {
    return (
      <aside className="h-full w-full flex flex-col items-center py-4 gap-3 border-r border-line/5">
        <button type="button" title="搜索灵感" className="glow-btn w-10 h-10 rounded-xl flex items-center justify-center text-ink/40 hover:text-ink/80 hover:bg-veil/[0.06] transition-all">
          <Search size={16} />
        </button>
        <button type="button" onClick={onNewInspiration} title="新建灵感" className="glow-btn w-10 h-10 rounded-xl flex items-center justify-center text-ink/40 hover:text-ink/80 hover:bg-veil/[0.06] transition-all">
          <Plus size={16} />
        </button>
        <div className="w-6 h-px bg-veil/5 my-1" />
        {inspirations.slice(0, 6).map((ins) => {
          const isSelected = selectedInspiration && ins.id === selectedInspiration.id
          const folder = folders.find((f) => f.id === ins.folder_id)
          const accentColor = folder?.color || 'var(--accent-cyan)'
          return (
            <button
              key={ins.id}
              type="button"
              onClick={() => onSelectInspiration(ins)}
              title={ins.title}
              className={`glow-btn w-10 h-10 rounded-xl flex items-center justify-center text-sm font-medium transition-all relative ${
                isSelected ? 'text-ink/90' : 'text-ink/40 hover:text-ink/80 hover:bg-veil/[0.06]'
              }`}
              style={isSelected ? { background: 'rgb(var(--cyan-rgb) / 0.15)', color: accentColor, boxShadow: `inset 0 0 0 1px ${accentColor}4D` } : undefined}
            >
              {isSelected && <span className="absolute left-0 top-0 bottom-0 w-px" style={{ background: accentColor }} />}
              <span className="truncate">{ins.title?.[0] || '?'}</span>
            </button>
          )
        })}
        {!selectedInspiration && inspirations.length === 0 && (
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-ink/10">
            <Brain size={20} strokeWidth={1.2} />
          </div>
        )}
      </aside>
    )
  }

  // ========== 展开态 ==========
  return (
    <aside className="h-full w-full flex flex-col border-r border-line/5">
      {/* 搜索框：浮动标签输入框（Uiverse cowardly-jellyfish-52 移植）
          结构：input + 图标 + 标签 span 依次排列
          placeholder 设为单个空格，配合 CSS :not(:placeholder-shown)
          检测输入状态，无需引入额外 React 状态
          容器：px-5 左右留白不变，py-3 上下收窄，使搜索区更紧凑 */}
      <div className="px-5 py-3 border-b border-line/5">
        <div className="gal-search">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder=" "
            className="gal-search-input"
          />
          {/* 图标置于 input 之后：CSS 用后续兄弟选择器 :focus ~ .gal-search-icon 做聚焦提亮 */}
          <Search size={16} className="gal-search-icon" />
          <span className="gal-search-label">搜索灵感...</span>
        </div>
      </div>

      {/* 列表区域：搜索模式与普通模式完全解耦 */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {isSearching ? (
          /* ===== 搜索模式：不区分文件夹，全部平铺，禁用拖拽 ===== */
          inspirations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full px-6 py-12 text-center animate-fade-in-up">
              <Brain size={40} className="text-ink/10 mb-4" strokeWidth={1.2} />
              <p className="font-display text-ink/40 text-lg italic">未找到灵感</p>
              <p className="text-ink/25 text-xs mt-2 font-sans">试试其他关键词</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {inspirations.map((ins) => {
                const folder = folders.find((f) => f.id === ins.folder_id)
                return (
                  <InspirationItem
                    key={ins.id}
                    inspiration={ins}
                    isSelected={selectedInspiration?.id === ins.id}
                    folderColor={folder?.color || null}
                    onSelect={onSelectInspiration}
                    isRenaming={renamingId === ins.id}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                    onContextMenu={handleContextMenu}
                  />
                )
              })}
            </div>
          )
        ) : inspirations.length === 0 && folders.length === 0 ? (
          /* ===== 普通模式：空状态 ===== */
          <div className="flex flex-col items-center justify-center h-full px-6 py-12 text-center animate-fade-in-up">
            <Brain size={40} className="text-ink/10 mb-4" strokeWidth={1.2} />
            <p className="font-display text-ink/40 text-lg italic">还没有灵感</p>
            <p className="text-ink/25 text-xs mt-2 font-sans">点击右上角新建第一个灵感</p>
            {/* 使用指南入口：仅在完全无灵感时显示，点击在新标签页打开 PDF */}
            <button
              type="button"
              onClick={() => openExternalLink('./How2Use.pdf')}
              className="text-cyan-400/50 hover:text-cyan-400 text-xs mt-3 font-sans transition-colors"
            >
              使用指南 →
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={folderFirstCollision}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-1.5">
                {/* 文件夹列表（按 sort_order 排序，始终位于散灵感上方；修改4：拖灵感时文件夹不挤压 disableShift） */}
                {sortedFolders.map((folder) => (
                  <FolderItem
                    key={folder.id}
                    folder={folder}
                    isExpanded={!!folderExpanded[folder.id]}
                    isSelected={selectedInspiration?.folder_id === folder.id}
                    inspirations={folderInspirations[folder.id] || []}
                    selectedInspiration={selectedInspiration}
                    onSelectInspiration={onSelectInspiration}
                    onToggleExpand={onToggleFolderExpanded}
                    onEdit={onEditFolder}
                    isJoinTarget={joinFolderTarget === folder.id}
                    isChildDragging={!!(activeDrag?.type === 'inspiration' && activeDrag.folder_id === folder.id)}
                    disableShift={dragType === 'inspiration'}
                    isRenaming={renamingId}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                    onContextMenu={handleContextMenu}
                  />
                ))}

                {/* 分隔线 */}
                {folders.length > 0 && looseInspirations.length > 0 && (
                  <div className="flex items-center gap-2 px-2 py-1">
                    <div className="flex-1 h-px bg-veil/[0.06]" />
                    <span className="text-ink/15 text-[9px] uppercase tracking-widest font-sans">T_T</span>
                    <div className="flex-1 h-px bg-veil/[0.06]" />
                  </div>
                )}

                {/* 散灵感列表（修改4：拖文件夹时散灵感不挤压 disableShift） */}
                {looseInspirations.map((ins) => (
                  <SortableInspirationItem
                    key={ins.id}
                    inspiration={ins}
                    isSelected={selectedInspiration?.id === ins.id}
                    folderColor={null}
                    onSelect={onSelectInspiration}
                    isMergeTarget={mergeTarget === ins.id}
                    isMergeReady={mergeReady && mergeTarget === ins.id}
                    disableShift={dragType === 'folder'}
                    isRenaming={renamingId === ins.id}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                    onContextMenu={handleContextMenu}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {/* 修改3：Windows 风格右键菜单（目前仅“重命名”）
          用 Portal 挂到 document.body，确保 position:fixed 相对视口，不受任何父级影响
          外层 div 负责定位（translateY(-50%) 垂直居中于光标），内层 div 负责动画，避免 transform 冲突 */}
      {contextMenu && createPortal(
        <div
          className="fixed z-[100]"
          style={{
            left: contextMenu.x + 8,
            top: contextMenu.y,
            transform: 'translateY(-50%)'
          }}
        >
          <div
            className="min-w-[140px] rounded-lg border border-line/10 shadow-2xl py-1 animate-fade-in-up"
            style={{
              background: 'rgb(var(--deep2-rgb) / 0.95)',
              backdropFilter: 'blur(20px)'
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={handleStartRename}
              className="w-full text-left px-4 py-2 text-xs text-ink/70 hover:text-ink/95 hover:bg-veil/[0.06] transition-colors font-sans flex items-center gap-2"
            >
              <Pencil size={12} />
              <span>重命名</span>
            </button>
          </div>
        </div>,
        document.body
      )}
    </aside>
  )
}

export default Sidebar
