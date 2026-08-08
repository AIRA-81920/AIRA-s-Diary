// CrystallizePanel 灵感结晶面板（深空智识美学 · 抽屉式改版）
// 功能：四阶段状态机（idle / questioning / prd_preview / done），把模糊灵感引导为结构化结晶体
// 实现方式：
//   - 从 Zustand store 读取 crystallize* 状态与 actions，所有 API 调用走 store
//   - 渲染分支按 stage 切换：idle（开始）→ questioning（追问，抽屉式覆盖）→ prd_preview（PRD 预览/编辑）→ done（分流）
//   - PanelHeader 子组件统一管理顶部标题 + 折叠按钮，4 个阶段共用
//   - questioning 阶段采用 2 列网格选项 + 每题自动追加"其他：请补充"选项
//   - 多选题支持：multi 字段为 true 时选项用复选框 UI，max_select 限制上限
//
// M3 变更：原 ClarifyPanel → CrystallizePanel，所有 clarify* 引用改为 crystallize*
// M3-b 待实施：新增 sense_confirm 阶段（灵感类型确认 UI），DISPATCH_OPTIONS 将由 epitaxy 自动接管
import React, { useState } from 'react'
import {
  Sparkles,
  Loader2,
  Check,
  CheckCircle2,
  BookOpen,
  Target,
  AlertCircle,
  RotateCcw,
  ChevronLeft,
  Send,
  PencilLine
} from 'lucide-react'
import useStore from '../services/store.js'
// fix3：引入语义化等待动画（替换通用 Loader2 旋转圈）
import { CrystalSensingAnim, CrystalQuestioningAnim } from './LoadingAnims.jsx'

/**
 * 分流选项常量（M3 更新）
 * 功能：定义 done 阶段的三个去向（外延探究 / 跨界融合 / 仅存档）
 * 字段：id 唯一标识、icon 图标、label 中文标签、description 描述、color 强调色、agent 目标 Agent 标识
 * M3-a：epitaxy/coalesce 尚未注册，dispatch 会返回 unknown agent 错误（被 UI 静默处理）
 * M3-c 后 epitaxy 将自动接管，此处分流 UI 可能被简化
 */
const DISPATCH_OPTIONS = [
  { id: 'epitaxy', icon: BookOpen, label: '外延探究', description: '基于结晶生成方向卡片，深挖笔记', color: '#3b82f6', agent: 'epitaxy' },
  { id: 'coalesce', icon: Target, label: '跨界融合', description: '寻找跨灵感桥梁，生成新种子', color: '#a855f7', agent: 'coalesce' },
  { id: 'done', icon: CheckCircle2, label: '仅存档', description: '想法还不成熟，先保存起来', color: '#6b7280', agent: null }
]

// 各 crystal_type 的字段元数据（与后端 TYPE_BRANCHES.crystalFields 对应）
// 功能：定义每种结晶形态的字段 key / 中文标签 / 图标 / 是否多行
// 实现方式：前端按 crystalType 查找对应字段列表，动态渲染 PRDField 组件
const CRYSTAL_FIELD_META = {
  prd: [
    { key: 'title',            icon: '📌', label: '标题',         multiline: false },
    { key: 'goal',             icon: '🎯', label: '目标',         multiline: false },
    { key: 'target_user',      icon: '👤', label: '目标用户',     multiline: false },
    { key: 'core_features',    icon: '💡', label: '核心功能（每行一条）',   multiline: true, array: true },
    { key: 'success_criteria', icon: '✅', label: '成功标准（每行一条）',   multiline: true, array: true }
  ],
  scene_card: [
    { key: 'title',          icon: '📌', label: '场景标题',   multiline: false },
    { key: 'setting',        icon: '🗺️', label: '场景设置',   multiline: false },
    { key: 'sensory_detail', icon: '👁️', label: '感官细节',   multiline: true },
    { key: 'mood',           icon: '🎨', label: '情绪基调',   multiline: false },
    { key: 'protagonist',    icon: '🧍', label: '主角存在',   multiline: false },
    { key: 'moment',         icon: '⏱️', label: '关键瞬间',   multiline: false }
  ],
  worldview: [
    { key: 'title',        icon: '📌', label: '世界观标题',   multiline: false },
    { key: 'premise',      icon: '🌌', label: '核心前提',     multiline: true },
    { key: 'rules',        icon: '⚖️', label: '运行规则',     multiline: true },
    { key: 'constraints',  icon: '🚫', label: '约束边界',     multiline: true },
    { key: 'inhabitants',  icon: '👥', label: '居民形态',     multiline: false },
    { key: 'tension',      icon: '⚡', label: '内在张力',     multiline: true }
  ],
  creative_direction: [
    { key: 'title',         icon: '📌', label: '创作标题',   multiline: false },
    { key: 'emotion',       icon: '💫', label: '情感内核',   multiline: false },
    { key: 'imagery',       icon: '🔮', label: '核心意象',   multiline: false },
    { key: 'rhythm',        icon: '🎵', label: '节奏韵律',   multiline: false },
    { key: 'theme',         icon: '🎭', label: '主题表达',   multiline: true },
    { key: 'counterpoint',  icon: '🔀', label: '反差点',     multiline: false }
  ],
  exploration_map: [
    { key: 'title',         icon: '📌', label: '探索标题',     multiline: false },
    { key: 'question',      icon: '❓', label: '核心问题',     multiline: true },
    { key: 'sub_questions', icon: '🔍', label: '子问题（每行一条）', multiline: true, array: true },
    { key: 'hypothesis',    icon: '💭', label: '初步假设',     multiline: true },
    { key: 'methods',       icon: '🔬', label: '探究方法（每行一条）', multiline: true, array: true },
    { key: 'sources',       icon: '📚', label: '信息来源（每行一条）', multiline: true, array: true }
  ],
  character_profile: [
    { key: 'title',       icon: '📌', label: '角色名',     multiline: false },
    { key: 'personality', icon: '🧠', label: '性格特质',   multiline: true },
    { key: 'background',  icon: '📖', label: '背景经历',   multiline: true },
    { key: 'motivation',  icon: '🔥', label: '核心动机',   multiline: true },
    { key: 'relations',   icon: '🔗', label: '人际关系',   multiline: true },
    { key: 'voice',       icon: '🗣️', label: '语言风格',   multiline: false }
  ],
  // K4 改造：删除 process_card（方法流程类型已废弃，v4 迁移后历史数据归入"其他"）
  // fix6：概念类型字段定义（替换原 argument_card）
  // 设计：3 必填字段（title/definition/distinction）+ 3 动态字段（origin/signature_features/applicable_context）
  //       evolution 是 metaField（LLM 推断），不放在此处编辑（在 InspirationDetail 中只读展示）
  concept_card: [
    { key: 'title',                icon: '📌', label: '概念命名',     multiline: false },
    { key: 'definition',           icon: '💭', label: '核心定义',     multiline: true },
    { key: 'distinction',          icon: '⚡', label: '区分点',       multiline: true },
    { key: 'origin',               icon: '🌱', label: '概念起源',     multiline: true },
    { key: 'signature_features',   icon: '🏷️', label: '标志性特征',   multiline: true },
    { key: 'applicable_context',   icon: '🎯', label: '适用场景',     multiline: true }
  ],
  // K4-a 新增：美学提案字段定义
  // 设计：title/core_definition/emotional_core/differentiation/cultural_context 用文本渲染
  //       aesthetic_attributes 是 object（含多个小维度），转为可读字符串后用多行文本渲染
  //       signature_elements 是 array，用 array:true 多行渲染
  //       extensions 是元字段（LLM 推断），不放在此处编辑（在 InspirationDetail 中只读展示）
  aesthetic_proposal: [
    { key: 'title',             icon: '📌', label: '流派命名',     multiline: false },
    { key: 'core_definition',   icon: '💭', label: '核心定义',     multiline: true },
    { key: 'aesthetic_attributes', icon: '🎨', label: '美学属性',  multiline: true },
    { key: 'emotional_core',    icon: '💫', label: '情感内核',     multiline: false },
    { key: 'differentiation',   icon: '⚡', label: '差异点',       multiline: true },
    { key: 'cultural_context',  icon: '🌍', label: '文化语境',     multiline: true },
    { key: 'signature_elements', icon: '🏷️', label: '标志性元素（每行一条）', multiline: true, array: true }
  ],
  free_note: [
    { key: 'title',       icon: '📌', label: '标题',       multiline: false },
    { key: 'core_idea',   icon: '💡', label: '想法核心',   multiline: true },
    { key: 'trigger',     icon: '🎣', label: '触发情境',   multiline: true },
    { key: 'desired_form', icon: '🎭', label: '希望形态',  multiline: false },
    { key: 'next_step',   icon: '➡️', label: '后续打算',   multiline: false }
  ]
}

/**
 * PanelHeader 顶部标题栏（各阶段共用）
 * 功能：统一管理阶段标题、图标、折叠按钮
 * 实现方式：根据 stage prop 选择对应的图标与标题文案，右侧固定 ChevronLeft 折叠按钮
 */
function PanelHeader({ stage, onCollapse }) {
  // stage → { icon, title, color } 的映射（M3-b：新增 sensing/sense_confirm/crystal_preview；K4：新增 capsule_detection）
  const meta = {
    idle:             { icon: Sparkles,     title: '灵感结晶',   color: 'var(--accent-cyan)' },
    sensing:          { icon: Sparkles,     title: '感知类型',   color: '#a855f7' },
    sense_confirm:    { icon: Sparkles,     title: '确认类型',   color: '#a855f7' },
    capsule_detection:{ icon: Sparkles,     title: '设定胶囊',   color: '#a855f7' },
    questioning:      { icon: Sparkles,     title: '灵感结晶',   color: 'var(--accent-cyan)' },
    crystal_preview:  { icon: CheckCircle2, title: '结晶预览',   color: 'var(--accent-amber)' },
    done:             { icon: CheckCircle2, title: '结晶已完成', color: 'var(--accent-cyan)' }
  }
  const { icon: Icon, title, color } = meta[stage] || meta.idle

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-line/5">
      <div className="flex items-center gap-2">
        <Icon size={14} style={{ color }} />
        <span className="font-display text-sm font-semibold text-ink/85 tracking-wide">{title}</span>
      </div>
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          className="p-1 rounded-md text-ink/30 hover:text-ink/70 hover:bg-veil/5 transition-colors"
          title="收起面板"
        >
          <ChevronLeft size={14} />
        </button>
      )}
    </div>
  )
}

/**
 * PRDField — PRD 字段内联编辑子组件
 * 功能：展示 + 点击切换到编辑态，支持单行/多行；失焦或回车保存
 * 实现方式：本地 editing/local 状态，onBlur 时调用 onSave 回传新值
 */
function PRDField({ icon, label, value, multiline, onSave }) {
  const [editing, setEditing] = useState(false)
  const [local, setLocal] = useState(value || '')

  // 进入编辑态时同步 local 值
  const startEdit = () => {
    setLocal(value || '')
    setEditing(true)
  }
  // 保存并退出编辑态
  const save = () => {
    onSave(local)
    setEditing(false)
  }

  return (
    <div className="mb-3 animate-fade-in-up">
      {/* 字段标签行：emoji + 衬线小标题 */}
      <div className="flex items-center gap-1.5 mb-1.5">
        <span style={{ fontSize: '11px' }}>{icon}</span>
        <span className="text-ink/40 text-[10px] font-medium uppercase tracking-wider font-sans">{label}</span>
      </div>
      {editing ? (
        multiline ? (
          <textarea
            autoFocus
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={save}
            rows={3}
            className="input-accent w-full rounded-lg px-2.5 py-2 text-xs text-ink/85 outline-none resize-none font-sans"
          />
        ) : (
          <input
            autoFocus
            type="text"
            value={local}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            className="input-accent w-full rounded-lg px-2.5 py-1.5 text-xs text-ink/85 outline-none font-sans"
          />
        )
      ) : (
        <p
          className="glow-card glow-text text-xs text-ink/70 cursor-pointer hover:text-ink/95 transition-colors leading-relaxed font-sans rounded-md"
          onClick={startEdit}
          style={{ minHeight: '20px' }}
        >
          {value || <span className="text-ink/25 italic">待确认（点击编辑）</span>}
        </p>
      )}
    </div>
  )
}

/**
 * CrystallizePanel 主组件
 * @param {object} props
 * @param {object} props.inspiration - 当前选中灵感
 * @param {Function} props.onCollapse - 收起面板回调
 */
function CrystallizePanel({ inspiration, onCollapse }) {
  // 从 store 读取结晶状态与 actions（M3-b：新增 Sense 相关状态与 actions）
  const stage = useStore((s) => s.crystallizeStage)
  const prd = useStore((s) => s.crystallizePRD)
  const questions = useStore((s) => s.crystallizeQuestions)
  const currentIdx = useStore((s) => s.crystallizeCurrentIdx)
  const answers = useStore((s) => s.crystallizeAnswers)
  const otherAnswers = useStore((s) => s.crystallizeOtherAnswers)
  const loading = useStore((s) => s.crystallizeLoading)
  const error = useStore((s) => s.crystallizeError)
  const dispatching = useStore((s) => s.crystallizeDispatching)

  // M3-b 新增：Sense 阶段状态
  const senseLoading = useStore((s) => s.senseLoading)
  const inspirationType = useStore((s) => s.inspirationType)
  const inspirationTypeConfidence = useStore((s) => s.inspirationTypeConfidence)
  const inspirationTypeAlternatives = useStore((s) => s.inspirationTypeAlternatives)
  const inspirationTypeReasoning = useStore((s) => s.inspirationTypeReasoning)
  const crystalType = useStore((s) => s.crystalType)

  const startCrystallize = useStore((s) => s.startCrystallize)
  const answerCrystallizeQuestion = useStore((s) => s.answerCrystallizeQuestion)
  const skipToPRD = useStore((s) => s.skipToPRD)
  const setCrystallizeAnswer = useStore((s) => s.setCrystallizeAnswer)
  const setCrystallizeOtherAnswer = useStore((s) => s.setCrystallizeOtherAnswer)
  const updateCrystallizePRDField = useStore((s) => s.updateCrystallizePRDField)
  const confirmPRD = useStore((s) => s.confirmPRD)
  const dispatchFromCrystallize = useStore((s) => s.dispatchFromCrystallize)
  const resetCrystallize = useStore((s) => s.resetCrystallize)
  // M3-b 新增：Sense actions
  const confirmInspirationType = useStore((s) => s.confirmInspirationType)
  // K3-e：抽屉 actions（分流时切换抽屉）
  const closeDrawer = useStore((s) => s.closeDrawer)
  const openDrawer = useStore((s) => s.openDrawer)

  // K4 新增：胶囊识别与决策相关状态与 actions
  const detectedCapsules = useStore((s) => s.detectedCapsules)         // 识别到的胶囊数组
  const senseSignals = useStore((s) => s.senseSignals)                 // 5 信号详情（低置信度时透明化展示）
  const conceptScore = useStore((s) => s.conceptScore)                 // fix6：概念得分（原"概念命题得分"）
  const productScore = useStore((s) => s.productScore)                 // 产品想法得分
  const conceptOrientation = useStore((s) => s.conceptOrientation)     // 概念指向（understanding/action/creation）
  const confirmCapsuleUsage = useStore((s) => s.confirmCapsuleUsage)   // 用户决定是否使用胶囊

  const currentQ = questions[currentIdx]
  const currentAnswer = currentQ ? answers[currentQ.id] || '' : ''
  // 选中"其他"时判断（__other__ 是前端追加的固定 id）
  // 单选题：currentAnswer 是字符串；多选题：currentAnswer 是数组
  const rawAnswer = currentQ ? answers[currentQ.id] : ''
  const isMulti = currentQ?.multi === true
  const selectedValues = isMulti
    ? (Array.isArray(rawAnswer) ? rawAnswer : (rawAnswer ? [rawAnswer] : []))
    : (rawAnswer ? [rawAnswer] : [])
  const isOtherSelected = selectedValues.includes('__other__')
  const otherText = currentQ ? otherAnswers[currentQ.id] || '' : ''
  // 多选题是否达到最大选择数
  const maxSelect = currentQ?.max_select
  const atMaxLimit = isMulti && maxSelect != null && selectedValues.length >= maxSelect
  // 是否可提交：有答案 + （若选其他则必须填补充内容）
  const canSubmitAnswer = !loading && selectedValues.length > 0 && (!isOtherSelected || otherText.trim().length > 0)

  /**
   * 处理选项点击
   * 功能：单选直接设置答案；多选切换选中态（加入或移除），并处理 max_select 限制
   * @param {string} optId - 选项 id
   */
  const handleOptionClick = (optId) => {
    if (isMulti) {
      // 多选：切换选中态
      const current = Array.isArray(rawAnswer) ? rawAnswer : (rawAnswer ? [rawAnswer] : [])
      let next
      if (current.includes(optId)) {
        // 已选 → 移除
        next = current.filter((v) => v !== optId)
      } else {
        // 未选 → 加入（检查 max_select）
        if (atMaxLimit) return  // 达到上限不再加入
        next = [...current, optId]
      }
      setCrystallizeAnswer(currentQ.id, next)
    } else {
      // 单选：直接设置
      setCrystallizeAnswer(currentQ.id, optId)
    }
  }

  /**
   * 处理分流按钮点击（K3-e 改造：适配抽屉模式）
   * 功能：根据分流目标切换抽屉或关闭抽屉
   * 实现方式：
   *   - 'epitaxy'：通知后端 + 关闭结晶抽屉 + 打开外延抽屉
   *   - 'coalesce'：通知后端 + 关闭抽屉（用户在 Detail 中扫描桥梁）
   *   - 'done'（仅存档）：直接关闭抽屉，产物沉淀 Detail
   */
  // K4-b 改进点 4：分流按钮改为纯状态切换，不再调 LLM
  // 修复前：点击后会 await dispatchFromCrystallize（卡 10-30s 调 LLM 生成方向卡片）
  // 修复后：直接切抽屉，LLM 调用由 EpitaxyPanel useEffect 按需触发
  // 卡片不是提前生成的——之前之所以慢，是因为前端在分流时同步调用了后端 dispatch 接口
  const handleDispatch = (option) => {
    if (!option.agent) {
      // 仅存档：直接关闭抽屉
      closeDrawer()
      return
    }
    // K3-e + K4-b：分流 = 瞬时状态切换，不调 LLM
    // LLM 调用交给目标抽屉的 useEffect（如 EpitaxyPanel 在 stage='empty' 时触发 propose）
    if (option.id === 'epitaxy') {
      // 关闭结晶抽屉并打开外延抽屉（openDrawer 会自动保存结晶中间态）
      openDrawer('epitaxy', inspiration.id)
    } else {
      // coalesce 或其他：关闭抽屉，回到 Detail
      closeDrawer()
    }
  }

  // ====== 渲染分支：按 stage 切换 ======

  // idle：初始引导卡片
  if (stage === 'idle') {
    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        <PanelHeader stage={stage} onCollapse={onCollapse} />

        {/* 引导内容：居中图标 + 衬线哲学提示 + CTA */}
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
          <div className="relative inline-block mb-5 animate-fade-in-up">
            {/* 光晕背景 */}
            <div
              className="absolute inset-0 rounded-full blur-xl animate-pulse-soft"
              style={{ background: 'rgb(var(--cyan-rgb) / 0.15)' }}
            />
            {/* 图标容器：玻璃态 + 青色边框 */}
            <div
              className="relative w-16 h-16 rounded-2xl flex items-center justify-center glass-card"
              style={{ borderColor: 'rgb(var(--cyan-rgb) / 0.3)' }}
            >
              <Sparkles size={26} style={{ color: 'var(--accent-cyan)' }} />
            </div>
          </div>
          <h3 className="font-display text-xl font-semibold text-ink/90 mb-2 animate-fade-in-up" style={{ animationDelay: '60ms' }}>
            让 AI 帮你结晶这个灵感
          </h3>
          <p className="text-ink/40 text-xs leading-relaxed max-w-[220px] mb-6 animate-fade-in-up font-sans" style={{ animationDelay: '120ms' }}>
            先感知灵感类型，再定制化追问，最终生成结构化结晶体
          </p>
          <button
            type="button"
            onClick={() => startCrystallize(inspiration)}
            disabled={loading || senseLoading || !inspiration}
            className="glow-btn btn-accent flex items-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-medium animate-fade-in-up font-sans"
            style={{ animationDelay: '180ms' }}
          >
            {loading || senseLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
            <span>{loading || senseLoading ? '思考中...' : '开始结晶'}</span>
          </button>
          {error && (
            <div className="mt-4 flex items-start gap-2 text-rose-300 text-xs max-w-[240px] animate-fade-in-up">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>
      </aside>
    )
  }

  // sensing：正在感知灵感类型（加载态）
  // fix3：用 CrystalSensingAnim 替换 Loader2，让用户从视觉理解"AI 在扫描判断"
  if (stage === 'sensing') {
    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        <PanelHeader stage={stage} onCollapse={onCollapse} />
        <CrystalSensingAnim />
      </aside>
    )
  }

  // sense_confirm：让用户确认或修正灵感类型（低置信度时出现）
  if (stage === 'sense_confirm') {
    // 8 种类型选项（K4 改造：删除"方法流程"；K4-a 改造：新增"美学提案"）+ 兜底"其他"
    const allTypes = [
      '产品想法', '氛围画面', '设定世界观', '创作素材',
      '研究好奇', '角色人物', '概念', '美学提案', '其他'
    ]
    // 当前选中的类型（用于高亮）
    const selectedType = inspirationType

    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        <PanelHeader stage={stage} onCollapse={onCollapse} />
        <div className="flex-1 px-4 py-4 overflow-y-auto">
          {/* AI 判断结果卡片 */}
          <div
            className="glass-card rounded-xl px-4 py-3 mb-4 animate-fade-in-up"
            style={{ borderColor: 'rgba(168,85,247,0.15)' }}
          >
            <p className="text-ink/40 text-[10px] mb-1 uppercase tracking-wider font-sans">AI 判断的类型</p>
            <p className="font-display text-ink/95 text-lg font-semibold mb-1">
              {inspirationType}
              <span className="ml-2 text-xs font-sans" style={{ color: '#a855f7' }}>
                {Math.round(inspirationTypeConfidence * 100)}%
              </span>
            </p>
            {inspirationTypeReasoning && (
              <p className="text-ink/40 text-[11px] leading-relaxed font-sans mt-1">
                {inspirationTypeReasoning}
              </p>
            )}
            {inspirationTypeAlternatives.length > 0 && (
              <p className="text-ink/30 text-[10px] mt-2 font-sans">
                备选：{inspirationTypeAlternatives.join('、')}
              </p>
            )}

            {/* K4 新增：5 信号详情（仅当类型为概念或产品想法时显示，透明化判断依据） */}
            {(inspirationType === '概念' || inspirationType === '产品想法') && senseSignals && (
              <div className="mt-3 pt-3 border-t border-line/10">
                <p className="text-ink/40 text-[10px] mb-2 uppercase tracking-wider font-sans">判断依据（5 信号）</p>
                <div className="space-y-1 text-[10px] text-ink/50 font-sans">
                  {/* 信号 1：核心名词抽象度（+2 概念 / +2 产品） */}
                  <div className="flex justify-between">
                    <span>核心名词抽象度：</span>
                    <span className={senseSignals.noun_abstractness === 'concept' ? 'text-purple-300' : 'text-cyan-300'}>
                      {senseSignals.noun_abstractness === 'concept' ? '抽象（+2 概念）' : '具象（+2 产品）'}
                    </span>
                  </div>
                  {/* 信号 2："能"后动词性质（+1 概念 / +1 产品） */}
                  <div className="flex justify-between">
                    <span>"能"后动词性质：</span>
                    <span className={senseSignals.verb_type === 'concept' ? 'text-purple-300' : 'text-cyan-300'}>
                      {senseSignals.verb_type === 'concept' ? '认知（+1 概念）' : '功能（+1 产品）'}
                    </span>
                  </div>
                  {/* 信号 3：形态绑定（+1 概念 / +2 产品 / 中性） */}
                  <div className="flex justify-between">
                    <span>形态绑定：</span>
                    <span className={senseSignals.form_binding === 'concept' ? 'text-purple-300' : senseSignals.form_binding === 'product' ? 'text-cyan-300' : 'text-ink/40'}>
                      {senseSignals.form_binding === 'concept' ? '无绑定（+1 概念）' : senseSignals.form_binding === 'product' ? '明确形态（+2 产品）' : '中性'}
                    </span>
                  </div>
                  {/* 信号 4："做"字信号（+1 概念 / +1 产品） */}
                  <div className="flex justify-between">
                    <span>"做"字信号：</span>
                    <span className={senseSignals.definition_vs_making === 'concept' ? 'text-purple-300' : 'text-cyan-300'}>
                      {senseSignals.definition_vs_making === 'concept' ? '"是/本质"（+1 概念）' : '"做/开发"（+1 产品）'}
                    </span>
                  </div>
                  {/* 信号 5：期待被问方向（+1 概念 / +1 产品） */}
                  <div className="flex justify-between">
                    <span>期待被问方向：</span>
                    <span className={senseSignals.expected_question_direction === 'concept' ? 'text-purple-300' : 'text-cyan-300'}>
                      {senseSignals.expected_question_direction === 'concept' ? '本质特征（+1 概念）' : '目标用户（+1 产品）'}
                    </span>
                  </div>
                  {/* 总分汇总：概念分 vs 产品分 */}
                  <div className="flex justify-between pt-1 border-t border-line/10 mt-1">
                    <span className="font-medium">总分：</span>
                    <span className="font-medium">
                      概念 {conceptScore} / 产品 {productScore}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 类型选择列表 */}
          <p className="text-ink/50 text-xs mb-3 font-sans">这个分类对吗？如果不对我帮你换：</p>
          <div className="grid grid-cols-1 gap-1.5 mb-4">
            {allTypes.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => confirmInspirationType(t)}
                className="glow-btn px-3 py-2.5 rounded-lg text-xs border transition-all text-left font-sans flex items-center justify-between"
                style={{
                  borderColor: t === selectedType ? 'rgba(168,85,247,0.6)' : 'rgb(var(--ink) / 0.08)',
                  background: t === selectedType ? 'rgba(168,85,247,0.12)' : 'transparent',
                  color: t === selectedType ? 'var(--sem-purple)' : 'rgb(var(--ink) / 0.65)'
                }}
              >
                <span>{t}</span>
                {t === selectedType && <Check size={12} />}
              </button>
            ))}
          </div>

          {error && (
            <div className="mb-3 flex items-start gap-2 text-rose-300 text-xs">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>

        {/* 底部操作栏：用当前类型继续 */}
        <div className="flex gap-2 px-4 py-3 border-t border-line/5">
          <button
            type="button"
            onClick={() => confirmInspirationType(selectedType || '其他')}
            disabled={loading}
            className="glow-btn btn-accent flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-white text-xs font-medium font-sans"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            <span>用这个类型继续</span>
          </button>
        </div>
      </aside>
    )
  }

  // capsule_detection：设定胶囊识别卡片（K4 新增）
  // 设计：sense 阶段识别到胶囊后，让用户决定是否使用胶囊（用 → 减少冗余问题；不用 → 按原流程）
  // 初版仅支持单胶囊（取 detectedCapsules[0]），多胶囊扩展时改动此处即可
  if (stage === 'capsule_detection') {
    const capsule = detectedCapsules[0]  // 初版只支持单胶囊
    const applicableElements = capsule?.applicable_elements || []
    const elements = capsule?.elements || {}

    // 元素 key → 中文标签映射（与后端 CAPSULE_TYPE_MAP 的元素 key 对应）
    const elementLabels = {
      attribute: '属性',
      connotation: '内涵',
      imagery: '意象',
      atmosphere: '氛围',
      premise: '核心背景与前提',
      worldview_features: '世界观的典型特征',
      ultimate_theme: '探讨的终极母题'
    }

    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        <PanelHeader stage={stage} onCollapse={onCollapse} />
        <div className="flex-1 px-4 py-4 overflow-y-auto">
          {/* 胶囊识别卡片：告知用户已识别到胶囊，后续只需补差异点 */}
          <div
            className="glass-card rounded-xl px-4 py-3 mb-4 animate-fade-in-up"
            style={{ borderColor: 'rgba(168,85,247,0.15)' }}
          >
            <p className="text-ink/40 text-[10px] mb-1 uppercase tracking-wider font-sans">📦 已识别到设定胶囊</p>
            <p className="font-display text-ink/95 text-lg font-semibold mb-2">
              {capsule?.name}
            </p>
            <p className="text-ink/40 text-[11px] leading-relaxed font-sans">
              胶囊已承担了大部分具象化工作，你只需补"差异点"
            </p>
          </div>

          {/* 已预填的维度列表：告知用户哪些维度不会再被问到 */}
          <div className="mb-4">
            <p className="text-ink/50 text-xs mb-2 font-sans">胶囊已预填的维度（无需再问）：</p>
            <div className="space-y-1.5">
              {applicableElements.map((elemKey) => (
                <div key={elemKey} className="flex items-start gap-2 text-xs">
                  <span className="text-ink/30">•</span>
                  <span className="text-ink/60">{elementLabels[elemKey] || elemKey}</span>
                  {elements[elemKey] && (
                    <span className="text-ink/40 text-[10px]">
                      {typeof elements[elemKey] === 'string' ? elements[elemKey].slice(0, 30) + '...' : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 标志性意象：胶囊自带的视觉锚点，以标签云形式展示 */}
          {elements.imagery && Array.isArray(elements.imagery) && (
            <div className="mb-4">
              <p className="text-ink/50 text-xs mb-2 font-sans">标志性意象：</p>
              <div className="flex flex-wrap gap-1.5">
                {elements.imagery.map((img, idx) => (
                  <span
                    key={idx}
                    className="px-2 py-0.5 rounded-full text-[10px] font-sans"
                    style={{
                      background: 'rgba(168,85,247,0.12)',
                      color: 'var(--sem-purple)',
                      border: '1px solid rgba(168,85,247,0.25)'
                    }}
                  >
                    {img}
                  </span>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="mb-3 flex items-start gap-2 text-rose-300 text-xs">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>

        {/* 底部操作栏：忽略 / 使用胶囊 */}
        <div className="flex gap-2 px-4 py-3 border-t border-line/5">
          <button
            type="button"
            onClick={() => confirmCapsuleUsage('ignore', inspiration)}
            className="glow-btn glass-card flex-1 py-2.5 rounded-xl text-ink/50 hover:text-ink/80 text-xs transition-colors font-sans"
          >
            忽略，按原流程
          </button>
          <button
            type="button"
            onClick={() => confirmCapsuleUsage('use', inspiration)}
            className="glow-btn btn-accent flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-white text-xs font-medium font-sans"
          >
            <Check size={12} />
            <span>使用胶囊</span>
          </button>
        </div>
      </aside>
    )
  }

  // questioning 阶段但 questions 为空（正在加载追问或加载失败）
  // fix3：用 CrystalQuestioningAnim 替换 Loader2，让用户从视觉理解"AI 在草拟问卷"
  if (stage === 'questioning' && (!questions || questions.length === 0)) {
    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        <PanelHeader stage={stage} onCollapse={onCollapse} />
        {loading ? (
          <CrystalQuestioningAnim />
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
            <AlertCircle size={20} className="mb-3 text-rose-400" />
            <p className="text-rose-300 text-xs mb-3">{error}</p>
            <button
              type="button"
              onClick={() => startCrystallize(inspiration)}
              className="glow-btn glass-card px-3 py-1.5 rounded-lg text-ink/60 hover:text-ink/90 text-xs font-sans"
            >
              重试
            </button>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-ink/30 text-xs font-sans">等待追问...</p>
          </div>
        )}
      </aside>
    )
  }

  // questioning：追问阶段
  if (stage === 'questioning' && currentQ) {
    const progress = ((currentIdx + 1) / Math.max(questions.length, 1)) * 100
    // 构造选项列表：LLM 返回的 options + 前端固定追加"其他：请补充"
    const rawOptions = Array.isArray(currentQ.options) ? currentQ.options : []
    const optionsWithOther = [
      ...rawOptions.map((opt) => ({ id: opt, label: opt, isOther: false })),
      { id: '__other__', label: '其他：请补充', isOther: true }
    ]

    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        <PanelHeader stage={stage} onCollapse={onCollapse} />

        {/* 进度条 */}
        <div className="px-4 pt-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-ink/40 text-[11px] font-sans">
              第 {currentIdx + 1} / {questions.length} 题
              {isMulti && <span className="ml-2 text-accent-400" style={{ color: 'var(--accent-cyan-bright)' }}>· 多选{maxSelect ? `（最多 ${maxSelect} 项）` : ''}</span>}
            </span>
            <span className="text-ink/30 text-[10px] font-sans">
              {Math.round(progress)}%
            </span>
          </div>
          <div className="h-1 rounded-full bg-veil/5 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${progress}%`,
                background: 'linear-gradient(90deg, var(--accent-cyan), var(--accent-cyan-bright))',
                boxShadow: '0 0 8px rgb(var(--cyan-rgb) / 0.4)'
              }}
            />
          </div>
        </div>

        {/* 问题主体区（可滚动） */}
        <div className="flex-1 flex flex-col px-4 py-4 overflow-y-auto">
          {/* K4 新增：选做补充题（currentQ.key === '_supplement'）渲染为 textarea，可空提交 */}
          {currentQ.key === '_supplement' ? (
            <>
              <p className="text-ink/90 text-[15px] leading-relaxed mb-5 font-sans animate-fade-in-up">
                {currentQ.text}
              </p>
              <textarea
                autoFocus
                value={currentAnswer}
                onChange={(e) => setCrystallizeAnswer(currentQ.id, e.target.value)}
                rows={5}
                placeholder="请输入你的补充...（选做，可不答）"
                className="input-accent w-full rounded-xl px-3 py-2.5 text-sm text-ink/85 placeholder-ink/25 resize-none mb-3 font-sans"
              />
              <p className="text-ink/30 text-[10px] font-sans">
                这是选做题，可以不答直接进入下一步
              </p>
            </>
          ) : (
            <>
              {/* 问题文本：衬线增加可读性 */}
              <p className="text-ink/90 text-[15px] leading-relaxed mb-5 font-sans animate-fade-in-up">
                {currentQ.text}
              </p>

              {/* 答题区：选择题（2 列网格）vs 文本题 */}
              {currentQ.options ? (
                <>
                  <div className="grid grid-cols-2 gap-2 mb-3 animate-fade-in-up">
                    {optionsWithOther.map((opt) => {
                      // 多选：用 includes 判断；单选：用 === 判断
                      const selected = selectedValues.includes(opt.id)
                      // 多选题达到上限且当前项未选 → 禁用
                      const disabled = isMulti && atMaxLimit && !selected
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => handleOptionClick(opt.id)}
                          disabled={disabled}
                          className={`glow-btn px-3 py-2 rounded-lg text-xs border transition-all text-left font-sans flex items-center gap-1.5 ${
                            opt.isOther ? 'col-span-2' : ''
                          } ${disabled ? 'opacity-30 cursor-not-allowed' : ''}`}
                          style={{
                            borderColor: selected ? 'rgb(var(--cyan-rgb) / 0.6)' : 'rgb(var(--ink) / 0.08)',
                            background: selected ? 'rgb(var(--cyan-rgb) / 0.12)' : 'transparent',
                            color: selected ? 'var(--accent-cyan-bright)' : 'rgb(var(--ink) / 0.65)'
                          }}
                        >
                          {opt.isOther && <PencilLine size={11} className="flex-shrink-0" />}
                          {/* 多选题显示选中标记 */}
                          {isMulti && !opt.isOther && (
                            <span
                              className="flex-shrink-0 w-3 h-3 rounded border flex items-center justify-center"
                              style={{
                                borderColor: selected ? 'rgb(var(--cyan-rgb) / 0.6)' : 'rgb(var(--ink) / 0.2)',
                                background: selected ? 'rgb(var(--cyan-rgb) / 0.4)' : 'transparent'
                              }}
                            >
                              {selected && <Check size={9} style={{ color: '#fff' }} />}
                            </span>
                          )}
                          <span className="leading-snug">{opt.label}</span>
                        </button>
                      )
                    })}
                  </div>

                  {/* 选中"其他"时展开输入框 */}
                  {isOtherSelected && (
                    <textarea
                      autoFocus
                      value={otherText}
                      onChange={(e) => setCrystallizeOtherAnswer(currentQ.id, e.target.value)}
                      rows={3}
                      placeholder="请补充你的想法..."
                      className="input-accent w-full rounded-xl px-3 py-2.5 text-sm text-ink/85 placeholder-ink/25 resize-none mb-3 animate-fade-in-up font-sans"
                    />
                  )}
                </>
              ) : (
                <textarea
                  autoFocus
                  value={currentAnswer === '__other__' ? otherText : currentAnswer}
                  onChange={(e) => {
                    setCrystallizeAnswer(currentQ.id, e.target.value)
                    setCrystallizeOtherAnswer(currentQ.id, e.target.value)
                  }}
                  rows={5}
                  placeholder="请输入你的回答..."
                  className="input-accent w-full rounded-xl px-3 py-2.5 text-sm text-ink/85 placeholder-ink/25 resize-none mb-3 font-sans"
                />
              )}
            </>
          )}

          {error && (
            <div className="mb-3 flex items-start gap-2 text-rose-300 text-xs">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>

        {/* 底部操作栏：跳过 + 下一题/生成 PRD */}
        <div className="flex gap-2 px-4 py-3 border-t border-line/5">
          <button
            type="button"
            onClick={() => skipToPRD(inspiration)}
            disabled={loading}
            className="glow-btn glass-card flex-1 py-2.5 rounded-xl text-ink/50 hover:text-ink/80 text-xs transition-colors disabled:opacity-40 font-sans"
          >
            跳过，直接生成PRD
          </button>
          <button
            type="button"
            onClick={() => answerCrystallizeQuestion(inspiration)}
            disabled={!canSubmitAnswer && currentQ.key !== '_supplement'}
            className="glow-btn btn-accent flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-white text-xs font-medium font-sans"
          >
            {loading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Send size={12} />
            )}
            <span>
              {currentIdx < questions.length - 1 ? '下一题' : '生成结晶'}
            </span>
          </button>
        </div>
      </aside>
    )
  }

  // crystal_preview：结晶体预览与编辑（M3-b：原 prd_preview）
  if (stage === 'crystal_preview') {
    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        <PanelHeader stage={stage} onCollapse={onCollapse} />

        {/* 类型标签 */}
        {inspirationType && (
          <div className="px-4 pt-3">
            <span
              className="inline-block px-2 py-0.5 rounded-full text-[10px] font-sans"
              style={{
                background: 'rgba(168,85,247,0.12)',
                color: 'var(--sem-purple)',
                border: '1px solid rgba(168,85,247,0.25)'
              }}
            >
              {inspirationType} · {crystalType}
            </span>
          </div>
        )}

        {/* 结晶体字段列表（按 crystalType 动态渲染对应类型字段） */}
        <div className="flex-1 px-4 py-4 overflow-y-auto">
          {(CRYSTAL_FIELD_META[crystalType] || CRYSTAL_FIELD_META.free_note).map((field) => {
            // array 类型字段：值为数组，join('\n') 显示；保存时 split('\n')
            // object 类型字段（如 aesthetic_attributes）：转为 "key: value\nkey: value" 可读字符串显示
            // 普通字段：值为字符串，直接显示
            const rawValue = prd?.[field.key]
            let displayValue
            if (field.array) {
              displayValue = Array.isArray(rawValue) ? rawValue.join('\n') : (rawValue || '')
            } else if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
              // object 转 "key: value" 多行字符串（K4-a：aesthetic_attributes 等对象字段的展示）
              displayValue = Object.entries(rawValue)
                .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
                .join('\n')
            } else {
              displayValue = rawValue || ''
            }
            return (
              <PRDField
                key={field.key}
                icon={field.icon}
                label={field.label}
                multiline={field.multiline}
                value={displayValue}
                onSave={(v) => {
                  if (field.array) {
                    updateCrystallizePRDField(field.key, v.split('\n').map((s) => s.trim()).filter(Boolean))
                  } else {
                    updateCrystallizePRDField(field.key, v)
                  }
                }}
              />
            )
          })}

          {error && (
            <div className="mt-3 flex items-start gap-2 text-rose-300 text-xs">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
        </div>

        {/* 底部操作栏：重新生成 + 确认 */}
        <div className="flex gap-2 px-4 py-3 border-t border-line/5">
          <button
            type="button"
            onClick={() => skipToPRD(inspiration)}
            disabled={loading}
            className="glow-btn glass-card flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-ink/55 hover:text-ink/85 text-xs transition-colors disabled:opacity-40 font-sans"
            title="重新调用 LLM 生成 PRD"
          >
            <RotateCcw size={12} />
            <span>重新生成</span>
          </button>
          <button
            type="button"
            onClick={() => confirmPRD(inspiration.id)}
            disabled={loading}
            className="glow-btn btn-accent flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-white text-xs font-medium font-sans"
          >
            {loading ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            <span>确认，进入下一步</span>
          </button>
        </div>
      </aside>
    )
  }

  // done：已完成，展示分流选项
  if (stage === 'done') {
    return (
      <aside className="flex flex-col h-full w-full border-r border-line/5">
        <PanelHeader stage={stage} onCollapse={onCollapse} />

        {/* PRD 摘要卡片 + 分流选项 */}
        <div className="flex-1 px-4 py-4 overflow-y-auto">
          {/* PRD 摘要玻璃态卡片 */}
          <div
            className="glass-card rounded-xl px-4 py-3 mb-4 animate-fade-in-up"
            style={{ borderColor: 'rgb(var(--cyan-rgb) / 0.15)' }}
          >
            <p className="text-ink/40 text-[10px] mb-1 uppercase tracking-wider font-sans">结晶标题</p>
            <p className="font-display text-ink/95 text-base font-semibold mb-2 leading-tight">
              {prd?.title || inspiration?.title}
            </p>
            {prd?.goal && (
              <p className="text-ink/50 text-[11px] leading-relaxed font-sans">
                <span className="text-ink/35">目标：</span>
                {prd.goal.length > 60 ? `${prd.goal.slice(0, 60)}…` : prd.goal}
              </p>
            )}
          </div>

          {/* 分流提示 */}
          <p className="text-ink/40 text-xs mb-3 font-sans">你想怎么继续？</p>

          {/* 分流选项列表 */}
          <div className="space-y-2">
            {DISPATCH_OPTIONS.map((option, idx) => {
              const Icon = option.icon
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => handleDispatch(option)}
                  disabled={dispatching}
                  className="glow-btn w-full flex items-center gap-3 px-3 py-3 rounded-xl border transition-all hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed text-left animate-fade-in-up glass-card font-sans"
                  data-glow={option.id === 'epitaxy' ? 'purple' : undefined}
                  style={{
                    borderColor: `${option.color}30`,
                    background: `${option.color}08`,
                    animationDelay: `${idx * 50}ms`
                  }}
                >
                  {/* 图标方块 */}
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: `${option.color}20`, color: option.color }}
                  >
                    <Icon size={15} />
                  </div>
                  {/* 标签 + 描述 */}
                  <div className="flex-1 min-w-0">
                    <p className="text-ink/85 text-xs font-medium">{option.label}</p>
                    <p className="text-ink/35 text-[10px] mt-0.5 leading-relaxed">{option.description}</p>
                  </div>
                </button>
              )
            })}
          </div>

          {error && (
            <div className="mt-3 flex items-start gap-2 text-rose-300 text-xs">
              <AlertCircle size={12} className="mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}
          {dispatching && (
            <div className="mt-3 flex items-center gap-2 text-ink/50 text-xs">
              <Loader2 size={12} className="animate-spin" />
              <span>正在分流到下一 Agent...</span>
            </div>
          )}
        </div>

        {/* 底部操作栏：重新开始 */}
        <div className="flex gap-2 px-4 py-3 border-t border-line/5">
          <button
            type="button"
            onClick={() => resetCrystallize()}
            className="glow-btn glass-card flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-ink/55 hover:text-ink/85 text-xs transition-colors font-sans"
          >
            <RotateCcw size={12} />
            <span>重新开始</span>
          </button>
        </div>
      </aside>
    )
  }

  // 兜底：未知 stage 不渲染（理论上不会到达）
  return null
}

export default CrystallizePanel
