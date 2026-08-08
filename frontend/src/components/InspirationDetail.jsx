// InspirationDetail 灵感档案馆（K3-d 改造版）
// 功能：作为 Detail 唯一数据源，展示灵感原文 + 三阶段产物（手风琴渐进展示）
// 实现方式：
//   - 从 store 读取 archiveData（由 loadArchive 加载，§9.2 唯一数据源）
//   - 顶部：标题 + 元数据 + 来源
//   - 中部：原文内容
//   - 底部：三个 StageAccordion（结晶/外延/聚合）+ 行动栏（召唤抽屉）
//   - 删除原 Tab 切换（内容/Coalesce/标签），统一为档案馆视图
//
// 架构文档 §5.4 UI 层次模型 + §9.2 ArchiveResponse 契约：
//   - StageAccordion 互斥展开（§10.4 expandedStage）
//   - StageBadge 显示阶段状态（§9.2 badges）
//   - 行动栏召唤工作台抽屉（K3-e 实现，此处预留入口）
import React, { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  Brain, Pencil, Trash2, Clock, FileText, X,
  Sparkles, Link2, AlertCircle, Loader2, Check, Plus, ArrowRight,
  Lightbulb, CheckCircle2, BookOpen, RefreshCw, ChevronRight
} from 'lucide-react'
import { formatTime } from '../services/store.js'
import useStore from '../services/store.js'
// v11 多模态扩展：重试提炼后需刷新单个灵感数据 + 原文浮窗读取文件内容
import { getInspiration, getInspirationFileContent } from '../services/api.js'
import StageBadge from './StageBadge.jsx'
import StageAccordion from './StageAccordion.jsx'
import AddendumSection from './AddendumSection.jsx'
// v11 多模态扩展：自适应高度 textarea（content 编辑框）
import AutoTextArea from './AutoTextArea.jsx'
// K3-g：fragment_type 元信息单一来源（R9 防前后端枚举漂移）
// fix：EpitaxyArchiveContent 只展示已提炼 chunks，chunk 的 kind 标签由 getFragmentKind* 提供
import {
  getFragmentKindColor,
  getFragmentKindLabel
} from '../services/fragmentMeta.js'
// fix3：引入聚合扫描动画（coalesceLoading 时显示）+ 外延联动深挖动画
import { NodeLinkAnim, ExcavateAnim } from './LoadingAnims.jsx'

/**
 * 桥梁类型 → 颜色映射
 * 亮色模式改造：色值单一来源移至 services/themeTokens.js（原与 ForceGraph.jsx 重复定义）
 * Proxy 保持原有 BRIDGE_COLORS[type] 访问方式不变，渲染期按当前主题取值
 */
import { getBridgeColors } from '../services/themeTokens.js'
const BRIDGE_COLORS = new Proxy({}, {
  get: (_, key) => getBridgeColors()[key],
  ownKeys: () => Reflect.ownKeys(getBridgeColors()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
})

/**
 * 桥梁类型中文标签
 */
const BRIDGE_LABELS = {
  imagery_isomorphism:  '意象同构',
  structure_resonance:  '结构共振',
  theme_opposition:     '主题对立'
}

/**
 * 结晶形态中文标签
 */
const CRYSTAL_TYPE_LABELS = {
  prd: '产品需求',
  scene_card: '场景卡',
  worldview: '世界观',
  creative_direction: '创作方向',
  exploration_map: '探索地图',
  character_profile: '人物档案',
  process_card: '流程卡',
  argument_card: '论证卡',  // fix6：历史数据兼容（v6 迁移后新数据不再使用）
  concept_card: '概念卡',  // fix6 新增
  free_note: '自由笔记'
}

/**
 * 结晶字段 key → 中文 label 映射
 * 功能：把 renderFields / 摘要卡片里直接显示的英文 field key 翻译为中文，方便用户阅读
 * 覆盖范围：所有 crystal_type 的字段（含 aesthetic_proposal 的 object 子 key 兜底）
 * 未命中的 key 退回原值，避免漏译时丢字段
 */
const CRYSTAL_FIELD_LABELS = {
  // 通用字段
  title: '标题',
  // 产品需求（prd）
  goal: '目标',
  target_user: '目标用户',
  core_features: '核心功能',
  success_criteria: '成功标准',
  // 场景卡（scene_card）
  setting: '场景设置',
  sensory_detail: '感官细节',
  mood: '情绪基调',
  protagonist: '主角存在',
  moment: '关键瞬间',
  // 世界观（worldview）
  premise: '核心前提',
  rules: '运行规则',
  constraints: '约束边界',
  inhabitants: '居民形态',
  tension: '内在张力',
  // 创作方向（creative_direction）
  emotion: '情感内核',
  imagery: '核心意象',
  rhythm: '节奏韵律',
  theme: '主题表达',
  counterpoint: '反差点',
  // 探索地图（exploration_map）
  question: '核心问题',
  sub_questions: '子问题',
  hypothesis: '初步假设',
  methods: '探究方法',
  sources: '信息来源',
  // 人物档案（character_profile）
  personality: '性格特质',
  background: '背景经历',
  motivation: '核心动机',
  relations: '人际关系',
  voice: '语言风格',
  // 概念卡（concept_card）
  definition: '核心定义',
  distinction: '区分点',
  origin: '概念起源',
  signature_features: '标志性特征',
  applicable_context: '适用场景',
  // 美学提案（aesthetic_proposal）
  core_definition: '核心定义',
  aesthetic_attributes: '美学属性',
  emotional_core: '情感内核',
  differentiation: '差异点',
  cultural_context: '文化语境',
  signature_elements: '标志性元素',
  // 自由笔记（free_note）
  core_idea: '想法核心',
  trigger: '触发情境',
  desired_form: '希望形态',
  next_step: '后续打算'
}

/**
 * AIGeneratedBadge — "AI 生成"小标
 * 功能：在 AI 生成的 title/content 旁边显示徽章，提示用户该字段由 AI 生成待确认
 * 实现方式：cyan 强调色 badge，毛玻璃背景，与现有 StageBadge 风格一致
 */
function AIGeneratedBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full font-sans whitespace-nowrap"
      style={{
        background: 'rgb(var(--cyan-rgb) / 0.15)',
        color: 'var(--accent-cyan-bright)',
        border: '1px solid rgb(var(--cyan-rgb) / 0.2)'
      }}
      title="此内容由 AI 生成，点击接受或编辑"
    >
      <Sparkles size={9} />
      <span>AI 生成</span>
    </span>
  )
}

/**
 * v12：判断灵感是否处于"DISTILL 提炼进行中 / 失败待重试"状态
 * 功能：Detail 轮询触发条件 + 提炼中/失败标记的统一判断
 * 实现方式：
 *   - title === 'Loading'：新建占位（DISTILL 入队但尚未标记 3 的时间窗口）
 *   - title_ai_generated === 3 || content_ai_generated === 3：提炼中（triggerDistill 入队时标记）
 *   - title_ai_generated === 2 || content_ai_generated === 2：提炼失败待重试
 *   - v12 按需提炼：mode='content' 时仅 content 字段为 3/2，title 保持用户值；故两个字段都要判断
 * @param {object} ins - 灵感对象
 * @returns {boolean} 是否需要轮询 / 是否处于非稳态
 */
function isDistillPending(ins) {
  return !!ins && (
    ins.title === 'Loading' ||
    ins.title_ai_generated === 3 || ins.content_ai_generated === 3 ||
    ins.title_ai_generated === 2 || ins.content_ai_generated === 2
  )
}

/**
 * @param {object} props
 * @param {object|null} props.inspiration - 选中的灵感对象；null 表示未选中
 * @param {Function} props.onEdit - 点击"编辑"按钮的回调
 * @param {Function} props.onDelete - 确认删除后的回调
 * @param {Function} [props.onDeselect] - 点击叉号按钮的回调（取消选中回到空状态）
 */
function InspirationDetail({ inspiration, onEdit, onDelete, onDeselect }) {
  // gal-delete-btn 长按删除状态
  // isPressing：是否正在长按（驱动 .gal-pressing 填充动画）
  // pressTimer：长按定时器引用（700ms 到期触发删除，松手则清除）
  const [isPressing, setIsPressing] = useState(false)
  const pressTimer = useRef(null)

  // 从 store 读取档案馆数据与 actions
  const archiveData = useStore((s) => s.archiveData)
  const archiveLoading = useStore((s) => s.archiveLoading)
  const archiveError = useStore((s) => s.archiveError)
  const expandedStage = useStore((s) => s.expandedStage)
  const setExpandedStage = useStore((s) => s.setExpandedStage)

  // Coalesce actions（用于桥梁策展 + 转新灵感）
  const scanCoalesce = useStore((s) => s.scanCoalesce)
  const curateBridge = useStore((s) => s.curateBridge)
  const bridgeToInspiration = useStore((s) => s.bridgeToInspiration)
  const coalesceLoading = useStore((s) => s.coalesceLoading)
  const coalesceError = useStore((s) => s.coalesceError)
  const coalesceStage = useStore((s) => s.coalesceStage)

  // K3-e：抽屉 actions（召唤工作台抽屉）
  const openDrawer = useStore((s) => s.openDrawer)
  const drawerCache = useStore((s) => s.drawerCache)
  // K3-h 修复：coalesceScanSummary 必须在组件顶层调用，不能内联在 JSX props 中
  // 原因：drawer='epitaxy' 时 CoalesceArchiveContent 不渲染，内联 useStore 会被跳过 → hooks 数量不一致
  const coalesceScanSummary = useStore((s) => s.coalesceScanSummary)

  // K4-b 改进点 1：外延联动状态——抽屉打开时，Detail 同步显示对应内容
  // drawer='epitaxy' 时切换为联动视图，根据 epitaxyStage 显示不同内容
  const drawer = useStore((s) => s.drawer)
  const epitaxyStage = useStore((s) => s.epitaxyStage)
  const epitaxySelectedProposal = useStore((s) => s.epitaxySelectedProposal)
  const epitaxyFragments = useStore((s) => s.epitaxyFragments)
  const epitaxySelectedChunks = useStore((s) => s.epitaxySelectedChunks)
  const epitaxyDistilledChunks = useStore((s) => s.epitaxyDistilledChunks)

  // v11 多模态扩展：AI 生成小标 + 内联编辑 + 重试提炼相关状态
  // editingTitle/titleText：标题内联编辑状态
  // editingContent/contentText：内容内联编辑状态
  // accepting/retrying：接受 / 重试提炼按钮的 loading 状态
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleText, setTitleText] = useState('')
  const [editingContent, setEditingContent] = useState(false)
  const [contentText, setContentText] = useState('')
  const [accepting, setAccepting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  // v11 多模态扩展：原文浮窗状态
  // sourceFileModal：null=关闭，{filename, original_name, content, format, size, loading}=加载中/已加载
  const [sourceFileModal, setSourceFileModal] = useState(null)
  // 从 store 获取 updateInspiration（更新灵感字段）和 triggerDistill（触发 DISTILL 任务）
  const updateInspiration = useStore((s) => s.updateInspiration)
  const triggerDistill = useStore((s) => s.triggerDistill)

  /**
   * 打开原文浮窗：点击"展开原文"按钮时调用
   * 功能：异步拉取文件内容，loading 期间先展示元信息，加载完成后填充 content
   * 实现方式：
   *   1. 从 inspiration.source_files 取文件列表
   *   2. 单文件：直接拉取并展示；多文件：先展示列表，点击单个再拉取
   *   3. 异步调用 getInspirationFileContent，失败显示错误信息
   */
  const handleOpenSourceFile = async (filename) => {
    // 先打开浮窗（loading 态）
    setSourceFileModal({ filename, loading: true })
    try {
      const res = await getInspirationFileContent(inspiration.id, filename)
      if (res.success && res.data) {
        setSourceFileModal({
          filename: res.data.filename,
          original_name: res.data.original_name,
          format: res.data.format,
          size: res.data.size,
          content: res.data.content,
          loading: false
        })
      } else {
        setSourceFileModal({ filename, error: res.error || '加载失败', loading: false })
      }
    } catch (err) {
      setSourceFileModal({ filename, error: err.message, loading: false })
    }
  }

  // v11：DISTILL 自动刷新轮询
  // 问题：DISTILL 是后台异步任务（taskQueue），完成后无推送机制，UI 会一直停留在"提炼中"
  // 方案：当 title='Loading'（提炼中/失败待重试）时，每 5 秒拉取一次灵感数据，
  //       完成后通过 useStore.setState 直接更新 selectedInspiration 与列表，实现 UI 自动刷新
  // 实现方式：
  //   - useEffect 依赖 [id, title, title_ai_generated]：title 变化（Loading → 实际标题）时
  //     新 effect 条件不满足直接 return，并清理旧轮询（双保险停止）
  //   - 用递归 setTimeout 而非 setInterval，避免并发重叠
  //   - 用 useStore.setState 直接更新，不触发完整 reset（避免 archive 重载与 UI 闪动）
  useEffect(() => {
    if (!inspiration?.id) return
    // v12：轮询触发条件——提炼进行中（title='Loading' 占位 / ai_generated=3 提炼中）
    // 或失败待重试（ai_generated=2）。按需提炼模式下 content 也可能单独处于提炼中/失败
    if (!isDistillPending(inspiration)) return

    let cancelled = false
    let timer = null

    const poll = async () => {
      if (cancelled) return
      try {
        const res = await getInspiration(inspiration.id)
        const updated = res?.data || res
        if (cancelled || !updated?.id) return
        // 提炼仍未完成（title 还是 Loading / 任一字段仍为 3 或 2）→ 继续轮询；否则停止
        const stillPending = isDistillPending(updated)
        // 静默更新 store：selectedInspiration + 列表项（不触发完整 reset）
        useStore.setState((state) => ({
          selectedInspiration: updated,
          inspirations: state.inspirations.map((ins) =>
            ins.id === updated.id ? updated : ins
          )
        }))
        if (stillPending) {
          timer = setTimeout(poll, 5000)
        }
      } catch (err) {
        // 网络抖动等瞬时错误：不中断轮询，稍后重试
        console.warn('[InspirationDetail] 轮询提炼状态失败:', err.message)
        timer = setTimeout(poll, 5000)
      }
    }

    // 首次轮询延迟 3 秒（给 DISTILL 任务启动留出时间），之后每 5 秒
    timer = setTimeout(poll, 3000)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [inspiration?.id, inspiration?.title, inspiration?.title_ai_generated, inspiration?.content_ai_generated])

  // 未选中灵感：显示空状态（大型 Brain 图标 + 衬线哲学提示）
  if (!inspiration) {
    return (
      <main className="flex-1 flex flex-col items-center justify-center px-8">
        <div className="text-center animate-fade-in-up">
          {/* 大型 Brain 图标：极淡 + 微脉动 */}
          <div className="relative inline-block mb-6">
            <div
              className="absolute inset-0 rounded-full blur-2xl animate-pulse-soft"
              style={{ background: 'rgb(var(--cyan-rgb) / 0.08)' }}
            />
            <Brain
              size={80}
              className="relative text-ink/10"
              strokeWidth={1}
            />
          </div>
          {/* 衬线哲学提示 */}
          <h2 className="font-display text-3xl text-ink/40 italic mb-2">
            思考的旅程，从此处开始
          </h2>
          <p className="text-ink/25 text-sm font-sans">
            从左侧列表中选取一个灵感，或新建一个灵感
          </p>
        </div>
      </main>
    )
  }

  /**
   * gal-delete-btn 长按删除交互
   * 按下：启动 1500ms 定时器 + isPressing=true（触发红色填充动画）
   * 到期：调用 onDelete 执行删除
   * 松手/离开：清除定时器 + isPressing=false（填充回弹，不删除）
   */
  const handleDeletePressStart = () => {
    setIsPressing(true)
    pressTimer.current = setTimeout(() => {
      setIsPressing(false)
      onDelete()
    }, 1500)
  }
  const handleDeletePressEnd = () => {
    setIsPressing(false)
    if (pressTimer.current) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  // v11/v12 多模态扩展：AI 生成状态判断（v12 按需提炼：title/content 可分别处于提炼中/失败）
  // isDistilling: title='Loading' 或任一字段 ai_generated=3（提炼中），禁止编辑
  const isDistilling = inspiration.title === 'Loading' ||
    inspiration.title_ai_generated === 3 || inspiration.content_ai_generated === 3
  // hasAIGenerated: title 或 content 由 AI 生成待确认（ai_generated=1）
  const hasAIGenerated = inspiration.title_ai_generated === 1 || inspiration.content_ai_generated === 1
  // needRetry: 任一字段 DISTILL 提炼失败（ai_generated=2），显示重试按钮（v12 从仅 title 扩展为两字段）
  const needRetry = inspiration.title_ai_generated === 2 || inspiration.content_ai_generated === 2

  // 开始编辑标题：进入内联编辑态，初始化文本
  const startEditTitle = () => {
    if (isDistilling) return
    setTitleText(inspiration.title || '')
    setEditingTitle(true)
  }

  // 保存标题编辑：同时清除 title_ai_generated 标记（用户手动编辑后不再是 AI 生成）
  const saveTitleEdit = async () => {
    const newTitle = titleText.trim()
    setEditingTitle(false)
    if (!newTitle || newTitle === inspiration.title) return
    try {
      await updateInspiration(inspiration.id, {
        title: newTitle,
        title_ai_generated: 0
      })
    } catch (err) {
      console.error('[InspirationDetail] 保存标题失败:', err.message)
    }
  }

  // 开始编辑内容：进入内联编辑态，初始化文本
  const startEditContent = () => {
    if (isDistilling) return
    setContentText(inspiration.content || '')
    setEditingContent(true)
  }

  // 保存内容编辑：同时清除 content_ai_generated 标记
  const saveContentEdit = async () => {
    const newContent = contentText
    setEditingContent(false)
    if (newContent === inspiration.content) return
    try {
      await updateInspiration(inspiration.id, {
        content: newContent,
        content_ai_generated: 0
      })
    } catch (err) {
      console.error('[InspirationDetail] 保存内容失败:', err.message)
    }
  }

  // 接受 AI 生成的内容：清除 title/content 的 ai_generated 标记
  const handleAccept = async () => {
    setAccepting(true)
    try {
      await updateInspiration(inspiration.id, {
        title_ai_generated: 0,
        content_ai_generated: 0
      })
    } catch (err) {
      console.error('[InspirationDetail] 接受失败:', err.message)
    } finally {
      setAccepting(false)
    }
  }

  // 重试提炼：触发 DISTILL 任务并刷新灵感数据
  // 注意：DISTILL 是异步任务，triggerDistill 仅入队，title 可能仍为 'Loading'
  const handleRetryDistill = async () => {
    setRetrying(true)
    try {
      const result = await triggerDistill(inspiration.id)
      if (result && result.success !== false) {
        // 提炼任务已入队，刷新灵感数据获取最新状态
        try {
          const res = await getInspiration(inspiration.id)
          const updated = res?.data || res
          if (updated && updated.id) {
            // 直接更新 store 中的 selectedInspiration 和列表，不触发完整 reset
            useStore.setState((state) => ({
              selectedInspiration: updated,
              inspirations: state.inspirations.map(ins =>
                ins.id === updated.id ? updated : ins
              )
            }))
          }
        } catch (refreshErr) {
          console.warn('[InspirationDetail] 刷新灵感数据失败:', refreshErr.message)
        }
      }
    } catch (err) {
      console.error('[InspirationDetail] 重试提炼失败:', err.message)
    } finally {
      setRetrying(false)
    }
  }

  // K3-g：移除 SOURCE_TYPE_META——来源徽章已删，不再需要
  // 从 archiveData 提取三阶段数据
  const badges = archiveData?.badges || {}
  const crystal = archiveData?.crystal || null
  const epitaxy = archiveData?.epitaxy || { proposals: [] }
  const bridges = archiveData?.bridges || []
  const fingerprintStale = archiveData?.fingerprintStale ?? false

  // 活跃桥梁（pending + confirmed，不含 dismissed）
  const activeBridges = bridges.filter(b => b.status !== 'dismissed')
  const dismissedBridges = bridges.filter(b => b.status === 'dismissed')

  return (
    // 详情主区域：可纵向滚动
    // UI 精修：insp-themed 让该灵感下的发光组件跟随灵感类型色（--insp-glow 由 Workspace 注入）
    <main className="insp-themed flex-1 flex flex-col overflow-y-auto">
      {/* 顶部操作栏：叉号返回 + 编辑 + 删除按钮 */}
      <div className="flex items-center justify-between gap-2 px-10 py-4 border-b border-line/5">
        {/* 左侧：返回初始状态的叉号按钮 */}
        {onDeselect && (
          <button
            type="button"
            onClick={onDeselect}
            className="glow-btn modal-close-btn glass-card flex items-center justify-center w-9 h-9 rounded-lg text-ink/40 text-sm group"
            title="返回初始界面"
          >
            <X size={16} />
          </button>
        )}

        {/* 右侧：编辑 + 删除 */}
        <div className="flex items-center gap-2 ml-auto">
          {/* gal-edit-btn：Uiverse 移植版编辑按钮
              默认 40×40 方形笔图标，hover 展开显示"编辑"文字，点击直接触发编辑
              "编辑"文字由 CSS ::before 渲染，这里只放图标 */}
          <button
            type="button"
            title="编辑"
            className="gal-edit-btn"
            onClick={onEdit}
          >
            {/* 图标容器：hover 时 translateY(60%) 向下移出视图 */}
            <span className="gal-edit-icon">
              <Pencil size={14} />
            </span>
          </button>
          {/* gal-delete-btn：Uiverse smart-emu-83 精确移植版
              默认 50×50 圆形纯图标，hover 展开成胶囊 + 图标下移 + "删除"文字从顶部滑入
              "删除"文字由 CSS ::before 渲染，长按填充由 CSS ::after 承载，这里只放图标 */}
          <button
            type="button"
            title="长按删除"
            className={`gal-delete-btn ${isPressing ? 'gal-pressing' : ''}`}
            onMouseDown={handleDeletePressStart}
            onMouseUp={handleDeletePressEnd}
            onMouseLeave={handleDeletePressEnd}
            onTouchStart={handleDeletePressStart}
            onTouchEnd={handleDeletePressEnd}
          >
            {/* 图标容器：hover 时 translateY(60%) 向下移出视图 */}
            <span className="gal-del-icon">
              <Trash2 size={14} />
            </span>
          </button>
        </div>
      </div>

      {/* 详情内容区：宽 padding 营造呼吸感
          关键：用 inspiration.id 作为 key 触发 animate-fade-in-up，
          切换灵感时整个内容块重新挂载，产生切入动画 */}
      <div
        key={inspiration.id}
        className="flex-1 px-10 py-10 max-w-4xl"
      >
        {/* 加载状态提示 */}
        {archiveLoading && !archiveData && (
          <div className="flex items-center gap-2 text-ink/40 text-xs mb-6 animate-fade-in-up">
            <Loader2 size={12} className="animate-spin" />
            <span>正在加载档案馆数据...</span>
          </div>
        )}

        {/* 错误提示 */}
        {archiveError && (
          <div className="flex items-center gap-2 text-rose-400/80 text-xs mb-6 px-3 py-2 rounded-lg bg-rose-500/5 border border-rose-500/20">
            <AlertCircle size={12} />
            <span>档案馆加载失败：{archiveError}</span>
          </div>
        )}

        {/* 标题：Cormorant Garamond 36px，font-weight 700
            v11 多模态扩展：AI 生成时显示小标 + 提炼中禁止编辑 + 内联编辑 */}
        <div className="flex items-center gap-2 mb-4 animate-fade-in-up flex-wrap">
          {editingTitle ? (
            <input
              autoFocus
              value={titleText}
              onChange={(e) => setTitleText(e.target.value)}
              onBlur={saveTitleEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); saveTitleEdit() }
                if (e.key === 'Escape') { setEditingTitle(false) }
              }}
              className="font-display text-4xl font-bold text-ink leading-tight bg-transparent border-b border-cyan-500/30 outline-none flex-1 min-w-0"
              style={{ letterSpacing: '-0.02em' }}
            />
          ) : (
            <h2
              className={`font-display text-4xl font-bold text-ink leading-tight ${isDistilling ? 'cursor-not-allowed' : 'cursor-text'}`}
              style={{ letterSpacing: '-0.02em' }}
              onClick={() => !isDistilling && startEditTitle()}
              title={isDistilling ? '提炼中，暂不可编辑' : '点击编辑'}
            >
              {inspiration.title}
            </h2>
          )}
          {/* AI 生成小标：title_ai_generated=1 时显示 */}
          {inspiration.title_ai_generated === 1 && <AIGeneratedBadge />}
          {/* 提炼中指示：title='Loading' 时显示 */}
          {isDistilling && (
            <span className="flex items-center gap-1 text-cyan-400/60 text-xs font-sans">
              <Loader2 size={12} className="animate-spin" />
              <span>提炼中</span>
            </span>
          )}
          {/* 提炼失败标记：title_ai_generated=2 时显示 */}
          {needRetry && (
            <span className="flex items-center gap-1 text-rose-400/70 text-xs font-sans">
              <AlertCircle size={12} />
              <span>提炼失败</span>
            </span>
          )}
        </div>

        {/* 元数据行：创建时间 + 更新时间 + 来源类型 + 灵感类型 */}
        <div
          className="flex items-center gap-5 mb-8 text-ink/40 text-xs font-sans animate-fade-in-up"
          style={{ animationDelay: '60ms' }}
        >
          <span className="flex items-center gap-1.5">
            <Clock size={12} />
            <span>创建于 {formatTime(inspiration.created_at)}</span>
          </span>
          {inspiration.updated_at && inspiration.updated_at !== inspiration.created_at && (
            <span className="flex items-center gap-1.5">
              <Pencil size={12} />
              <span>更新于 {formatTime(inspiration.updated_at)}</span>
            </span>
          )}
          {/* K3-g：移除"手动录入"来源徽章——纯展示无功能，违背简朴原则 */}
          {inspiration.inspiration_type && (
            <span className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-cyan-500/10 border border-cyan-500/20">
              <Sparkles size={12} style={{ color: 'var(--accent-cyan-bright)' }} />
              <span style={{ color: 'var(--accent-cyan-bright)' }}>{inspiration.inspiration_type}</span>
            </span>
          )}
        </div>

        {/* 内容：保留换行与空白，行高 1.75 营造阅读舒适度
            v11 多模态扩展：AI 生成时显示小标 + 提炼中禁止编辑 + 内联编辑 */}
        <div
          className="animate-fade-in-up mb-10"
          style={{ animationDelay: '120ms' }}
        >
          {editingContent ? (
            <AutoTextArea
              autoFocus
              value={contentText}
              onChange={(v) => setContentText(v)}
              onBlur={saveContentEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveContentEdit() }
                if (e.key === 'Escape') { setEditingContent(false) }
              }}
              minRows={3}
              maxHeight={600}
              className="text-ink/70 text-[15px] leading-[1.75] w-full bg-transparent border border-cyan-500/20 rounded-lg p-2 outline-none font-sans"
              placeholder="请输入内容..."
            />
          ) : inspiration.content ? (
            <div
              className={`text-ink/70 text-[15px] leading-[1.75] whitespace-pre-wrap font-sans ${isDistilling ? 'cursor-not-allowed' : 'cursor-text'}`}
              onClick={() => !isDistilling && startEditContent()}
              title={isDistilling ? '提炼中，暂不可编辑' : '点击编辑'}
            >
              {inspiration.content}
            </div>
          ) : (
            <p className="font-display text-ink/25 text-lg italic">（暂无内容）</p>
          )}
          {/* AI 生成小标：content_ai_generated=1 时显示 */}
          {inspiration.content_ai_generated === 1 && (
            <div className="mt-2">
              <AIGeneratedBadge />
            </div>
          )}
        </div>

        {/* ========== AI 生成内容操作栏：接受 / 重试提炼 ==========
            v11 多模态扩展：
            - 当 title/content 有 ai_generated=1 时显示"接受"按钮（cyan 强调色）
            - 当 title_ai_generated=2 时显示"重试提炼"按钮（紫色，触发 DISTILL 任务） */}
        {(hasAIGenerated || needRetry) && (
          <div
            className="flex items-center gap-2 mb-8 animate-fade-in-up"
            style={{ animationDelay: '150ms' }}
          >
            {/* 接受按钮：清除 ai_generated 标记，确认 AI 生成内容 */}
            {hasAIGenerated && (
              <button
                type="button"
                onClick={handleAccept}
                disabled={accepting || isDistilling}
                className="glow-btn flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-sans transition-all disabled:opacity-50"
                style={{
                  background: 'rgb(var(--cyan-bright-rgb) / 0.12)',
                  color: 'var(--accent-cyan-bright)',
                  border: '1px solid rgb(var(--cyan-bright-rgb) / 0.25)'
                }}
                title="接受 AI 生成的内容，移除 AI 生成标记"
              >
                {accepting ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                <span>{accepting ? '接受中...' : '接受'}</span>
              </button>
            )}
            {/* 重试提炼按钮：DISTILL 失败后重新触发提炼任务 */}
            {needRetry && (
              <button
                type="button"
                onClick={handleRetryDistill}
                disabled={retrying}
                className="glow-btn flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-sans transition-all disabled:opacity-50"
                style={{
                  background: 'rgba(168,85,247,0.12)',
                  color: 'var(--sem-purple)',
                  border: '1px solid rgba(168,85,247,0.25)'
                }}
                title="重新触发 AI 提炼"
              >
                {retrying ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                <span>{retrying ? '提炼中...' : '重试提炼'}</span>
              </button>
            )}
          </div>
        )}

        {/* ========== 原文文件按钮（v11 多模态扩展）==========
            功能：当灵感含 source_files（新建时拖入的文本文件）时显示一个小按钮
            交互：点击弹出模态浮窗，浮窗内展示文件列表，点击单个文件加载并阅读原文
            样式：仅一个小按钮，无小标题无分隔线，符合简朴原则 */}
        {Array.isArray(inspiration.source_files) && inspiration.source_files.length > 0 && (
          <div className="mb-3 animate-fade-in-up" style={{ animationDelay: '180ms' }}>
            <button
              type="button"
              onClick={() => setSourceFileModal({ files: inspiration.source_files })}
              className="glow-btn glass-card flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ink/60 hover:text-ink/90 text-xs font-medium transition-all group"
              title="查看新建灵感时上传的原文文件"
            >
              <FileText size={13} className="transition-transform group-hover:scale-110" style={{ color: 'var(--accent-cyan)' }} />
              <span>展开原文</span>
              <span className="text-ink/30 text-[11px]">（{inspiration.source_files.length}）</span>
            </button>
          </div>
        )}

        {/* 原文浮窗：sourceFileModal 非空时显示
            状态分支：
              - { files: [...] }：展示文件列表供选择
              - { filename, loading: true }：单个文件加载中
              - { filename, content, ... }：展示原文内容
              - { filename, error }：加载失败 */}
        {sourceFileModal && createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-[rgb(var(--mask-rgb)_/_0.6)] backdrop-blur-md animate-fade-in-up"
            onClick={() => setSourceFileModal(null)}
          >
            <div
              className="glass-card w-full max-w-2xl mx-4 rounded-2xl shadow-2xl overflow-hidden relative"
              style={{
                background: 'rgb(var(--deep2-rgb) / 0.9)',
                boxShadow: '0 20px 60px rgba(0,0,0,0.5), 0 0 0 1px rgb(var(--cyan-rgb) / 0.1)'
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 顶部渐变光带 */}
              <div
                className="absolute top-0 left-0 right-0 h-px"
                style={{ background: 'linear-gradient(90deg, transparent, rgb(var(--cyan-rgb) / 0.5), rgb(var(--amber-rgb) / 0.3), transparent)' }}
              />
              {/* 头部：标题 + 关闭按钮 */}
              <div className="flex items-center justify-between px-6 py-4 border-b border-line/5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <FileText size={16} style={{ color: 'var(--accent-cyan)' }} className="shrink-0" />
                  <h3 className="font-display text-base font-semibold text-ink truncate">
                    {sourceFileModal.content ? sourceFileModal.original_name : '原文文件'}
                  </h3>
                  {sourceFileModal.format && (
                    <span className="text-ink/30 text-[10px] font-mono shrink-0">
                      {sourceFileModal.format.toUpperCase()}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setSourceFileModal(null)}
                  className="glow-btn modal-close-btn p-1.5 rounded-lg text-ink/40 shrink-0"
                >
                  <X size={18} />
                </button>
              </div>

              {/* 主体：按状态分支渲染 */}
              <div className="px-6 py-5 max-h-[70vh] overflow-y-auto">
                {/* 分支 1：文件列表（多文件时点击进入） */}
                {sourceFileModal.files && (
                  <div className="space-y-2">
                    <p className="text-ink/40 text-xs mb-3 font-sans">选择一个文件查看原文：</p>
                    {sourceFileModal.files.map((file) => (
                      <button
                        key={file.filename}
                        type="button"
                        onClick={() => handleOpenSourceFile(file.filename)}
                        className="glow-card w-full flex items-center gap-3 px-4 py-3 rounded-lg glass-card hover:bg-veil/[0.06] transition-all text-left"
                        style={{ borderColor: 'rgb(var(--ink) / 0.05)' }}
                      >
                        <FileText size={14} style={{ color: 'var(--accent-cyan)' }} className="shrink-0" />
                        <div className="flex-1 min-w-0">
                          <p className="text-ink/80 text-sm font-sans truncate">
                            {file.original_name || file.originalName || file.filename}
                          </p>
                          <p className="text-ink/30 text-[10px] font-sans mt-0.5">
                            {(file.format || (file.original_name || '').split('.').pop() || '').toUpperCase()}
                            {file.size ? ` · ${(file.size / 1024).toFixed(1)} KB` : ''}
                          </p>
                        </div>
                        <ChevronRight size={14} className="text-ink/30 shrink-0" />
                      </button>
                    ))}
                  </div>
                )}

                {/* 分支 2：加载中 */}
                {sourceFileModal.loading && (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 size={20} className="animate-spin text-ink/40" />
                    <span className="ml-3 text-ink/40 text-sm font-sans">加载原文中...</span>
                  </div>
                )}

                {/* 分支 3：加载失败 */}
                {sourceFileModal.error && (
                  <div className="flex flex-col items-center justify-center py-12 gap-2">
                    <AlertCircle size={20} className="text-rose-400/70" />
                    <p className="text-rose-400/70 text-sm font-sans">{sourceFileModal.error}</p>
                  </div>
                )}

                {/* 分支 4：展示原文内容 */}
                {sourceFileModal.content && (
                  <pre className="text-ink/70 text-sm leading-[1.7] whitespace-pre-wrap font-mono break-words">
                    {sourceFileModal.content}
                  </pre>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

        {/* ========== 追加思考（时间线日志）========== */}
        <AddendumSection inspirationId={inspiration.id} />

        {/* ========== 三阶段档案馆（手风琴渐进展示）==========
            K4-b 改进点 1：当 drawer='epitaxy' 时切换为外延联动视图
            联动视图根据 epitaxyStage 显示对应内容，避免抽屉与 Detail 内容重复 */}
        {drawer === 'epitaxy' ? (
          <EpitaxyLinkedView
            inspiration={inspiration}
            crystal={crystal}
            epitaxyStage={epitaxyStage}
            selectedProposal={epitaxySelectedProposal}
            fragments={epitaxyFragments}
            selectedChunks={epitaxySelectedChunks}
            distilledChunks={epitaxyDistilledChunks}
          />
        ) : (
        <div
          className="space-y-3 animate-fade-in-up"
          style={{ animationDelay: '180ms' }}
        >
          {/* 阶段标题 */}
          <div className="flex items-center gap-2 mb-4">
            <div className="h-px flex-1 bg-veil/5" />
            <span className="text-ink/30 text-[11px] uppercase tracking-widest font-sans px-3">
              阶段档案
            </span>
            <div className="h-px flex-1 bg-veil/5" />
          </div>

          {/* 结晶阶段（Crystallize） */}
          <StageAccordion
            stage="crystal"
            badgeStage="crystallize"
            state={badges.crystallize?.state || 'none'}
            expanded={expandedStage === 'crystal'}
            onToggle={() => setExpandedStage('crystal')}
          >
            <CrystallizeArchiveContent
              crystal={crystal}
              inspirationType={inspiration.inspiration_type}
            />
          </StageAccordion>

          {/* 外延阶段（Epitaxy） */}
          <StageAccordion
            stage="epitaxy"
            badgeStage="epitaxy"
            state={badges.epitaxy?.state || 'none'}
            meta={{
              fragmentCount: badges.epitaxy?.fragmentCount || 0,
              chunkCount: badges.epitaxy?.chunkCount || 0
            }}
            expanded={expandedStage === 'epitaxy'}
            onToggle={() => setExpandedStage('epitaxy')}
          >
            <EpitaxyArchiveContent
              proposals={epitaxy.proposals || []}
              chunkCount={badges.epitaxy?.chunkCount || 0}
            />
          </StageAccordion>

          {/* 聚合阶段（Coalesce） */}
          <StageAccordion
            stage="bridges"
            badgeStage="coalesce"
            state={badges.coalesce?.state || 'unscanned'}
            meta={{
              bridgeCount: badges.coalesce?.bridgeCount || 0,
              confirmedCount: badges.coalesce?.confirmedCount || 0
            }}
            expanded={expandedStage === 'bridges'}
            onToggle={() => setExpandedStage('bridges')}
          >
            <CoalesceArchiveContent
              inspiration={inspiration}
              bridges={bridges}
              activeBridges={activeBridges}
              dismissedBridges={dismissedBridges}
              fingerprintStale={fingerprintStale}
              coalesceStage={coalesceStage}
              coalesceLoading={coalesceLoading}
              coalesceError={coalesceError}
              coalesceScanSummary={coalesceScanSummary}
              onScan={() => scanCoalesce(inspiration.id)}
              onCurate={(bridgeId, action) => curateBridge(inspiration.id, bridgeId, action)}
              onToInspiration={(bridgeId) => bridgeToInspiration(bridgeId)}
            />
          </StageAccordion>
        </div>
        )}

        {/* ========== 行动栏：召唤工作台抽屉（K3-e 实现）==========
            规则：
            - 结晶台：未结晶显示"召唤结晶台"；已结晶显示"重新结晶"；有中间态显示"接着干"
            - 外延台：必须先完成结晶才能召唤；已 distilled 显示"重新外延"；有中间态显示"接着干" */}
        <div
          className="mt-8 pt-6 border-t border-line/5 animate-fade-in-up"
          style={{ animationDelay: '240ms' }}
        >
          <p className="text-ink/30 text-[11px] mb-3 uppercase tracking-widest font-sans">
            行动栏
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {/* 召唤结晶台：根据 crystallize 徽章状态切换文案 */}
            {(() => {
              const cState = badges.crystallize?.state || 'none'
              const cached = drawerCache[inspiration.id]
              const hasCrystallizeCache = cached?.kind === 'crystallize'
              let label = '召唤结晶台'
              if (hasCrystallizeCache) label = '接着干结晶'
              else if (cState === 'done') label = '重新结晶'
              return (
                <button
                  type="button"
                  onClick={() => openDrawer('crystallize', inspiration.id)}
                  className="glow-btn glass-card flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ink/60 hover:text-ink/90 text-xs transition-all group"
                  title={hasCrystallizeCache ? '恢复上次未完成的结晶草稿' : (cState === 'done' ? '重新生成结晶体（将覆盖现有）' : '召唤灵感结晶工作台')}
                >
                  <Sparkles size={12} className="transition-transform group-hover:scale-110" style={{ color: hasCrystallizeCache ? 'var(--accent-amber)' : 'var(--accent-cyan)' }} />
                  <span>{label}</span>
                  {hasCrystallizeCache && (
                    <span className="ml-1 px-1.5 py-0.5 rounded text-[9px]" style={{ background: 'rgb(var(--amber-rgb) / 0.15)', color: 'var(--accent-amber)' }}>草稿</span>
                  )}
                </button>
              )
            })()}

            {/* 召唤外延台（K3-g 改造：始终允许，不再强制需先结晶） */}
            {/* 用户自主决定是否在结晶前外延；区分"已完成/未完成/接着完成"文案 */}
            {(() => {
              const eState = badges.epitaxy?.state || 'none'
              const cached = drawerCache[inspiration.id]
              const hasEpitaxyCache = cached?.kind === 'epitaxy'

              let label = '召唤外延台'
              if (hasEpitaxyCache) label = '接着干外延'
              else if (eState === 'distilled' || eState === 'excavated') label = '重新外延'

              return (
                <button
                  type="button"
                  onClick={() => openDrawer('epitaxy', inspiration.id)}
                  className="glow-btn glass-card flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ink/60 hover:text-ink/90 text-xs transition-all group"
                  data-glow="purple"
                  title={hasEpitaxyCache ? '恢复上次未完成的外延草稿' : '召唤外延探究工作台'}
                >
                  <FileText size={12} className="transition-transform group-hover:scale-110" style={{ color: hasEpitaxyCache ? 'var(--accent-amber)' : '#a855f7' }} />
                  <span>{label}</span>
                  {hasEpitaxyCache && (
                    <span className="ml-1 px-1.5 py-0.5 rounded text-[9px]" style={{ background: 'rgb(var(--amber-rgb) / 0.15)', color: 'var(--accent-amber)' }}>草稿</span>
                  )}
                </button>
              )
            })()}
          </div>
        </div>

        {/* 来源信息：存在 source_url 时展示 */}
        {inspiration.source_url && (
          <div
            className="mt-10 pt-6 border-t border-line/5 animate-fade-in-up"
            style={{ animationDelay: '300ms' }}
          >
            <p className="text-ink/30 text-[11px] mb-2 uppercase tracking-widest font-sans">来源</p>
            <div className="flex items-center gap-2 text-sm">
              <span
                className="text-accent-400 break-all font-sans"
                style={{ color: 'var(--accent-cyan-bright)' }}
              >
                {inspiration.source_url}
              </span>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}

/**
 * 结晶档案内容（CrystallizeArchiveContent，K4 改造）
 * 功能：展示结晶体字段（按 crystalType 不同的字段结构）+ K4 新增徽章/元字段/_supplement
 * 实现方式：
 *   - 顶部 renderBadges：类型徽章 / 胶囊徽章 / archetype 徽章 / concept_orientation 徽章
 *   - 中部 renderFields：动态渲染 crystal.fields，跳过元字段（在独立区块渲染）
 *   - 底部 renderMetaFields：composable_with / follow_up_questions / _supplement
 */
/**
 * EditableField — 档案馆字段内联编辑子组件
 * 功能：在 Detail 面板展示 crystal 字段，点击切换到编辑态，失焦/回车保存
 * 实现方式：
 *   - 本地 editing/local 状态，进入编辑态时按字段类型初始化文本
 *   - 文本字段：textarea（多行）
 *   - 数组字段：textarea，每行一项，保存时 split('\n') 去空行
 *   - 对象字段：textarea，每行 "key: value"，保存时解析回对象
 *   - 保存时调用 onSave(key, newValue)，失败由调用方处理
 */
function EditableField({ fieldKey, label, value, onSave }) {
  const [editing, setEditing] = useState(false)
  const [local, setLocal] = useState('')

  // 进入编辑态：按字段类型把 value 序列化为可编辑文本
  const startEdit = () => {
    let text = ''
    const isArray = Array.isArray(value)
    const isObject = value && typeof value === 'object' && !isArray
    if (isArray) {
      text = value.map(v => typeof v === 'string' ? v : JSON.stringify(v)).join('\n')
    } else if (isObject) {
      // 对象按 "key: value" 多行格式（与 CrystallizePanel 一致）
      text = Object.entries(value)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\n')
    } else {
      text = typeof value === 'string' ? value : JSON.stringify(value)
    }
    setLocal(text)
    setEditing(true)
  }

  // 保存并退出编辑态：按字段类型把文本解析回原结构
  const save = () => {
    let newValue
    const isArray = Array.isArray(value)
    const isObject = value && typeof value === 'object' && !isArray
    if (isArray) {
      // 每行一项，去空行
      newValue = local.split('\n').map(s => s.trim()).filter(Boolean)
    } else if (isObject) {
      // 解析 "key: value" 多行
      const obj = {}
      local.split('\n').forEach(line => {
        const m = line.match(/^([^:]+):\s*(.*)$/)
        if (m) {
          const k = m[1].trim()
          const v = m[2].trim()
          // 逗号分隔的数组
          obj[k] = v.includes(',') ? v.split(',').map(s => s.trim()).filter(Boolean) : v
        }
      })
      newValue = obj
    } else {
      newValue = local
    }
    setEditing(false)
    onSave(fieldKey, newValue)
  }

  const isArray = Array.isArray(value)
  const isObject = value && typeof value === 'object' && !isArray

  return (
    <div className="space-y-1">
      <p className="text-ink/40 text-[11px] tracking-wider font-sans">{label}</p>
      {editing ? (
        <textarea
          autoFocus
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            // Ctrl/Cmd+Enter 保存（避免多行回车冲突）
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              save()
            }
          }}
          rows={Math.min(8, Math.max(2, local.split('\n').length))}
          className="input-accent w-full rounded-lg px-2.5 py-2 text-xs text-ink/85 outline-none resize-none font-sans leading-relaxed"
          placeholder={isArray ? '每行一项' : isObject ? '每行 "key: value"' : '请输入...'}
        />
      ) : (
        // 展示态：点击进入编辑，cursor-pointer + hover 高亮提示可编辑
        <div
          role="button"
          tabIndex={0}
          onClick={startEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              startEdit()
            }
          }}
          className="glow-card glow-text cursor-pointer hover:bg-veil/[0.02] rounded-md px-1 -mx-1 py-0.5 transition-colors"
          title="点击编辑"
        >
          {isArray ? (
            value.length === 0 ? (
              <p className="text-ink/25 text-sm font-sans italic">（空，点击编辑）</p>
            ) : (
              <ul className="space-y-1">
                {value.map((item, idx) => (
                  <li
                    key={idx}
                    className="text-ink/70 text-sm font-sans leading-relaxed flex items-start gap-2"
                  >
                    <span
                      className="inline-block w-1 h-1 rounded-full mt-2 flex-shrink-0"
                      style={{ background: 'rgb(var(--cyan-bright-rgb) / 0.6)' }}
                    />
                    <span>{typeof item === 'string' ? item : JSON.stringify(item)}</span>
                  </li>
                ))}
              </ul>
            )
          ) : isObject ? (
            Object.keys(value).length === 0 ? (
              <p className="text-ink/25 text-sm font-sans italic">（空，点击编辑）</p>
            ) : (
              <ul className="space-y-1">
                {Object.entries(value).map(([k, v], idx) => (
                  <li
                    key={idx}
                    className="text-ink/70 text-sm font-sans leading-relaxed flex items-start gap-2"
                  >
                    <span
                      className="inline-block w-1 h-1 rounded-full mt-2 flex-shrink-0"
                      style={{ background: 'rgba(168,85,247,0.6)' }}
                    />
                    <span>
                      <span className="text-ink/50">{CRYSTAL_FIELD_LABELS[k] || k}：</span>
                      {Array.isArray(v) ? v.join('、') : String(v)}
                    </span>
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="text-ink/70 text-sm font-sans whitespace-pre-wrap leading-relaxed">
              {typeof value === 'string' && value ? value : (
                <span className="text-ink/25 italic">（空，点击编辑）</span>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 结晶档案内容（CrystallizeArchiveContent）
 * 功能：展示结晶体字段，支持内联编辑（点击字段文本切换编辑态）
 * 实现方式：
 *   - 顶部 renderBadges：类型/胶囊/archetype/concept_type 徽章（只读）
 *   - 中部 renderFields：动态渲染 crystal.fields，跳过元字段，每个字段用 EditableField 包装
 *   - 底部 renderMetaFields：composable_with / follow_up_questions / _supplement（AI 推断，只读）
 */
function CrystallizeArchiveContent({ crystal, inspirationType }) {
  // 从 store 读取 updateArchiveCrystalField action（Detail 内联编辑用）
  const updateArchiveCrystalField = useStore((s) => s.updateArchiveCrystalField)
  // 编辑错误提示
  const [editError, setEditError] = useState(null)

  if (!crystal || !crystal.fields || Object.keys(crystal.fields).length === 0) {
    return (
      <p className="text-ink/30 text-sm font-sans italic">
        尚未结晶。点击下方"召唤结晶台"开始结构化提炼。
      </p>
    )
  }

  // K4 新增：顶部徽章渲染（类型/胶囊/archetype/concept_orientation）
  const renderBadges = () => (
    <div className="flex items-center flex-wrap gap-2 mb-3">
      {/* 类型徽章 */}
      {crystal.crystalType && (
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-sans"
          style={{ background: 'rgb(var(--cyan-rgb) / 0.12)', color: 'var(--accent-cyan-bright)', border: '1px solid rgb(var(--cyan-rgb) / 0.25)' }}
        >
          {CRYSTAL_TYPE_LABELS[crystal.crystalType] || crystal.crystalType}
        </span>
      )}
      {/* 胶囊徽章：detected_capsule 数组非空时展示第一个胶囊名 */}
      {crystal.detected_capsule && crystal.detected_capsule.length > 0 && (
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-sans"
          style={{ background: 'rgba(168,85,247,0.12)', color: 'var(--sem-purple)', border: '1px solid rgba(168,85,247,0.25)' }}
        >
          📦 {crystal.detected_capsule[0]}
        </span>
      )}
      {/* archetype 徽章（角色人物类型，AI 推断） */}
      {crystal.fields?.archetype && (
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-sans"
          style={{ background: 'rgb(var(--amber-rgb) / 0.12)', color: 'var(--accent-amber)', border: '1px solid rgb(var(--amber-rgb) / 0.25)' }}
        >
          {crystal.fields.archetype}
        </span>
      )}
      {/* fix6：concept_type 徽章（概念类型，5 种之一：实体/属性/关系/过程/范式）
          从 crystal.fields.concept_type 读取（如果存在），用于直观展示概念分类 */}
      {crystal.fields?.concept_type && (
        <span
          className="px-2 py-0.5 rounded-full text-[10px] font-sans"
          style={{ background: 'rgba(168,85,247,0.12)', color: '#a855f7', border: '1px solid rgba(168,85,247,0.25)' }}
        >
          {crystal.fields.concept_type}
        </span>
      )}
      {/* fix6：删除 concept_orientation 徽章（概念类型不再使用 concept_orientation 字段）
          历史数据中的 concept_orientation 字段保留但不再展示 */}
    </div>
  )

  // K4 新增：动态字段渲染（跳过元字段，元字段在独立区块渲染）
  // 元字段列表：composable_with / follow_up_questions / _supplement / archetype / detected_capsule / selected_dimensions
  // fix6 新增：evolution（概念的演化方向，LLM 推断）
  const META_FIELD_KEYS = ['composable_with', 'follow_up_questions', '_supplement', 'archetype', 'detected_capsule', 'selected_dimensions', 'evolution', 'concept_type']
  const renderFields = () => {
    const fields = crystal.fields || {}
    return Object.entries(fields)
      .filter(([key]) => !META_FIELD_KEYS.includes(key))
      .map(([key, value]) => {
        // extensions 是 object 时跳过（由 renderMetaFields 处理，避免重复）
        if (key === 'extensions' && value && typeof value === 'object' && !Array.isArray(value)) {
          return null
        }
        // 用 EditableField 包装，支持点击编辑
        return (
          <EditableField
            key={key}
            fieldKey={key}
            label={CRYSTAL_FIELD_LABELS[key] || key}
            value={value}
            onSave={async (fieldKey, newValue) => {
              try {
                setEditError(null)
                await updateArchiveCrystalField(fieldKey, newValue)
              } catch (err) {
                setEditError(`保存失败：${err.message}`)
              }
            }}
          />
        )
      })
  }

  // K4 新增：元字段渲染（composable_with / follow_up_questions / _supplement）
  const renderMetaFields = () => {
    const fields = crystal.fields || {}
    return (
      <>
        {/* composable_with（创作素材的组合建议，AI 推断） */}
        {fields.composable_with && (
          <div className="mt-4 pt-3 border-t border-line/5">
            <p className="text-ink/40 text-[11px] uppercase tracking-wider font-sans mb-2">组合建议（AI 推断）</p>
            {Array.isArray(fields.composable_with.suggestions) && fields.composable_with.suggestions.length > 0 ? (
              <ul className="space-y-1">
                {fields.composable_with.suggestions.map((sug, idx) => (
                  <li
                    key={idx}
                    className="text-ink/70 text-sm font-sans leading-relaxed flex items-start gap-2"
                  >
                    <span
                      className="inline-block w-1 h-1 rounded-full mt-2 flex-shrink-0"
                      style={{ background: 'rgba(168,85,247,0.6)' }}
                    />
                    <span>{sug}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink/60 text-sm font-sans leading-relaxed">
                {typeof fields.composable_with === 'string' ? fields.composable_with : JSON.stringify(fields.composable_with)}
              </p>
            )}
          </div>
        )}

        {/* follow_up_questions（研究好奇的延伸/平行问题，AI 推断） */}
        {fields.follow_up_questions && (
          <div className="mt-4 pt-3 border-t border-line/5">
            {Array.isArray(fields.follow_up_questions.extensions) && fields.follow_up_questions.extensions.length > 0 && (
              <>
                <p className="text-ink/40 text-[11px] uppercase tracking-wider font-sans mb-2">延伸问题（AI 推断）</p>
                <ul className="space-y-1 mb-3">
                  {fields.follow_up_questions.extensions.map((q, idx) => (
                    <li
                      key={idx}
                      className="text-ink/70 text-sm font-sans leading-relaxed flex items-start gap-2"
                    >
                      <span
                        className="inline-block w-1 h-1 rounded-full mt-2 flex-shrink-0"
                        style={{ background: 'rgba(168,85,247,0.6)' }}
                      />
                      <span>{q}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {Array.isArray(fields.follow_up_questions.parallels) && fields.follow_up_questions.parallels.length > 0 && (
              <>
                <p className="text-ink/40 text-[11px] uppercase tracking-wider font-sans mb-2">平行问题（AI 推断）</p>
                <ul className="space-y-1">
                  {fields.follow_up_questions.parallels.map((q, idx) => (
                    <li
                      key={idx}
                      className="text-ink/70 text-sm font-sans leading-relaxed flex items-start gap-2"
                    >
                      <span
                        className="inline-block w-1 h-1 rounded-full mt-2 flex-shrink-0"
                        style={{ background: 'rgba(168,85,247,0.6)' }}
                      />
                      <span>{q}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {/* _supplement（所有类型的用户补充说明，选做） */}
        {fields._supplement && (
          <div className="mt-4 pt-3 border-t border-line/5">
            <p className="text-ink/40 text-[11px] uppercase tracking-wider font-sans mb-2">用户补充</p>
            <p className="text-ink/70 text-sm font-sans whitespace-pre-wrap leading-relaxed">
              {fields._supplement}
            </p>
          </div>
        )}

        {/* extensions（美学提案的演化/组合建议，AI 推断）
            K4-a 新增：仅当 extensions 是对象（含 variations/combinations）时渲染
            概念命题的 extensions 是字符串"延伸命题"，会在 renderFields 中当普通字段渲染，与此处互斥 */}
        {fields.extensions && typeof fields.extensions === 'object' && !Array.isArray(fields.extensions) && (
          <div className="mt-4 pt-3 border-t border-line/5">
            {Array.isArray(fields.extensions.variations) && fields.extensions.variations.length > 0 && (
              <>
                <p className="text-ink/40 text-[11px] uppercase tracking-wider font-sans mb-2">变体方向（AI 推断）</p>
                <ul className="space-y-1 mb-3">
                  {fields.extensions.variations.map((v, idx) => (
                    <li
                      key={idx}
                      className="text-ink/70 text-sm font-sans leading-relaxed flex items-start gap-2"
                    >
                      <span
                        className="text-ink/40 mt-1.5 flex-shrink-0"
                        style={{ width: 4, height: 4, borderRadius: '50%', background: '#a855f7', display: 'inline-block' }}
                      />
                      <span>{v}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {Array.isArray(fields.extensions.combinations) && fields.extensions.combinations.length > 0 && (
              <>
                <p className="text-ink/40 text-[11px] uppercase tracking-wider font-sans mb-2">组合建议（AI 推断）</p>
                <ul className="space-y-1">
                  {fields.extensions.combinations.map((c, idx) => (
                    <li
                      key={idx}
                      className="text-ink/70 text-sm font-sans leading-relaxed flex items-start gap-2"
                    >
                      <span
                        className="text-ink/40 mt-1.5 flex-shrink-0"
                        style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--accent-cyan)', display: 'inline-block' }}
                      />
                      <span>{c}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}

        {/* evolution（概念的演化方向，AI 推断）
            fix6 新增：仅当 evolution 是对象（含 directions 数组）时渲染
            directions 取值：proposition（命题）/ product（产品）/ aesthetic（美学）/ methodology（方法论） */}
        {fields.evolution && typeof fields.evolution === 'object' && !Array.isArray(fields.evolution) && (
          <div className="mt-4 pt-3 border-t border-line/5">
            {Array.isArray(fields.evolution.directions) && fields.evolution.directions.length > 0 && (
              <>
                <p className="text-ink/40 text-[11px] uppercase tracking-wider font-sans mb-2">演化可能（AI 推断）</p>
                <div className="flex flex-wrap gap-1.5">
                  {fields.evolution.directions.map((d, idx) => {
                    // 演化方向中文映射
                    const directionLabels = {
                      proposition: '命题',
                      product: '产品',
                      aesthetic: '美学',
                      methodology: '方法论'
                    }
                    const label = directionLabels[d] || d
                    return (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded-full text-[10px] font-sans"
                        style={{ background: 'rgba(168,85,247,0.12)', color: '#a855f7', border: '1px solid rgba(168,85,247,0.25)' }}
                      >
                        {label}
                      </span>
                    )
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </>
    )
  }

  return (
    <div className="space-y-3">
      {renderBadges()}
      {/* 编辑失败提示 */}
      {editError && (
        <div className="flex items-center gap-2 text-rose-400/80 text-xs px-3 py-2 rounded-lg bg-rose-500/5 border border-rose-500/20">
          <AlertCircle size={12} />
          <span>{editError}</span>
        </div>
      )}
      {renderFields()}
      {renderMetaFields()}
    </div>
  )
}

/**
 * 外延档案内容（EpitaxyArchiveContent，K3-g 改造 + fix）
 * 功能：只展示用户提炼过的成果（chunks），按方向分组
 *   - 方向卡片：只显示含有已提炼 chunks 的方向（被浏览但没提炼的方向不进档案）
 *   - 展开后：直接平铺该方向下所有已提炼的词块（不再按 fragment 分层，避免暴露未提炼的 fragment）
 *   - chunk 上的 kind 标签来自其源 fragment_type，足以标识来源类型
 * 实现方式：
 *   - 用本地 useState 管理方向展开状态（互斥手风琴已在 StageAccordion 处理）
 *   - distilledProposals = proposals 过滤掉无 chunks 的方向 + flatMap 聚合 chunks
 * 原则：Detail 是成果档案馆，只沉淀用户选词保存过的产物；未提炼的 fragment 不展示
 * @param {object} props
 * @param {Array} props.proposals - 已深挖/已提炼的方向列表（每项含 fragments[]，每个 fragment 含 chunks[]）
 * @param {number} props.chunkCount - 总词块数（用于空态判断）
 */
function EpitaxyArchiveContent({ proposals, chunkCount }) {
  // 展开的 proposal id（互斥：一次只展开一个方向）
  const [expandedProposal, setExpandedProposal] = useState(null)

  // fix：Detail 只展示"提炼后的成果"
  // 过滤掉没有 chunks 的方向 + 聚合每个方向下所有 fragment 的 chunks
  // 被浏览但没被用户选词提炼的 fragment 不进档案
  const distilledProposals = proposals
    .map(p => ({
      ...p,
      // 聚合该方向下所有已提炼的 chunks（跨 fragment 平铺）
      distilledChunks: (p.fragments || []).flatMap(f => f.chunks || [])
    }))
    .filter(p => p.distilledChunks.length > 0)

  if (distilledProposals.length === 0) {
    return (
      <p className="text-ink/30 text-sm font-sans italic">
        尚未提炼词块。在外延台中深挖方向并选词保存后，提炼的成果会沉淀到这里。
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {/* 顶部统计：只显示已提炼词块数 */}
      <div className="flex items-center gap-3 text-xs">
        <span className="text-ink/40">已提炼词块：{chunkCount} 个</span>
      </div>

      {/* 方向卡片列表（只含已提炼 chunks 的方向） */}
      {distilledProposals.map((p, idx) => {
        const isExpanded = expandedProposal === p.id
        const chunkTotal = p.distilledChunks.length

        return (
          <div
            key={p.id || idx}
            className="rounded-lg border transition-all"
            style={{
              background: isExpanded ? 'rgb(var(--ink) / 0.04)' : 'rgb(var(--ink) / 0.02)',
              borderColor: isExpanded ? 'rgba(16,185,129,0.2)' : 'rgb(var(--ink) / 0.05)'
            }}
          >
            {/* 方向头部（可点击展开看已提炼的 chunks） */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setExpandedProposal(isExpanded ? null : p.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setExpandedProposal(isExpanded ? null : p.id)
                }
              }}
              className="glow-card flex items-center justify-between px-3 py-2.5 cursor-pointer hover:bg-veil/[0.02] transition-colors select-none rounded-xl"
            >
              <div className="flex-1 min-w-0">
                <p className="text-ink/80 text-sm font-sans font-medium truncate">
                  {p.title || p.direction || '未命名方向'}
                </p>
                {p.reasoning && !isExpanded && (
                  <p className="text-ink/40 text-[11px] mt-0.5 truncate font-sans">
                    {p.reasoning}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                {/* 词块数徽章：绿色，表示已提炼的成果 */}
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-sans"
                  style={{ color: '#10b981', background: 'rgba(16,185,129,0.1)' }}
                >
                  {chunkTotal} 词块
                </span>
              </div>
            </div>

            {/* 展开后：直接平铺该方向下所有已提炼的 chunks（不再按 fragment 分层） */}
            {isExpanded && (
              <div className="px-3 pb-3 pt-1 space-y-1.5 animate-fade-in-up">
                {p.distilledChunks.map((c, cIdx) => {
                  const kindColor = getFragmentKindColor(c.kind)
                  const kindLabel = getFragmentKindLabel(c.kind)
                  return (
                    <div
                      key={c.id || cIdx}
                      className="px-2 py-1.5 rounded font-sans"
                      style={{
                        background: `${kindColor}08`,
                        border: `1px solid ${kindColor}20`
                      }}
                    >
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span
                          className="text-[9px] px-1 py-0.5 rounded"
                          style={{ background: `${kindColor}20`, color: kindColor }}
                        >
                          {kindLabel}
                        </span>
                        {c.subkind && (
                          <span className="text-ink/40 text-[9px]">· {c.subkind}</span>
                        )}
                      </div>
                      <p className="text-ink/65 text-[11px] leading-relaxed">
                        {c.chunkText || c.originalText}
                      </p>
                      {c.userNote && (
                        <p className="text-ink/35 text-[10px] italic mt-1">
                          注：{c.userNote}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 聚合档案内容（CoalesceArchiveContent）
 * 功能：展示桥梁列表 + 扫描按钮 + 策展操作
 */
function CoalesceArchiveContent({
  inspiration, bridges, activeBridges, dismissedBridges,
  fingerprintStale, coalesceStage, coalesceLoading, coalesceError,
  coalesceScanSummary, onScan, onCurate, onToInspiration
}) {
  // 扫描完成但无新桥梁时显示提示（让用户知道扫描确实执行了，不是没反应）
  const showNoNewBridges = coalesceStage === 'done' && coalesceScanSummary
    && (coalesceScanSummary.newBridges?.length || 0) === 0
    && (coalesceScanSummary.candidateCount || 0) === 0

  return (
    <div className="space-y-3">
      {/* 顶部：扫描按钮 + 状态提示 */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          <span className="text-ink/40">活跃桥梁：{activeBridges.length}</span>
          {dismissedBridges.length > 0 && (
            <span className="text-ink/30">已忽略：{dismissedBridges.length}</span>
          )}
        </div>
        <button
          type="button"
          onClick={onScan}
          disabled={coalesceLoading}
          className="glow-btn flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-sans transition-all disabled:opacity-50"
          style={{
            background: 'rgb(var(--cyan-bright-rgb) / 0.1)',
            color: 'var(--accent-cyan-bright)',
            border: '1px solid rgb(var(--cyan-bright-rgb) / 0.2)'
          }}
        >
          {coalesceLoading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Sparkles size={12} />
          )}
          <span>{coalesceLoading ? '扫描中...' : '扫描桥梁'}</span>
        </button>
      </div>

      {/* 扫描完成提示：无新桥梁时让用户知道扫描已执行 */}
      {showNoNewBridges && !coalesceLoading && (
        <div className="flex items-center gap-1.5 text-xs text-ink/50 px-2 py-1.5 rounded-md bg-veil/[0.02] border border-line/5 animate-fade-in-up">
          <CheckCircle2 size={11} style={{ color: 'rgb(var(--ink) / 0.4)' }} />
          <span>扫描完成（{coalesceScanSummary.scannedPairs || 0} 对灵感），未发现新桥梁</span>
        </div>
      )}

      {/* 指纹 stale 提示 */}
      {fingerprintStale && (
        <div className="flex items-center gap-1.5 text-xs text-amber-400/80 px-2 py-1.5 rounded-md bg-amber-500/5 border border-amber-500/20">
          <AlertCircle size={11} />
          <span>语义指纹需更新（内容已变更），扫描前将自动重算</span>
        </div>
      )}

      {/* 错误提示 */}
      {coalesceError && (
        <div className="flex items-center gap-1.5 text-xs text-rose-400/80 px-2 py-1.5 rounded-md bg-rose-500/5 border border-rose-500/20">
          <AlertCircle size={11} />
          <span>{coalesceError}</span>
        </div>
      )}

      {/* 桥梁列表 */}
      {bridges.length === 0 ? (
        <p className="text-ink/30 text-sm font-sans italic py-4 text-center">
          尚未发现桥梁。点击"扫描桥梁"启动双引擎召回。
        </p>
      ) : (
        <div className="space-y-2">
          {activeBridges.map((bridge) => (
            <BridgeCard
              key={bridge.id}
              bridge={bridge}
              currentInspirationId={inspiration.id}
              onCurate={onCurate}
              onToInspiration={onToInspiration}
            />
          ))}
          {/* 已忽略桥梁（置灰归档区） */}
          {dismissedBridges.length > 0 && (
            <div className="pt-3 mt-3 border-t border-line/5">
              <p className="text-ink/30 text-[10px] uppercase tracking-wider mb-2">已忽略</p>
              {dismissedBridges.map((bridge) => (
                <BridgeCard
                  key={bridge.id}
                  bridge={bridge}
                  currentInspirationId={inspiration.id}
                  onCurate={onCurate}
                  onToInspiration={onToInspiration}
                  dismissed
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * 桥梁卡片
 * 功能：展示单条桥梁 + 策展按钮 + 转新灵感
 */
function BridgeCard({ bridge, currentInspirationId, onCurate, onToInspiration, dismissed = false }) {
  const color = BRIDGE_COLORS[bridge.bridgeType] || '#888'
  const label = BRIDGE_LABELS[bridge.bridgeType] || bridge.bridgeType
  // 显示另一端灵感 ID（当前灵感可能是 A 或 B）
  const otherId = bridge.inspirationAId === currentInspirationId
    ? bridge.inspirationBId
    : bridge.inspirationAId

  return (
    <div
      className="p-3 rounded-lg transition-all"
      style={{
        background: dismissed ? 'rgb(var(--ink) / 0.01)' : 'rgb(var(--ink) / 0.02)',
        border: `1px solid ${dismissed ? 'rgb(var(--ink) / 0.03)' : color + '30'}`,
        opacity: dismissed ? 0.5 : 1
      }}
    >
      {/* 桥梁类型标签 + 信心分 */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] px-2 py-0.5 rounded-md font-sans"
            style={{ color, background: color + '15' }}
          >
            {label}
          </span>
          {bridge.vectorScore && (
            <span className="text-ink/30 text-[10px] font-sans">
              向量 {Math.round(bridge.vectorScore * 100)}%
            </span>
          )}
          {bridge.llmScore && (
            <span className="text-ink/30 text-[10px] font-sans">
              LLM {Math.round(bridge.llmScore * 100)}%
            </span>
          )}
        </div>
        <span className="text-ink/30 text-[10px] font-sans">
          {bridge.status === 'confirmed' ? '已确认' : bridge.status === 'dismissed' ? '已忽略' : '待策展'}
        </span>
      </div>

      {/* 桥梁说明 */}
      <p className="text-ink/70 text-xs font-sans leading-relaxed mb-2">
        {bridge.reason}
      </p>

      {/* 关联灵感 ID */}
      <p className="text-ink/30 text-[10px] font-sans mb-2">
        连接：{otherId?.slice(0, 8)}...
      </p>

      {/* 策展按钮 */}
      {!dismissed && bridge.status === 'pending' && (
        <div className="flex items-center gap-2 mt-2">
          <button
            type="button"
            onClick={() => onCurate(bridge.id, 'confirm')}
            className="glow-btn flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-sans transition-all"
            style={{
              background: 'rgba(16,185,129,0.1)',
              color: '#10b981',
              border: '1px solid rgba(16,185,129,0.2)'
            }}
          >
            <Check size={10} />
            <span>确认</span>
          </button>
          <button
            type="button"
            onClick={() => onCurate(bridge.id, 'dismiss')}
            className="glow-btn flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-sans transition-all"
            style={{
              background: 'rgb(var(--ink) / 0.04)',
              color: 'rgb(var(--ink) / 0.5)',
              border: '1px solid rgb(var(--ink) / 0.06)'
            }}
          >
            <X size={10} />
            <span>忽略</span>
          </button>
        </div>
      )}

      {/* 已确认桥梁：转新灵感按钮 */}
      {bridge.status === 'confirmed' && (
        <button
          type="button"
          onClick={() => onToInspiration(bridge.id)}
          className="glow-btn flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-sans transition-all mt-2"
          style={{
            background: 'rgb(var(--cyan-bright-rgb) / 0.1)',
            color: 'var(--accent-cyan-bright)',
            border: '1px solid rgb(var(--cyan-bright-rgb) / 0.2)'
          }}
        >
          <Plus size={10} />
          <span>转新灵感</span>
          <ArrowRight size={10} />
        </button>
      )}
    </div>
  )
}

/**
 * EpitaxyLinkedView 外延联动视图（K4-b 改进点 1）
 * 功能：当 drawer='epitaxy' 时替换三阶段档案馆，根据 epitaxyStage 显示对应内容
 * 设计：抽屉里只显示"操作元素"（卡片列表/选词按钮），Detail 显示"内容详情"
 *       避免抽屉与 Detail 内容重复，让抽屉专注于操作，Detail 专注于阅读
 *
 * 4 个分支：
 *   - proposing/proposing_done/empty：crystal 摘要 + "点击右侧卡片开始深挖"提示
 *   - excavating：选中的 proposal 详情 + ExcavateAnim 动画
 *   - excavating_done：fragments 详情列表（每张笔记卡片完整内容）
 *   - distilled：已保留的知识词块列表
 *
 * @param {object} props
 * @param {object} props.inspiration - 当前灵感
 * @param {object|null} props.crystal - 结晶体数据（archiveData.crystal）
 * @param {string} props.epitaxyStage - 外延阶段
 * @param {object|null} props.selectedProposal - 当前选中的方向
 * @param {Array} props.fragments - 深挖片段列表
 * @param {Array} props.selectedChunks - 用户选中的片段（在抽屉里选的）
 * @param {Array} props.distilledChunks - 已保留的词块
 */
function EpitaxyLinkedView({
  inspiration, crystal, epitaxyStage,
  selectedProposal, fragments, selectedChunks, distilledChunks
}) {
  // 分支 1：proposing / proposing_done / empty —— 用户在抽屉里浏览方向卡片
  // Detail 显示：crystal 摘要 + 提示"点击右侧卡片开始深挖"
  if (epitaxyStage === 'proposing' || epitaxyStage === 'proposing_done' || epitaxyStage === 'empty') {
    return (
      <div className="space-y-4 animate-fade-in-up">
        {/* 联动状态指示 */}
        <div
          className="glow-card flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}
        >
          <FileText size={12} style={{ color: '#3b82f6' }} />
          <span className="text-ink/70 text-xs font-sans">外延探究中</span>
          <span className="text-ink/40 text-[11px] font-sans">— 在右侧抽屉选择方向</span>
        </div>

        {/* crystal 摘要卡片：让用户在外延时能看到结晶体内容 */}
        {crystal && crystal.fields ? (
          <div
            className="glass-card rounded-xl px-4 py-3"
            style={{ borderColor: 'rgb(var(--cyan-rgb) / 0.15)' }}
          >
            <p className="text-ink/40 text-[10px] mb-1 uppercase tracking-wider font-sans">结晶摘要</p>
            <p className="font-display text-ink/90 text-base font-semibold mb-2 leading-tight">
              {crystal.fields?.title || inspiration?.title}
            </p>
            {/* 摘要字段（取前 3 个非元字段） */}
            <div className="space-y-1.5 mt-2">
              {Object.entries(crystal.fields)
                .filter(([key]) => !['composable_with', 'follow_up_questions', '_supplement', 'archetype', 'detected_capsule', 'selected_dimensions', 'extensions'].includes(key))
                .slice(0, 3)
                .map(([key, value]) => {
                  const displayValue = Array.isArray(value)
                    ? value.slice(0, 2).join('、') + (value.length > 2 ? '...' : '')
                    : (value && typeof value === 'object' ? Object.keys(value).join('、') : String(value || ''))
                  return (
                    <div key={key} className="flex items-start gap-2 text-[11px] font-sans">
                      <span className="text-ink/35 flex-shrink-0">{CRYSTAL_FIELD_LABELS[key] || key}：</span>
                      <span className="text-ink/65 leading-relaxed">
                        {displayValue.length > 80 ? displayValue.slice(0, 80) + '...' : displayValue}
                      </span>
                    </div>
                  )
                })}
            </div>
          </div>
        ) : (
          <div className="glass-card rounded-xl px-4 py-3" style={{ borderColor: 'rgb(var(--ink) / 0.05)' }}>
            <p className="text-ink/35 text-xs font-sans italic">尚未结晶，外延将基于灵感原文进行</p>
          </div>
        )}

        {/* 提示卡片 */}
        <div className="glow-card flex items-center gap-2.5 px-4 py-3 rounded-xl" data-glow="purple" style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.2)' }}>
          <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(168,85,247,0.2)', color: 'var(--sem-purple)' }}>
            <Sparkles size={13} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-ink/85 text-xs font-medium font-sans">
              {epitaxyStage === 'proposing' ? '正在生成探究方向...' : '点击右侧卡片开始深挖'}
            </p>
            <p className="text-ink/40 text-[10px] mt-0.5 leading-relaxed font-sans">
              深挖后的研究笔记会显示在这里
            </p>
          </div>
        </div>
      </div>
    )
  }

  // 分支 2：excavating —— AI 深挖中
  // Detail 显示：选中的 proposal 详情 + ExcavateAnim 动画
  if (epitaxyStage === 'excavating') {
    return (
      <div className="space-y-4 animate-fade-in-up">
        {/* 选中方向的卡片 */}
        {selectedProposal && (
          <div className="glass-card rounded-xl px-4 py-3" style={{ borderColor: 'rgba(59,130,246,0.2)' }}>
            <p className="text-ink/40 text-[10px] mb-1 uppercase tracking-wider font-sans">正在深挖</p>
            <p className="font-display text-ink/95 text-lg font-semibold mb-2 leading-tight">
              {selectedProposal.direction || selectedProposal.title || '未命名方向'}
            </p>
            {selectedProposal.reasoning && (
              <p className="text-ink/55 text-xs leading-relaxed font-sans">
                {selectedProposal.reasoning}
              </p>
            )}
            {selectedProposal.expected_yield && (
              <p className="text-ink/40 text-[11px] mt-2 flex items-center gap-1 font-sans">
                <Lightbulb size={10} />
                <span>预期收获：{selectedProposal.expected_yield}</span>
              </p>
            )}
          </div>
        )}

        {/* 深挖动画区 */}
        <ExcavateAnim />
      </div>
    )
  }

  // 分支 3：excavating_done —— 用户在抽屉里选词
  // fix：Detail 只展示"成果"，不展示"正在深挖的过程"
  //       深挖出的 fragments 由抽屉负责展示和选词，Detail 保持简洁
  //       只显示已保存的词块（来自之前其他方向的 distilled 结果）+ 当前方向提示
  if (epitaxyStage === 'excavating_done') {
    return (
      <div className="space-y-4 animate-fade-in-up">
        {/* 联动状态指示：当前方向正在选词中 */}
        <div
          className="glow-card flex items-center gap-2 px-3 py-2 rounded-lg"
          style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)' }}
        >
          <FileText size={12} style={{ color: '#3b82f6' }} />
          <span className="text-ink/70 text-xs font-sans">选词提炼中</span>
          <span className="text-ink/40 text-[11px] font-sans">— 在右侧抽屉选段并保存</span>
        </div>

        {/* 当前选中的方向标题（仅展示方向，不展示 fragments 内容） */}
        {selectedProposal && (
          <div>
            <p className="font-display text-ink/95 text-lg font-semibold leading-tight">
              {selectedProposal.direction || selectedProposal.title || '未命名方向'}
            </p>
            {selectedProposal.reasoning && (
              <p className="text-ink/45 text-xs leading-relaxed mt-1 font-sans">
                {selectedProposal.reasoning}
              </p>
            )}
          </div>
        )}

        {/* 已保存的成果词块（来自之前其他方向已 distilled 的结果）
            fix：Detail 只展示"成果"，不展示"过程"
            当前深挖的 fragments 在抽屉里选词，保存后才作为成果沉淀到 Detail */}
        {distilledChunks && distilledChunks.length > 0 ? (
          <div className="mt-4 pt-3 border-t border-line/5">
            <p className="text-ink/40 text-[11px] uppercase tracking-wider font-sans mb-3">
              已保留的成果（{distilledChunks.length} 段）
            </p>
            <div className="space-y-2">
              {distilledChunks.map((c, idx) => {
                const fragColor = getFragmentKindColor(c.kind)
                const typeLabel = getFragmentKindLabel(c.kind)
                return (
                  <div
                    key={c.id || idx}
                    className="px-3 py-2.5 rounded-lg animate-fade-in-up font-sans"
                    style={{
                      background: `${fragColor}08`,
                      border: `1px solid ${fragColor}20`,
                      animationDelay: `${idx * 40}ms`
                    }}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                        style={{ background: `${fragColor}20`, color: fragColor }}
                      >
                        {typeLabel}
                      </span>
                      {c.title && <span className="text-ink/70 text-[11px] font-medium">{c.title}</span>}
                    </div>
                    <p className="text-ink/65 text-xs leading-relaxed">
                      {c.chunk_text || c.text}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          /* 无已保存成果时，显示简洁提示 */
          <div className="glow-card flex items-center gap-2.5 px-4 py-3 rounded-xl mt-4" style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.2)' }}>
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(168,85,247,0.2)', color: 'var(--sem-purple)' }}>
              <Sparkles size={13} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-ink/85 text-xs font-medium font-sans">在右侧抽屉选段并保存</p>
              <p className="text-ink/40 text-[10px] mt-0.5 leading-relaxed font-sans">
                保存后的笔记会作为成果沉淀到这里
              </p>
            </div>
          </div>
        )}
      </div>
    )
  }

  // 分支 4：distilled —— 提炼完成
  // Detail 显示：已保留的知识词块列表
  if (epitaxyStage === 'distilled') {
    return (
      <div className="space-y-4 animate-fade-in-up">
        {/* 成功提示 */}
        <div
          className="glass-card rounded-xl px-4 py-3 flex items-center gap-2"
          style={{ borderColor: 'rgba(16,185,129,0.2)' }}
        >
          <CheckCircle2 size={16} style={{ color: '#10b981' }} />
          <p className="text-ink/80 text-sm font-sans">
            已保留 {distilledChunks.length} 段笔记
          </p>
        </div>

        {/* 词块列表 */}
        {distilledChunks.length > 0 ? (
          <div className="space-y-2">
            {distilledChunks.map((c, idx) => {
              const fragColor = getFragmentKindColor(c.kind)
              const typeLabel = getFragmentKindLabel(c.kind)
              return (
                <div
                  key={c.id || idx}
                  className="px-3 py-2.5 rounded-lg animate-fade-in-up font-sans"
                  style={{
                    background: `${fragColor}08`,
                    border: `1px solid ${fragColor}20`,
                    animationDelay: `${idx * 40}ms`
                  }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="px-1.5 py-0.5 rounded text-[10px] font-medium"
                      style={{ background: `${fragColor}20`, color: fragColor }}
                    >
                      {typeLabel}
                    </span>
                    {c.title && <span className="text-ink/70 text-[11px] font-medium">{c.title}</span>}
                  </div>
                  <p className="text-ink/65 text-xs leading-relaxed">
                    {c.chunk_text || c.text}
                  </p>
                </div>
              )
            })}
          </div>
        ) : (
          <p className="text-ink/30 text-sm font-sans italic py-4 text-center">
            尚未保留词块
          </p>
        )}

        {/* 提示：可在右侧抽屉继续操作 */}
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: 'rgb(var(--ink) / 0.02)', border: '1px solid rgb(var(--ink) / 0.05)' }}>
          <BookOpen size={11} style={{ color: '#3b82f6' }} />
          <span className="text-ink/45 text-[11px] font-sans">
            可在右侧抽屉查看其他方向，或关闭抽屉回到档案
          </span>
        </div>
      </div>
    )
  }

  // 兜底
  return null
}

export default InspirationDetail
