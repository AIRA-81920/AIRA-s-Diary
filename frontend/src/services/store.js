// Zustand 全局状态管理
// 功能：管理灵感列表、选中灵感、加载/错误状态、搜索词、面板状态与弹窗开关
// 实现方式：使用 zustand 的 create 创建 store，所有 async action 内部 try/catch 并维护 error
//
// M3 变更：原 clarify* 状态与 actions 全部重命名为 crystallize*
//   - clarifyStage → crystallizeStage
//   - clarifyPRD → crystallizePRD
//   - clarifyQuestions → crystallizeQuestions
//   - clarifyCurrentIdx → crystallizeCurrentIdx
//   - clarifyAnswers → crystallizeAnswers
//   - clarifyOtherAnswers → crystallizeOtherAnswers
//   - clarifyConversation → crystallizeConversation
//   - clarifyLoading → crystallizeLoading
//   - clarifyError → crystallizeError
//   - clarifyCollapsed → crystallizeCollapsed
//   - clarifyDispatching → crystallizeDispatching
//   - resetClarify → resetCrystallize
//   - loadClarifyLatest → loadCrystallizeLatest
//   - startClarify → startCrystallize
//   - answerClarifyQuestion → answerCrystallizeQuestion
//   - setClarifyAnswer → setCrystallizeAnswer
//   - setClarifyOtherAnswer → setCrystallizeOtherAnswer
//   - nextClarifyQuestion → nextCrystallizeQuestion
//   - updateClarifyPRDField → updateCrystallizePRDField
//   - dispatchFromClarify → dispatchFromCrystallize
//   - toggleClarifyPanel → toggleCrystallizePanel
import { create } from 'zustand'
import * as api from './api.js'

/**
 * 时间格式化工具
 * 功能：将 ISO 时间字符串或 Date 格式化为 YYYY-MM-DD HH:mm
 * 实现方式：手动 padStart 补零，避免引入额外的日期库
 * @param {string|Date} value
 * @returns {string}
 */
export function formatTime(value) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// ========== v9：AI 回复 [CORE] 标签解析工具 ==========
// 设计背景：AI 在回复中用 [CORE]...[/CORE] 标签包裹核心观点，
//   前端需要：(1) 流式渲染时不显示标签本身；(2) 流结束后解析出 core/context 分层存储
//   解析规则：
//     - core：第一个 [CORE]...[/CORE] 块内的文本（trim 后）
//     - context：标签外的所有文本（按原顺序拼接，trim 后）；无 core 时 context 为完整文本
//     - 一条回复最多一个 [CORE] 块（多余的被当作普通文本处理）

/**
 * 从含 [CORE] 标签的原始文本中解析出 core 与 context
 * 功能：提取第一个 [CORE]...[/CORE] 块作为 core；标签外的文本作为 context
 * 实现方式：正则非贪婪匹配首个 [CORE] 块；无匹配时 core=null，context=清理后的全文
 * @param {string} rawText - AI 回复的完整原文（可能含 [CORE] 标签）
 * @returns {{core: string|null, context: string|null}}
 */
export function parseCoreContext(rawText) {
  if (!rawText) return { core: null, context: null }
  // 非贪婪匹配首个 [CORE] 块；[\s\S] 保证跨行匹配
  const match = rawText.match(/\[CORE\]([\s\S]*?)\[\/CORE\]/)
  // 通用清理：移除所有完整 [CORE]/[/CORE] 标签（处理边缘情况下的多余标签）
  const stripTags = (s) => s.replace(/\[CORE\]/g, '').replace(/\[\/CORE\]/g, '').trim()
  if (!match) {
    // 无标签：core 为 null，context 为清理后的全文（兼容旧数据）
    const cleaned = stripTags(rawText)
    return { core: null, context: cleaned || null }
  }
  const core = match[1].trim() || null
  // context = 标签前 + 标签后的文本，去掉残留标签后 trim
  const before = rawText.slice(0, match.index)
  const after = rawText.slice(match.index + match[0].length)
  const context = stripTags(before + after)
  return { core, context: context || null }
}

/**
 * 计算流式渲染时的显示文本（隐藏 [CORE] 标签本身，避免闪烁）
 * 功能：从 rawText 派生 displayText —— 移除完整标签 + 暂存尾部"半截标签"避免闪烁
 * 实现方式：
 *   1. 检测 rawText 末尾是否为 '[CORE]' 或 '[/CORE]' 的前缀（如 '[CO'、'[/C'）
 *   2. 若是，从 displayText 末尾暂时砍掉这部分（hold-back），等下一 chunk 补全后再决定
 *   3. 移除剩余文本中所有完整的 [CORE]/[/CORE] 标签
 *   注意：onDone 时不需 hold-back（流已结束，残留必为完整标签或字面量），直接 stripTags
 * @param {string} rawText - 当前累积的完整原文
 * @returns {string} 用于渲染的显示文本
 */
export function computeDisplayText(rawText) {
  if (!rawText) return ''
  // 检测尾部"半截标签"：rawText 末尾若为 '[CORE]' 或 '[/CORE]' 的前缀，holdBack 记录其长度
  const tags = ['[CORE]', '[/CORE]']
  let holdBack = 0
  for (const tag of tags) {
    // 从最长前缀开始检测（length-1 到 1），取首个匹配（即最长匹配）
    for (let len = Math.min(tag.length - 1, rawText.length); len >= 1; len--) {
      if (rawText.endsWith(tag.slice(0, len))) {
        holdBack = Math.max(holdBack, len)
        break
      }
    }
  }
  // 砍掉尾部半截标签，避免显示 '[CO' 这类闪烁文本
  const safePart = rawText.slice(0, rawText.length - holdBack)
  // 移除所有完整标签
  return safePart.replace(/\[CORE\]/g, '').replace(/\[\/CORE\]/g, '')
}

// fragment.type → chunk kind 映射
// 功能：把 Epitaxy fragment 的类型映射到 knowledge_chunks 表的 kind 枚举
// 实现方式：existing_case→reference（案例≈引用）, concept→concept, warning→warning, blank→material
const FRAG_TYPE_TO_KIND = {
  existing_case: 'reference',
  concept: 'concept',
  warning: 'warning',
  blank: 'material'
}

const useStore = create((set, get) => ({
  // ========== 状态 ==========
  inspirations: [],          // 灵感列表
  selectedInspiration: null, // 当前选中的灵感
  isLoading: false,          // 列表加载态
  error: null,               // 最近一次错误信息
  searchQuery: '',           // 当前搜索关键词
  panelStates: {},           // 各灵感的面板状态：{ [inspirationId]: state }
  isModalOpen: false,        // 录入/编辑弹窗是否打开
  editingInspiration: null,  // 正在编辑的灵感；null 表示新建模式
  // 当前主题（'dark' | 'light'）；初始值读 localStorage，启动时 index.jsx 已同步 <html data-theme>
  theme: (typeof localStorage !== 'undefined' && localStorage.getItem('aira-theme')) || 'dark',

  // ========== 文件夹 Slice（v8 新增） ==========
  folders: [],                    // 文件夹列表 [{id, name, color, sort_order, inspiration_count}]
  folderExpanded: {},             // 文件夹展开状态 { [folderId]: boolean }
  folderEditModal: null,          // 正在编辑的文件夹 {id, name, color} | null

  // ========== Actions ==========

  /**
   * 切换主题
   * 功能：更新 store 状态 + 持久化 localStorage + 同步 <html data-theme>（CSS 变量随选择器翻转）
   * 实现方式：手写 localStorage（项目无 persist 中间件先例）
   * @param {'dark'|'light'} theme
   */
  setTheme: (theme) => {
    try {
      localStorage.setItem('aira-theme', theme)
    } catch { /* 隐私模式等场景下写失败可忽略 */ }
    document.documentElement.dataset.theme = theme
    set({ theme })
  },

  /**
   * 加载灵感列表
   * 功能：根据当前 searchQuery 拉取灵感列表，维护 isLoading 与 error
   */
  loadInspirations: async () => {
    set({ isLoading: true, error: null })
    try {
      const { searchQuery } = get()
      const result = await api.getInspirations({ search: searchQuery })
      // 列表接口返回 { data, total }
      set({ inspirations: result.data || [], isLoading: false })
    } catch (err) {
      set({ error: err.message, isLoading: false })
    }
  },

  /**
   * 设置选中灵感，并同步加载该灵感的面板状态与结晶最新记录
   * 功能：切换灵感时立即重置 crystallize 状态，避免异步加载完成前显示上个灵感的 PRD
   * 实现方式：先调用 resetCrystallize() 清空状态，再 set selectedInspiration，最后异步加载新数据
   */
  setSelectedInspiration: (inspiration) => {
    // 立即重置所有 crystallize 状态，避免切换瞬间的状态污染（PRD 草稿串到下一个灵感）
    get().resetCrystallize()
    // M3-c：同时重置 epitaxy 状态
    get().resetEpitaxy()
    // M3-e：同时重置 coalesce 状态
    get().resetCoalesce()
    // K3-d：重置 archive 状态（避免上个灵感档案残留）
    get().resetArchive()
    // K3-e：关闭抽屉（drawerCache 保留供"接着干"，§10.4 重置策略）
    set({ drawer: 'none', expandedStage: 'none' })
    set({ selectedInspiration: inspiration })
    if (inspiration && inspiration.id) {
      // 选中灵感时自动挤压 Sidebar（仅当用户未手动拖拽过）
      const { sidebarUserOverride, sidebarWidthShrunk } = get()
      if (!sidebarUserOverride) {
        set({ sidebarWidth: sidebarWidthShrunk })
      }
      // v8：选中灵感时自动展开其所属文件夹
      if (inspiration.folder_id) {
        set((state) => ({
          folderExpanded: { ...state.folderExpanded, [inspiration.folder_id]: true }
        }))
      }
      // 异步加载面板状态与最新结晶记录，失败时不影响主流程
      get().loadPanelState(inspiration.id)
      get().loadCrystallizeLatest(inspiration.id)
      // K3-d：加载档案馆聚合数据（Detail 唯一数据源）
      get().loadArchive(inspiration.id)
    } else {
      // 取消选中：重置 crystallize 状态（resetCrystallize 已在上面调用过，此处保持幂等）
      get().resetCrystallize()
      // 恢复 Sidebar 默认宽度
      get().resetSidebarWidth()
      // fix5-1：同时恢复 Sidebar 挤压态（点 X 回主界面后 Sidebar 要展开回原宽度）
      set({ sidebarCompressed: false })
    }
  },

  /**
   * 创建灵感
   * 功能：调用 api 创建，成功后插入列表头部、设为选中并关闭弹窗
   * K3-g 修复：必须走 setSelectedInspiration 统一路径，否则新灵感会继承上个灵感的
   *   archiveData/crystallizePRD/epitaxyProposals 等状态（reset 逻辑被绕过）
   */
  createInspiration: async (data) => {
    set({ error: null })
    try {
      const result = await api.createInspiration(data)
      if (result.success && result.data) {
        const created = result.data
        // unshift 到列表头部，保持最新优先
        set((state) => ({
          inspirations: [created, ...state.inspirations],
          isModalOpen: false,
          editingInspiration: null
        }))
        // K3-g：走统一切换路径，确保所有阶段状态被 reset（防继承上个灵感数据）
        get().setSelectedInspiration(created)
        return created
      }
    } catch (err) {
      set({ error: err.message })
    }
  },

  /**
   * 更新灵感
   * 功能：调用 api 更新，成功后同步刷新列表项与 selectedInspiration，并关闭弹窗
   */
  updateInspiration: async (id, data) => {
    set({ error: null })
    try {
      const result = await api.updateInspiration(id, data)
      if (result.success && result.data) {
        const updated = result.data
        set((state) => ({
          inspirations: state.inspirations.map((ins) =>
            ins.id === id ? updated : ins
          ),
          selectedInspiration:
            state.selectedInspiration && state.selectedInspiration.id === id
              ? updated
              : state.selectedInspiration,
          isModalOpen: false,
          editingInspiration: null
        }))
        return updated
      }
    } catch (err) {
      set({ error: err.message })
    }
  },

  /**
   * 删除灵感
   * 功能：调用 api 删除，成功后从列表移除；若删除的是当前选中则清空选中并重置所有阶段状态
   * K3-g 修复：删除当前选中灵感时，必须显式 reset 所有阶段状态
   *   （resetCrystallize/Epitaxy/Coalesce/Archive + clearDrawerCache），
   *   否则新建同名灵感时会继承上个灵感的 archiveData/PRD/proposals 等残留
   */
  deleteInspiration: async (id) => {
    set({ error: null })
    try {
      const result = await api.deleteInspiration(id)
      if (result.success) {
        const wasSelected = get().selectedInspiration?.id === id
        set((state) => ({
          inspirations: state.inspirations.filter((ins) => ins.id !== id),
          selectedInspiration: wasSelected ? null : state.selectedInspiration
        }))
        // K3-e：清理被删除灵感的抽屉快照（避免脏数据残留）
        get().clearDrawerCache(id)
        // K3-g：若删除的是当前选中灵感，重置所有阶段状态（防止新建灵感继承）
        if (wasSelected) {
          get().resetCrystallize()
          get().resetEpitaxy()
          get().resetCoalesce()
          get().resetArchive()
          set({ drawer: 'none', expandedStage: 'none' })
        }
      }
    } catch (err) {
      set({ error: err.message })
    }
  },

  /**
   * 设置搜索词并立即刷新列表
   */
  setSearchQuery: (query) => {
    set({ searchQuery: query })
    get().loadInspirations()
  },

  /**
   * 打开弹窗
   * @param {object|null} inspiration - null 表示新建模式
   */
  openModal: (inspiration = null) => {
    set({ isModalOpen: true, editingInspiration: inspiration })
  },

  /**
   * 关闭弹窗并清空编辑态
   */
  closeModal: () => {
    set({ isModalOpen: false, editingInspiration: null })
  },

  /**
   * 加载指定灵感的面板状态，存入 panelStates
   */
  loadPanelState: async (inspirationId) => {
    try {
      const result = await api.getPanelState(inspirationId)
      set((state) => ({
        panelStates: {
          ...state.panelStates,
          [inspirationId]: result.data || {}
        }
      }))
    } catch (err) {
      // 面板状态加载失败不抛到全局 error，仅静默处理
      console.warn('[store] 加载面板状态失败:', err.message)
    }
  },

  /**
   * 保存面板状态，并同步更新本地缓存
   */
  savePanelState: async (inspirationId, state) => {
    try {
      const result = await api.savePanelState(inspirationId, state)
      set((st) => ({
        panelStates: {
          ...st.panelStates,
          [inspirationId]: result.data || state
        }
      }))
    } catch (err) {
      console.warn('[store] 保存面板状态失败:', err.message)
    }
  },

  // ========== Crystallize（灵感结晶）状态与 Actions ==========
  // 状态机（M3-b 改造）：idle → sensing → sense_confirm → questioning → crystal_preview → done
  //   - sensing：自动调用 LLM 感知类型
  //   - sense_confirm：confidence < 0.85 时让用户确认/修正类型
  //   - questioning：按类型生成定制化问题（支持多选）
  //   - crystal_preview：按 crystal_type 生成对应字段结构的结晶体
  //   - done：已完成，可手动分流到 Epitaxy/Coalesce
  crystallizeStage: 'idle',                  // idle | sensing | sense_confirm | questioning | crystal_preview | done
  crystallizePRD: null,                      // 结晶体（M3-b 后字段结构按 crystal_type 决定，变量名保留兼容）
  crystallizeQuestions: [],                  // 当前一轮的追问问题列表
  crystallizeCurrentIdx: 0,                  // 当前问题索引
  crystallizeAnswers: {},                    // { [questionId]: string | string[] } 选中选项（单选为字符串，多选为数组）
  crystallizeOtherAnswers: {},               // { [questionId]: string } "其他：请补充"输入框内容
  crystallizeConversation: [],               // 对话历史 [{ role, content }]
  crystallizeLoading: false,                 // 加载态（questioning/crystal 生成中）
  crystallizeError: null,                    // 错误信息
  crystallizeCollapsed: false,               // 面板收起态
  crystallizeDispatching: false,             // 分流中状态
  // M3-b 新增：Sense 阶段相关状态
  inspirationType: null,                     // 灵感类型（8 种之一 + "其他"）
  inspirationTypeConfidence: 0,              // Sense 置信度（0-1）
  inspirationTypeAlternatives: [],           // 备选类型列表
  inspirationTypeReasoning: '',              // LLM 判断推理说明
  crystalType: null,                         // 结晶形态（prd/scene_card/worldview/...）
  senseLoading: false,                       // Sense 阶段加载态（独立于 crystallizeLoading）

  // ========== K4 新增：胶囊识别与决策 ==========
  // 设计：sense 阶段识别到设定胶囊后，进入 capsule_detection 中间态让用户决定是否使用
  detectedCapsules: [],                      // 识别到的胶囊数组（含 key/name/elements/applicable_elements）
  capsuleDecision: null,                     // 'use' | 'ignore' | null（用户选择）

  // ========== K4 新增：Sense 阶段 5 信号与 concept_orientation ==========
  // 设计：低置信度时让用户看到 5 信号详情，concept_orientation 影响后续 Epitaxy 深挖方向
  senseSignals: null,                        // 5 信号详情（noun_abstractness/verb_type/form_binding/definition_vs_making/expected_question_direction）
  conceptScore: 0,                           // 概念命题得分
  productScore: 0,                           // 产品想法得分
  conceptOrientation: null,                  // 概念命题指向（understanding/action/creation）

  // ========== K4 新增：LLM 选择的维度路径 ==========
  // 设计：_buildPrompt 让 LLM 选择维度路径，前端展示 selected_dimensions 用于透明化
  selectedDimensions: [],                    // LLM 选择的维度路径数组

  // ========== 布局状态 ==========
  // 设计思路：用户可自行拖拽各面板宽度，选中灵感时 Sidebar 自动挤压
  // sidebarWidth / leftPanelWidth 持久化到 panelStates（按灵感隔离）
  sidebarWidth: 280,                     // 当前 Sidebar 宽度（px）
  sidebarWidthDefault: 280,              // 未选中灵感时的默认宽度
  sidebarWidthShrunk: 220,               // 选中灵感时的自动挤压宽度
  sidebarUserOverride: false,            // 用户是否手动拖拽过（true 后不再自动挤压）
  leftPanelWidth: 360,                   // 当前左面板（CrystallizePanel）宽度（px）
  leftPanelWidthDefault: 360,            // 默认宽度
  leftPanelWidthMin: 320,                // 最小宽度（防止内容挤压变形）
  leftPanelWidthMax: 480,                // 最大宽度
  sidebarWidthMin: 200,                  // Sidebar 最小宽度（展开态）
  sidebarWidthMax: 380,                  // Sidebar 最大宽度（展开态）
  // fix5-3：挤压态宽度独立存储，允许用户在挤压态拖拽调整
  sidebarCompressedWidth: 80,            // 挤压态当前宽度（px）
  sidebarCompressedWidthMin: 80,         // 挤压态最小宽度
  sidebarCompressedWidthMax: 240,        // 挤压态最大宽度（超过此值意义不大，不如切回展开态）

  /**
   * 切换 CrystallizePanel 展开/收起
   */
  toggleCrystallizePanel: () => {
    set((st) => ({ crystallizeCollapsed: !st.crystallizeCollapsed }))
  },

  /**
   * 设置 Sidebar 宽度（拖拽时调用）
   * 功能：更新 sidebarWidth 并标记用户已手动调整（之后不再自动挤压）
   * @param {number} width - 新宽度（px）
   */
  setSidebarWidth: (width) => {
    const { sidebarWidthMin, sidebarWidthMax } = get()
    const clamped = Math.min(sidebarWidthMax, Math.max(sidebarWidthMin, width))
    set({ sidebarWidth: clamped, sidebarUserOverride: true })
  },

  /**
   * 设置左面板宽度（拖拽时调用）
   * @param {number} width - 新宽度（px）
   */
  setLeftPanelWidth: (width) => {
    const { leftPanelWidthMin, leftPanelWidthMax } = get()
    const clamped = Math.min(leftPanelWidthMax, Math.max(leftPanelWidthMin, width))
    set({ leftPanelWidth: clamped })
  },

  /**
   * fix5-3：设置挤压态 Sidebar 宽度（挤压态拖拽时调用）
   * 功能：挤压态下用户拖拽手柄调整 Sidebar 宽度，独立于展开态宽度
   * 实现方式：夹紧到 [80, 240]，更新 sidebarCompressedWidth
   * @param {number} width - 新宽度（px）
   */
  setSidebarCompressedWidth: (width) => {
    const { sidebarCompressedWidthMin, sidebarCompressedWidthMax } = get()
    const clamped = Math.min(sidebarCompressedWidthMax, Math.max(sidebarCompressedWidthMin, width))
    set({ sidebarCompressedWidth: clamped })
  },

  /**
   * 重置 Sidebar 宽度到默认值
   * 功能：用户清空选中灵感时调用，恢复默认宽度
   */
  resetSidebarWidth: () => {
    set({ sidebarWidth: get().sidebarWidthDefault, sidebarUserOverride: false })
  },

  // ========== K3-e Workbench 抽屉 Slice（架构文档 §10.4 WorkbenchSlice）==========
  // 设计思路：阶段面板降级为"替换式抽屉"（ADR-4）
  //   - 一次仅打开一个抽屉（drawer: 'none' | 'crystallize' | 'epitaxy'）
  //   - 抽屉打开时 Detail 不渲染（替换式，不挤压 Detail）
  //   - 关闭抽屉时中间态保存到 drawerCache（仅内存，不持久化）
  //   - 重新打开抽屉时如有快照则恢复，实现"接着干"
  //   - drawerCache LRU 上限 20（R8），超出淘汰最旧
  //   - 切换灵感时：drawer → 'none'（关闭），但 drawerCache 保留（§10.4 重置策略）
  drawer: 'none',                          // 'none' | 'crystallize' | 'epitaxy' | 'conversation'
  drawerCache: {},                         // { [inspirationId]: { kind, savedAt, snapshot, drawerWidth } }，仅内存
  drawerWidth: 520,                        // 抽屉宽度（px），可拖拽调整；K4-b 加宽 420→520
  drawerWidthMin: 440,                     // 抽屉最小宽度；K4-b 加宽 360→440
  drawerWidthMax: 720,                     // 抽屉最大宽度；K4-b 加宽 560→720
  drawerWidthDefault: 520,                 // 抽屉默认宽度（双击手柄 reset 用）
  DRAWER_CACHE_LIMIT: 20,                  // drawerCache LRU 上限（R8）

  // ========== K4-b 改进点 1：Sidebar 挤压态 + 外延联动 ==========
  // 设计：抽屉打开时 Sidebar 自动挤压到 80px（图标模式），关闭时恢复
  // selectedProposalId 用于外延联动：抽屉选卡片 → Detail 显示对应 fragments
  sidebarCompressed: false,                // 抽屉打开时 true，Sidebar 挤压到 80px
  selectedProposalId: null,                // 当前深挖的 proposal ID（外延联动用）

  // ========== Settings（设置面板）==========
  settingsOpen: false,                     // 设置浮窗是否打开
  settingsLoading: false,                   // 设置数据加载中
  settingsSaving: false,                    // 设置数据保存中
  settingsData: null,                       // { global, agents, search } - 当前 .env 数据
  settingsError: null,                      // 设置操作错误信息
  settingsTesting: false,                   // API 检测中
  testResults: null,                        // 检测结果数组 [{ name, ok, latency, reply/error }]

  // ========== K3-f ForceGraph 力导向图 Slice（架构文档 §5.4 Layer 2）==========
  // 设计思路：全屏覆盖层（z-index 最高），打开时 Layer 1 冻结不卸载
  //   - forceGraphOpen：覆盖层是否打开
  //   - forceGraphData：graph 接口返回的 { nodes, edges }
  //   - forceGraphViewport：视图状态（zoom/translate），重开恢复视角（§5.4 规则）
  //   - forceGraphLoading/error：加载态
  //   - 节点上限 500（R5），超出截断 + 计数提示
  forceGraphOpen: false,
  forceGraphData: null,                    // { nodes: [], edges: [] } 或 null
  forceGraphLoading: false,
  forceGraphError: null,
  forceGraphViewport: null,                // { x, y, k } d3-zoom 状态，null 表示默认
  FORCE_GRAPH_NODE_LIMIT: 500,             // 节点上限（R5）

  /**
   * 打开 ForceGraph 覆盖层
   * 功能：触发 graph 接口加载 + 设置 forceGraphOpen = true
   * 实现方式：
   *   1. 调用 api.getCoalesceGraph() 获取全量节点+边
   *   2. 节点超出上限截断（保留 bridgeCount 最高的）
   *   3. 设置 forceGraphOpen = true，恢复 viewport（如有）
   */
  openForceGraph: async () => {
    set({ forceGraphOpen: true, forceGraphLoading: true, forceGraphError: null })
    try {
      const result = await api.getCoalesceGraph()
      if (result.success === false) {
        set({ forceGraphError: result.error || '加载图谱失败', forceGraphLoading: false })
        return
      }
      const data = result.data || { nodes: [], edges: [] }
      // R5：节点上限截断（保留 bridgeCount 最高的）
      // 2026-07 修正：节点已含孤立节点，截断时优先保留有桥节点，剩余配额留给孤立节点
      const limit = get().FORCE_GRAPH_NODE_LIMIT
      let truncated = false
      let finalData = data
      if (data.nodes && data.nodes.length > limit) {
        const withBridges = data.nodes.filter(n => n.hasBridges)
        const isolated = data.nodes.filter(n => !n.hasBridges)
        // 有桥节点按 bridgeCount 降序，超出 limit 时按 limit 截断
        const connectedKept = withBridges
          .sort((a, b) => (b.bridgeCount || 0) - (a.bridgeCount || 0))
          .slice(0, limit)
        // 剩余配额给孤立节点
        const remaining = Math.max(0, limit - connectedKept.length)
        const isolatedKept = isolated.slice(0, remaining)
        const keptIds = new Set([...connectedKept, ...isolatedKept].map(n => n.id))
        finalData = {
          nodes: [...connectedKept, ...isolatedKept],
          edges: (data.edges || []).filter(e => keptIds.has(e.source) && keptIds.has(e.target)),
          truncatedCount: data.nodes.length - keptIds.size
        }
        truncated = true
      }
      set({
        forceGraphData: finalData,
        forceGraphLoading: false,
        forceGraphTruncated: truncated
      })
    } catch (err) {
      set({ forceGraphError: err.message, forceGraphLoading: false })
    }
  },

  /**
   * 关闭 ForceGraph 覆盖层
   * 功能：关闭覆盖层，保留 data 和 viewport 供重开恢复
   * 实现方式：仅设置 forceGraphOpen = false，不清理 data/viewport
   */
  closeForceGraph: () => {
    set({ forceGraphOpen: false })
  },

  /**
   * 保存 ForceGraph 视图状态（d3-zoom transform）
   * 功能：用户平移/缩放时实时保存，重开恢复
   * @param {{ x: number, y: number, k: number }} viewport
   */
  setForceGraphViewport: (viewport) => {
    set({ forceGraphViewport: viewport })
  },

  /**
   * 点击 ForceGraph 节点：关闭覆盖层并跳转该灵感 Detail
   * 功能：§5.4 规则——点击节点 → 关闭覆盖层并跳转该灵感 Detail
   * 实现方式：
   *   1. 关闭 ForceGraph 覆盖层
   *   2. 从 inspirations 列表查找节点对应灵感
   *   3. 调用 setSelectedInspiration 跳转 Detail
   * @param {string} inspirationId
   */
  clickForceGraphNode: (inspirationId) => {
    if (!inspirationId) return
    get().closeForceGraph()
    const target = get().inspirations.find(i => i.id === inspirationId)
    if (target) {
      get().setSelectedInspiration(target)
    }
  },

  /**
   * 打开抽屉
   * 功能：召唤指定类型的工作台抽屉，如有快照则恢复中间态
   * 实现方式：
   *   1. 关闭当前抽屉（如有）并保存快照
   *   2. 检查 drawerCache[inspirationId] 是否有同 kind 的快照
   *   3. 有快照：恢复快照字段（crystallize/epitaxy 状态）
   *   4. 无快照：保持当前已 reset 的状态（用户从空白开始）
   *   5. 设置 drawer = kind
   * @param {string} kind - 'crystallize' | 'epitaxy'
   * @param {string} inspirationId - 灵感 ID
   */
  openDrawer: (kind, inspirationId) => {
    if (!kind || !inspirationId) return
    const current = get().drawer
    // 若切换抽屉类型，先保存当前快照
    if (current !== 'none' && current !== kind) {
      get()._saveDrawerSnapshot(current)
    }
    // 尝试恢复快照
    const cached = get().drawerCache[inspirationId]
    if (cached && cached.kind === kind && cached.snapshot) {
      get()._restoreDrawerSnapshot(cached.snapshot)
    }
    // K4-b 改进点 1：打开抽屉时挤压 Sidebar（80px 图标模式）
    set({ drawer: kind, sidebarCompressed: true })
  },

  /**
   * 关闭抽屉
   * 功能：关闭当前抽屉，保存中间态到 drawerCache（"接着干"）
   * 实现方式：
   *   1. 保存当前抽屉的中间态快照
   *   2. 设置 drawer = 'none'
   *   3. 不重置 crystallize/epitaxy 状态（用户切换灵感时才重置）
   *   4. 触发 loadArchive 刷新 Detail 显示最新产物
   */
  closeDrawer: () => {
    const current = get().drawer
    if (current === 'none') return
    get()._saveDrawerSnapshot(current)
    // K4-b 改进点 1：关闭抽屉时恢复 Sidebar 宽度 + 清空选中 proposal
    set({ drawer: 'none', sidebarCompressed: false, selectedProposalId: null })
    // 关闭抽屉后刷新 Detail 档案馆（产物沉淀显示）
    const { selectedInspiration } = get()
    if (selectedInspiration?.id) {
      get().loadArchive(selectedInspiration.id)
    }
  },

  // ========== Settings（设置面板）Actions ==========

  /**
   * 打开设置浮窗并加载最新 .env 数据
   * GET /api/settings/env → settingsData
   */
  openSettings: async () => {
    set({ settingsOpen: true, settingsLoading: true, settingsError: null })
    try {
      const res = await fetch('/api/settings/env')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      set({ settingsData: data, settingsLoading: false })
    } catch (err) {
      set({ settingsError: err.message, settingsLoading: false })
    }
  },

  /**
   * 关闭设置浮窗
   */
  closeSettings: () => {
    set({ settingsOpen: false })
  },

  /**
   * 保存设置到 .env
   * PUT /api/settings/env → 后端写 .env → nodemon 重启
   */
  saveSettings: async (data) => {
    set({ settingsSaving: true, settingsError: null })
    try {
      const res = await fetch('/api/settings/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await res.json()
      set({ settingsData: data, settingsSaving: false })
    } catch (err) {
      set({ settingsError: err.message, settingsSaving: false })
    }
  },

  /**
   * 检测 API 配置是否可用（不写入 .env）
   * POST /api/settings/env/test → testResults
   */
  testSettings: async (data) => {
    set({ settingsTesting: true, testResults: null, settingsError: null })
    try {
      const res = await fetch('/api/settings/env/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { results } = await res.json()
      set({ testResults: results, settingsTesting: false })
    } catch (err) {
      set({ settingsError: err.message, settingsTesting: false })
    }
  },

  /**
   * 清除检测结果
   */
  clearTestResults: () => set({ testResults: null }),

  /**
   * K4-b 改进点 1：设置当前选中的 proposal（外延联动用）
   * 功能：抽屉里点击方向卡片时调用，Detail 据此显示对应 fragments
   * @param {string|null} proposalId - proposal ID 或 null（取消选中）
   */
  setSelectedProposalId: (proposalId) => {
    set({ selectedProposalId: proposalId })
  },

  /**
   * 清理指定灵感的抽屉快照
   * 功能：删除灵感或显式清理时调用
   * @param {string} inspirationId
   */
  clearDrawerCache: (inspirationId) => {
    set((st) => {
      const next = { ...st.drawerCache }
      delete next[inspirationId]
      return { drawerCache: next }
    })
  },

  /**
   * 设置抽屉宽度（拖拽时调用）
   * @param {number} width
   */
  setDrawerWidth: (width) => {
    const { drawerWidthMin, drawerWidthMax } = get()
    const clamped = Math.min(drawerWidthMax, Math.max(drawerWidthMin, width))
    set({ drawerWidth: clamped })
  },

  /**
   * 保存抽屉中间态快照（私有方法）
   * 功能：把当前 crystallize/epitaxy 的中间态字段打包保存到 drawerCache
   * 实现方式：
   *   - 提取关键字段（用户编辑中的草稿，非已沉淀产物）
   *   - LRU 淘汰：超出上限删除最旧
   * @private
   * @param {string} kind - 抽屉类型
   */
  _saveDrawerSnapshot: (kind) => {
    const { selectedInspiration, drawerCache, DRAWER_CACHE_LIMIT } = get()
    if (!selectedInspiration?.id) return
    // conversation 抽屉无中间态快照（消息流从 saved_replies 重建），跳过保存避免覆盖 crystallize/epitaxy 快照
    if (kind === 'conversation') return
    const inspirationId = selectedInspiration.id

    // 提取中间态字段（区分 crystallize / epitaxy）
    const snapshot = {}
    if (kind === 'crystallize') {
      const s = get()
      Object.assign(snapshot, {
        crystallizeStage: s.crystallizeStage,
        crystallizePRD: s.crystallizePRD,
        crystallizeQuestions: s.crystallizeQuestions,
        crystallizeCurrentIdx: s.crystallizeCurrentIdx,
        crystallizeAnswers: s.crystallizeAnswers,
        crystallizeOtherAnswers: s.crystallizeOtherAnswers,
        crystallizeConversation: s.crystallizeConversation,
        inspirationType: s.inspirationType,
        inspirationTypeConfidence: s.inspirationTypeConfidence,
        inspirationTypeAlternatives: s.inspirationTypeAlternatives,
        inspirationTypeReasoning: s.inspirationTypeReasoning,
        crystalType: s.crystalType,
        // K4 新增：胶囊识别与决策中间态
        detectedCapsules: s.detectedCapsules,
        capsuleDecision: s.capsuleDecision,
        senseSignals: s.senseSignals,
        conceptScore: s.conceptScore,
        productScore: s.productScore,
        conceptOrientation: s.conceptOrientation,
        selectedDimensions: s.selectedDimensions
      })
    } else if (kind === 'epitaxy') {
      const s = get()
      Object.assign(snapshot, {
        epitaxyStage: s.epitaxyStage,
        epitaxyProposals: s.epitaxyProposals,
        epitaxyViewedProposals: s.epitaxyViewedProposals,
        epitaxySelectedProposal: s.epitaxySelectedProposal,
        epitaxyFragments: s.epitaxyFragments,
        epitaxySelectedChunks: s.epitaxySelectedChunks,
        epitaxyDistilledChunks: s.epitaxyDistilledChunks
      })
    }

    const next = { ...drawerCache }
    // LRU 淘汰：超出上限删除最旧（按 savedAt 排序）
    if (Object.keys(next).length >= DRAWER_CACHE_LIMIT) {
      const sorted = Object.entries(next).sort(
        (a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0)
      )
      if (sorted.length > 0) {
        delete next[sorted[0][0]]
      }
    }
    next[inspirationId] = {
      kind,
      savedAt: Date.now(),
      snapshot,
      drawerWidth: get().drawerWidth
    }
    set({ drawerCache: next })
  },

  /**
   * 恢复抽屉中间态快照（私有方法）
   * 功能：从 drawerCache 恢复 crystallize/epitaxy 中间态字段
   * 实现方式：直接 set 快照中的字段（覆盖当前已 reset 的状态）
   * @private
   * @param {object} snapshot - _saveDrawerSnapshot 保存的快照对象
   */
  _restoreDrawerSnapshot: (snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return
    // 仅恢复存在的字段，避免 undefined 覆盖
    const restore = {}
    for (const [k, v] of Object.entries(snapshot)) {
      if (v !== undefined) restore[k] = v
    }
    set(restore)
  },

  // ========== Epitaxy（外延探究）状态与 Actions ==========
  // 状态机：empty → proposing → proposing_done → excavating → excavating_done → distilled
  //   - proposing：自动生成方向卡片
  //   - proposing_done：卡片列表展示，用户选择某方向
  //   - excavating：深挖选中方向，生成笔记+词块
  //   - excavating_done：笔记+词块展示，用户选词
  //   - distilled：提炼完成，可转新灵感
  // M3 补丁：proposals 按 status 分两组
  //   - epitaxyProposals：未浏览（status === 'pending'）
  //   - epitaxyViewedProposals：已浏览（status === 'selected' 已深挖 / 'distilled' 已提炼）
  epitaxyStage: 'empty',                // empty | proposing | proposing_done | excavating | excavating_done | distilled
  _epitaxyProposeInflight: false,        // K3-g：propose 并发锁（防 StrictMode 双触发+快速切换）
  epitaxyProposals: [],                 // 未浏览的方向卡片列表
  epitaxyViewedProposals: [],           // 已浏览的方向卡片列表（灰色归档区）
  epitaxySelectedProposal: null,        // 当前选中的提案对象
  epitaxyFragments: [],                 // 当前深挖的片段列表（含词块）
  epitaxySelectedChunks: [],            // 用户选中的词块（待提炼）
  epitaxyDistilledChunks: [],           // 已保留的词块
  epitaxyLoading: false,                // 加载态
  epitaxyError: null,                   // 错误信息

  /**
   * 重置 Epitaxy 状态
   */
  resetEpitaxy: () => {
    set({
      epitaxyStage: 'empty',
      epitaxyProposals: [],
      epitaxyViewedProposals: [],
      epitaxySelectedProposal: null,
      epitaxyFragments: [],
      epitaxySelectedChunks: [],
      epitaxyDistilledChunks: [],
      epitaxyLoading: false,
      epitaxyError: null
    })
  },

  /**
   * 把 proposals 按 status 分组到 epitaxyProposals（pending）和 epitaxyViewedProposals（已浏览）
   * 功能：统一处理 proposals 的状态分类，供多处复用
   * 实现方式：遍历 proposals，按 status 字段分到两个数组
   * @param {Array} proposals - 后端返回的 proposal 列表
   */
  _setGroupedProposals: (proposals) => {
    const pending = []
    const viewed = []
    for (const p of proposals) {
      if (p.status === 'selected' || p.status === 'distilled') {
        viewed.push(p)
      } else {
        pending.push(p)
      }
    }
    set({ epitaxyProposals: pending, epitaxyViewedProposals: viewed })
  },

  /**
   * 生成方向提案（Propose 阶段）
   * 功能：进入 Epitaxy 面板时复用已保存的方向卡片，避免每次进入都重新生成
   * 实现方式：
   *   1. 先调用 getEpitaxyProposals 查询后端是否已有保存的 proposals
   *   2. 若已有数据，直接载入并跳到 proposing_done（不重复调用 LLM）
   *   3. 若无数据，才调用 proposeEpitaxy 生成新的 3-5 个方向卡片
   *   4. 查询失败时降级为直接生成新的，保证可用性
   */
  startEpitaxyPropose: async (inspiration) => {
    if (!inspiration) return
    // K3-g 修复：inflight 锁防止并发触发（React 18 StrictMode 双重执行 + 抽屉快速切换场景）
    if (get()._epitaxyProposeInflight) {
      console.warn('[store] startEpitaxyPropose 已在执行中，跳过本次触发')
      return
    }
    set({ _epitaxyProposeInflight: true })
    set({ epitaxyLoading: true, epitaxyError: null, epitaxyStage: 'proposing' })
    try {
      // 先尝试加载已有的 proposals，避免重复生成
      try {
        const existing = await api.getEpitaxyProposals(inspiration.id)
        const existingProposals = Array.isArray(existing?.data) ? existing.data : []
        if (existingProposals.length > 0) {
          // 已有数据：按 status 分组（pending → 未浏览，selected/distilled → 已浏览）
          get()._setGroupedProposals(existingProposals)
          set({ epitaxyStage: 'proposing_done', epitaxyLoading: false })
          return
        }
      } catch (loadErr) {
        // 加载已有 proposals 失败不阻断流程，继续走生成新提案
        console.warn('[store] 加载已有 epitaxy proposals 失败，将生成新的:', loadErr.message)
      }

      // 没有已有数据，调用 LLM 生成新的 proposals
      const crystal = get().crystallizePRD || {}
      const result = await api.proposeEpitaxy(inspiration.id, crystal)
      if (result.success === false) {
        set({ epitaxyError: result.error || '生成提案失败', epitaxyLoading: false })
        return
      }
      const proposals = result.data?.proposals || []
      // 新生成的 proposals 都是 pending 状态，全部进未浏览区
      get()._setGroupedProposals(proposals)
      set({ epitaxyStage: 'proposing_done', epitaxyLoading: false })
    } catch (err) {
      set({ epitaxyError: err.message, epitaxyLoading: false })
    } finally {
      // K3-g：无论成功失败都释放 inflight 锁
      set({ _epitaxyProposeInflight: false })
    }
  },

  /**
   * 选择某方向并深挖（Excavate 阶段）
   * 功能：用户点击某张方向卡片后，加载该方向的深挖结果
   * 实现方式：
   *   1. 先调用 getEpitaxyExcavation 查询后端是否已有保存的 fragments
   *   2. 若已有数据，直接复用（不重复调用 LLM，适用于已浏览卡片的再次点击）
   *   3. 若无数据，才调用 excavateEpitaxy 生成新的研究笔记
   *   4. 选中 proposal 后，把它从 epitaxyProposals（未浏览）移到 epitaxyViewedProposals（已浏览）
   */
  excavateProposal: async (inspiration, proposal) => {
    if (!inspiration || !proposal) return
    set({
      epitaxyLoading: true,
      epitaxyError: null,
      epitaxyStage: 'excavating',
      epitaxySelectedProposal: proposal,
      epitaxySelectedChunks: [],
      // K4-b 改进点 1：外延联动——抽屉选卡片时同步 selectedProposalId，
      // Detail 据此显示对应 fragments（联动视图根据 stage 自动切换内容）
      selectedProposalId: proposal?.id || null
    })
    try {
      let fragments = []

      // 先尝试复用后端已保存的 fragments（适用于已浏览卡片）
      try {
        const existing = await api.getEpitaxyExcavation(inspiration.id, proposal.id)
        if (Array.isArray(existing?.data) && existing.data.length > 0) {
          fragments = existing.data
        }
      } catch (loadErr) {
        // 加载失败不阻断，继续走生成新 fragments
        console.warn('[store] 加载已有 excavation 失败，将生成新的:', loadErr.message)
      }

      // 没有已有数据，调用 LLM 生成新的 fragments
      if (fragments.length === 0) {
        const result = await api.excavateEpitaxy(inspiration.id, proposal.id)
        if (result.success === false) {
          set({ epitaxyError: result.error || '深挖失败', epitaxyLoading: false })
          return
        }
        fragments = result.data?.fragments || []
      }

      // 如果 proposal 原本是 pending（未浏览），现在移到已浏览区
      // 实现方式：本地把 proposal.status 更新为 'selected'，重新分组
      if (proposal.status === 'pending' || !proposal.status) {
        const updatedProposal = { ...proposal, status: 'selected' }
        // 合并未浏览和已浏览，重新分组
        const all = [
          ...get().epitaxyProposals.filter((p) => p.id !== proposal.id),
          ...get().epitaxyViewedProposals,
          updatedProposal
        ]
        get()._setGroupedProposals(all)
        set({ epitaxySelectedProposal: updatedProposal })
      }

      set({
        epitaxyFragments: fragments,
        epitaxyStage: 'excavating_done',
        epitaxyLoading: false
      })
    } catch (err) {
      set({ epitaxyError: err.message, epitaxyLoading: false })
    }
  },

  /**
   * 返回方向列表（从深挖结果返回）
   * K4-b 改进点 1：同时清空 selectedProposalId，Detail 联动视图回到"方向列表态"
   */
  backToProposals: () => {
    set({
      epitaxyStage: 'proposing_done',
      epitaxySelectedProposal: null,
      epitaxyFragments: [],
      epitaxySelectedChunks: [],
      // K4-b：联动——返回方向列表时同步清空 selectedProposalId
      selectedProposalId: null
    })
  },

  /**
   * 切换片段选中态（M3 调整：以 fragment 为选择单位，非单词）
   * 功能：点击整段笔记卡片时切换选中/取消选中
   * 实现方式：
   *   1. 检查 fragment.id 是否已在 selectedChunks 中，有则移除
   *   2. 无则把整个 fragment 转为 chunk 格式加入：
   *      - id: fragment.id
   *      - text: fragment.full_text（整段笔记作为提炼内容）
   *      - kind: 按 fragment.type 映射到 chunk kind 枚举
   *      - subkind: fragment.type（保留原类型供 UI 展示）
   *      - originalFrag: 保留原 fragment 对象，供取消选中时使用
   */
  toggleChunk: (chunkId, fragment) => {
    set((st) => {
      const existing = st.epitaxySelectedChunks.find((c) => c.id === chunkId)
      if (existing) {
        return {
          epitaxySelectedChunks: st.epitaxySelectedChunks.filter((c) => c.id !== chunkId)
        }
      }
      const fragKind = FRAG_TYPE_TO_KIND[fragment?.type] || 'material'
      return {
        epitaxySelectedChunks: [...st.epitaxySelectedChunks, {
          id: fragment?.id || chunkId,
          text: fragment?.full_text || '',
          title: fragment?.title || '',
          kind: fragKind,
          subkind: fragment?.type || '',
          fragmentId: fragment?.id || chunkId,
          originalFrag: fragment
        }]
      }
    })
  },

  /**
   * 提炼词块（Distill 阶段）
   * 功能：将选中的整段笔记保存到 knowledge_chunks 表，并把 proposal 状态标记为 'distilled'
   * 实现方式：
   *   1. 调用后端 distillEpitaxyChunks 保存
   *   2. 把当前选中 proposal 的 status 更新为 'distilled'（后端已自动更新，前端同步分组）
   *   3. 在 epitaxyViewedProposals 中更新该 proposal 的 status
   */
  distillChunks: async (inspirationId) => {
    const selected = get().epitaxySelectedChunks
    if (selected.length === 0) return
    set({ epitaxyLoading: true, epitaxyError: null })
    try {
      // 构造 chunks 数组
      const chunks = selected.map((c) => ({
        fragmentId: c.fragmentId || c.fragment_id || null,
        originalText: c.text || c.original_text || '',
        chunkText: c.text || c.chunk_text || '',
        kind: c.kind || 'concept',
        subkind: c.subkind || '',
        userNote: c.userNote || ''
      }))
      const result = await api.distillEpitaxyChunks(inspirationId, chunks)
      if (result.success === false) {
        set({ epitaxyError: result.error || '提炼失败', epitaxyLoading: false })
        return
      }

      // 提炼成功后，把当前 proposal 的 status 更新为 'distilled'
      // 功能：让"已浏览"分区中的卡片显示"已提炼"状态
      // 实现方式：合并未浏览和已浏览，更新对应 proposal 的 status，重新分组
      const currentProposal = get().epitaxySelectedProposal
      if (currentProposal) {
        const updatedProposal = { ...currentProposal, status: 'distilled' }
        const all = [
          ...get().epitaxyProposals,
          ...get().epitaxyViewedProposals.filter((p) => p.id !== currentProposal.id),
          updatedProposal
        ]
        get()._setGroupedProposals(all)
        set({ epitaxySelectedProposal: updatedProposal })
      }

      set({
        epitaxyDistilledChunks: result.data?.chunks || selected,
        epitaxyStage: 'distilled',
        epitaxyLoading: false
      })

      // fix：提炼成功后刷新 archiveData，让 Detail 面板的"外延"阶段档案显示已提炼的词块
      // 没有这一步，EpitaxyArchiveContent 还是读旧的 proposals（无 chunks），会误显示"尚未提炼词块"
      const selectedInspiration = get().selectedInspiration
      if (selectedInspiration) {
        await get().loadArchive(selectedInspiration.id)
      }
    } catch (err) {
      set({ epitaxyError: err.message, epitaxyLoading: false })
    }
  },

  /**
   * 词块转新灵感
   * 功能：将已提炼的词块组合创建新灵感
   */
  chunkToInspiration: async (inspirationId, chunkIds) => {
    set({ epitaxyLoading: true, epitaxyError: null })
    try {
      const result = await api.chunkToInspiration(inspirationId, chunkIds)
      set({ epitaxyLoading: false })
      return result
    } catch (err) {
      set({ epitaxyError: err.message, epitaxyLoading: false })
      return null
    }
  },

  // ========== Coalesce（跨灵感桥梁）状态与 Actions ==========
  // K3 架构改造：状态机调整为 idle → scanning → done/error
  //   - idle：未扫描
  //   - scanning：显式扫描中（包含 LLM 深挖）
  //   - done：扫描完成，bridges 已更新
  //   - error：扫描失败
  // 新 API 契约（§9.3）：scan 返回 newBridges；graph 返回 nodes+edges；
  //   PATCH /coalesce/bridges/:id 策展；POST /coalesce/bridges/:id/to-inspiration 转新灵感
  coalesceStage: 'idle',                // idle | scanning | done | error
  coalesceBridges: [],                  // 当前灵感相关的所有桥梁（含 dismissed，前端置灰）
  coalesceLoading: false,               // 加载态
  coalesceError: null,                  // 错误信息
  coalesceScanSummary: null,            // 最近一次扫描摘要 { scannedPairs, candidateCount, newBridges, reusedBridges }

  // ========== Archive（档案馆）状态与 Actions（K3-d 新增）==========
  // 功能：Detail 唯一数据源，合并三阶段产物 + 徽章口径（§9.2）
  // 实现方式：loadArchive 调用 GET /api/inspirations/:id/archive，缓存到 archiveData
  //   - 切换灵感时重置 archiveData（避免上个灵感数据残留）
  //   - archiveData 包含：inspiration, badges, crystal, epitaxy, bridges, fingerprintStale
  //   - expandedStage 控制手风琴互斥展开（§10.4 DetailSlice 契约）
  archiveData: null,                    // ArchiveResponse 或 null
  archiveLoading: false,                // 加载态
  archiveError: null,                   // 错误信息
  expandedStage: 'none',                // none | crystal | epitaxy | bridges（手风琴互斥）

  /**
   * 加载档案馆数据（K3-d 新增）
   * 功能：调用 GET /api/inspirations/:id/archive，缓存到 archiveData
   * 实现方式：成功后同步更新 coalesceBridges（从 archive.bridges 取）
   * K3-g 修复：开始时立即 set archiveData=null，覆盖异步加载窗口期
   *   （防止切换灵感瞬间显示上一个灵感的档案数据）
   * @param {string} inspirationId
   */
  loadArchive: async (inspirationId) => {
    if (!inspirationId) return
    // K3-g：立即置空 archiveData，防止异步加载完成前显示上个灵感的档案
    set({ archiveLoading: true, archiveError: null, archiveData: null })
    try {
      const result = await api.getArchive(inspirationId)
      if (result.success === false) {
        set({ archiveError: result.error || '加载档案馆失败', archiveLoading: false })
        return
      }
      const archive = result.data
      set({
        archiveData: archive,
        archiveLoading: false,
        // 同步 coalesceBridges（archive 是唯一数据源，§9.2 防漂移）
        coalesceBridges: archive?.bridges || []
      })
    } catch (err) {
      set({ archiveError: err.message, archiveLoading: false })
    }
  },

  /**
   * 重置档案馆状态
   * 功能：切换灵感或取消选中时调用
   */
  resetArchive: () => {
    set({
      archiveData: null,
      archiveLoading: false,
      archiveError: null,
      expandedStage: 'none'
    })
  },

  /**
   * 更新档案馆中已结晶 crystal 的单个字段（Detail 内联编辑）
   * 功能：在 Detail 面板点击字段文本切换编辑态，保存后调用后端 PUT /crystallize/crystal 持久化
   * 实现方式：
   *   - 取当前 archiveData.crystal.fields 浅拷贝并改对应字段
   *   - 调用 api.updateCrystallizeCrystal（整体覆盖）写回文件
   *   - 成功后直接更新 archiveData.crystal.fields，避免重新 loadArchive
   *   - 失败时抛错给调用方处理（不回滚，因为编辑是局部的）
   * @param {string} fieldKey - 字段 key（如 'definition'）
   * @param {any} value - 新值（字符串/数组/对象）
   */
  updateArchiveCrystalField: async (fieldKey, value) => {
    const archive = get().archiveData
    const selected = get().selectedInspiration
    if (!archive || !archive.crystal || !selected) return
    const oldFields = archive.crystal.fields || {}
    const newFields = { ...oldFields, [fieldKey]: value }
    // 乐观更新：立即反映到 UI
    set((st) => ({
      archiveData: {
        ...st.archiveData,
        crystal: { ...st.archiveData.crystal, fields: newFields }
      }
    }))
    try {
      await api.updateCrystallizeCrystal(selected.id, newFields)
    } catch (err) {
      // 失败回滚到旧值
      set((st) => ({
        archiveData: {
          ...st.archiveData,
          crystal: { ...st.archiveData.crystal, fields: oldFields }
        }
      }))
      throw err
    }
  },

  /**
   * 设置手风琴展开阶段（§10.4 DetailSlice 契约：互斥）
   * 功能：点击某阶段卡片头部时切换展开/收起
   * @param {string} stage - 'crystal' | 'epitaxy' | 'bridges' | 'none'
   */
  setExpandedStage: (stage) => {
    set((st) => ({
      expandedStage: st.expandedStage === stage ? 'none' : stage
    }))
  },

  /**
   * 重置 Coalesce 状态
   * 功能：切换灵感时调用，清空所有 coalesce 状态
   */
  resetCoalesce: () => {
    set({
      coalesceStage: 'idle',
      coalesceBridges: [],
      coalesceLoading: false,
      coalesceError: null,
      coalesceScanSummary: null
    })
  },

  /**
   * 显式扫描桥梁（K3-c 新 API）
   * 功能：调用 POST /inspirations/:id/coalesce/scan，触发双引擎扫描 + LLM 深挖
   * 实现方式：
   *   1. set scanning 加载态
   *   2. 调用 api.scanCoalesce（新后端契约：返回 { scannedPairs, newBridges, ... }）
   *   3. 扫描完成后从 archive 接口同步最新 bridges（保证状态一致）
   *   4. set done + scanSummary
   * @param {string} inspirationId
   */
  scanCoalesce: async (inspirationId) => {
    if (!inspirationId) return
    set({ coalesceLoading: true, coalesceError: null, coalesceStage: 'scanning' })
    try {
      const result = await api.scanCoalesce(inspirationId)
      if (result.success === false) {
        set({ coalesceError: result.error || '扫描失败', coalesceStage: 'error', coalesceLoading: false })
        return
      }
      const summary = result.data || {}
      set({ coalesceScanSummary: summary })
      // 扫描成功后重新加载 archive 以同步 bridges（保证策展状态一致）
      await get().loadArchive(inspirationId)
      set({ coalesceStage: 'done', coalesceLoading: false })
    } catch (err) {
      set({ coalesceError: err.message, coalesceStage: 'error', coalesceLoading: false })
    }
  },

  /**
   * 策展桥梁（K3-c 新 API）
   * 功能：确认或忽略桥梁，立即更新本地状态 + 后端持久化
   * 实现方式：
   *   1. 乐观更新本地 bridges 中对应记录的 status
   *   2. 调用 api.curateBridge 同步到后端
   *   3. 失败时回滚（重新 loadArchive）
   * @param {string} inspirationId - 当前灵感 ID（用于回滚）
   * @param {string} bridgeId - 桥梁 ID
   * @param {string} action - 'confirm' | 'dismiss'
   */
  curateBridge: async (inspirationId, bridgeId, action) => {
    if (!bridgeId || !action) return
    // 乐观更新本地状态
    const prevBridges = get().coalesceBridges
    set({
      coalesceBridges: prevBridges.map(b =>
        b.id === bridgeId ? { ...b, status: action === 'confirm' ? 'confirmed' : 'dismissed' } : b
      )
    })
    try {
      const result = await api.curateBridge(bridgeId, action)
      if (result.success === false) {
        // 回滚
        set({ coalesceBridges: prevBridges })
        set({ coalesceError: result.error || '策展失败' })
        return
      }
      // 成功后重新加载 archive 以同步徽章
      await get().loadArchive(inspirationId)
    } catch (err) {
      // 回滚
      set({ coalesceBridges: prevBridges, coalesceError: err.message })
    }
  },

  /**
   * 桥梁转新灵感（K3-c 新 API）
   * 功能：以 bridge.reason 为内容创建新灵感
   * @param {string} bridgeId - 桥梁 ID
   * @returns {Promise<object|null>} 新灵感对象或 null
   */
  bridgeToInspiration: async (bridgeId) => {
    if (!bridgeId) return null
    set({ coalesceLoading: true, coalesceError: null })
    try {
      const result = await api.bridgeToInspirationNew(bridgeId)
      set({ coalesceLoading: false })
      return result
    } catch (err) {
      set({ coalesceError: err.message, coalesceLoading: false })
      return null
    }
  },

  /**
   * 加载已有桥梁（K3-d 改造：从 archive 接口加载，替代旧 getCoalesceBridges）
   * 功能：从 archive.bridges 同步到 coalesceBridges 状态
   * 实现方式：由 loadArchive 内部调用，无需单独触发
   * @deprecated 新代码应使用 loadArchive
   */
  loadCoalesceBridges: async (inspirationId) => {
    if (!inspirationId) return
    try {
      const result = await api.getArchive(inspirationId)
      if (result.success !== false) {
        set({ coalesceBridges: result.data?.bridges || [] })
      }
    } catch (err) {
      console.warn('loadCoalesceBridges error:', err.message)
    }
  },

  /**
   * 加载指定灵感的最新结晶记录
   * 功能：选中灵感时调用，恢复已确认的 PRD 或草稿到对应阶段
   * 实现方式：成功时根据 user_confirmed / prd 字段决定跳到 done 或 prd_preview
   */
  loadCrystallizeLatest: async (inspirationId) => {
    if (!inspirationId) return
    set({ crystallizeError: null })
    try {
      const result = await api.getCrystallizeLatest(inspirationId)
      const latest = result?.data
      if (!latest) {
        // 无历史记录：重置到 idle（补全所有字段，避免残留）
        set({
          crystallizeStage: 'idle',
          crystallizePRD: null,
          crystallizeQuestions: [],
          crystallizeCurrentIdx: 0,
          crystallizeAnswers: {},
          crystallizeOtherAnswers: {},
          crystallizeConversation: [],
          crystallizeLoading: false,
          crystallizeError: null
        })
        return
      }
      // 已确认 PRD/结晶体 → 跳到 done；否则有 prd/crystal → crystal_preview
      // M3-b：同时恢复 inspirationType / crystalType，确保 crystal_preview 渲染正确字段
      const typeInfo = {
        inspirationType: latest.inspiration_type || latest.inspirationType || null,
        crystalType: latest.crystal_type || latest.crystalType || null
      }
      if (latest.user_confirmed || latest.status === 'confirmed') {
        set({ crystallizeStage: 'done', crystallizePRD: latest.crystal || latest.prd, ...typeInfo })
      } else if (latest.crystal || latest.prd) {
        set({ crystallizeStage: 'crystal_preview', crystallizePRD: latest.crystal || latest.prd, ...typeInfo })
      }
    } catch (err) {
      // 加载失败不阻塞主流程
      console.warn('[store] 加载结晶最新记录失败:', err.message)
    }
  },

  /**
   * 重置 CrystallizePanel 到初始 idle 状态（M3-b 改造：清理 Sense 状态）
   * 功能：切换灵感或重新开始时调用
   */
  resetCrystallize: () => {
    set({
      crystallizeStage: 'idle',
      crystallizePRD: null,
      crystallizeQuestions: [],
      crystallizeCurrentIdx: 0,
      crystallizeAnswers: {},
      crystallizeOtherAnswers: {},
      crystallizeConversation: [],
      crystallizeLoading: false,
      crystallizeError: null,
      crystallizeDispatching: false,
      // M3-b 新增：清理 Sense 状态
      inspirationType: null,
      inspirationTypeConfidence: 0,
      inspirationTypeAlternatives: [],
      inspirationTypeReasoning: '',
      crystalType: null,
      senseLoading: false,
      // K4 新增：清理胶囊识别与决策状态
      detectedCapsules: [],
      capsuleDecision: null,
      // K4 新增：清理 5 信号与 concept_orientation
      senseSignals: null,
      conceptScore: 0,
      productScore: 0,
      conceptOrientation: null,
      // K4 新增：清理 selected_dimensions
      selectedDimensions: []
    })
  },

  /**
   * 开始结晶流程（M3-b 改造：先触发 Sense 感知类型）
   * 功能：用户点击"开始结晶"后，先调用 Sense 分析灵感类型
   *   - confidence ≥ 0.85：自动进入 questioning（透传类型给 initial 阶段）
   *   - confidence < 0.85：进入 sense_confirm，让用户确认/修正类型
   *   - Sense 失败（无 API key 等）：直接进入 questioning 用默认类型"产品想法"
   */
  startCrystallize: async (inspiration) => {
    if (!inspiration) return
    // 进入 sensing 加载态
    set({ senseLoading: true, crystallizeError: null, crystallizeStage: 'sensing' })
    try {
      const text = inspiration.content || inspiration.title || ''
      const result = await api.senseInspirationType(inspiration.id, text)
      if (result.success === false) {
        // Sense 失败：兜底用"产品想法"，直接进入 questioning
        set({
          inspirationType: '产品想法',
          crystalType: 'prd',
          senseLoading: false,
          crystallizeStage: 'questioning'
        })
        // 用默认类型触发 initial 追问
        get()._runInitialQuestioning(inspiration, '产品想法')
        return
      }
      const data = result.data || result
      const confidence = data.confidence || 0
      const inspType = data.type || '其他'
      // 保存 Sense 结果到状态（含 K4 新增字段）
      set({
        inspirationType: inspType,
        inspirationTypeConfidence: confidence,
        inspirationTypeAlternatives: data.alternative_types || [],
        inspirationTypeReasoning: data.reasoning || '',
        crystalType: data.crystal_type || 'free_note',
        senseLoading: false,
        // K4 新增：保存 5 信号与 concept_orientation
        senseSignals: data.signals || null,
        conceptScore: data.concept_score || 0,
        productScore: data.product_score || 0,
        conceptOrientation: data.concept_orientation || null,
        // K4 新增：保存 detected_capsules
        detectedCapsules: data.detected_capsules || [],
        // K4 新增：默认 capsuleDecision 为 null（未决策）
        capsuleDecision: null
      })

      // K4 新增：如果有 detected_capsules，优先进入 capsule_detection 阶段让用户决策
      if (data.detected_capsules && data.detected_capsules.length > 0) {
        set({ crystallizeStage: 'capsule_detection' })
        return
      }

      // 高置信度：自动跳过确认，直接进入 questioning
      if (confidence >= 0.85) {
        set({ crystallizeStage: 'questioning' })
        get()._runInitialQuestioning(inspiration, inspType)
      } else {
        // 低置信度：进入 sense_confirm 让用户确认
        set({ crystallizeStage: 'sense_confirm' })
      }
    } catch (err) {
      // Sense 异常：兜底用"产品想法"，直接进入 questioning
      set({
        inspirationType: '产品想法',
        crystalType: 'prd',
        senseLoading: false,
        crystallizeStage: 'questioning'
      })
      get()._runInitialQuestioning(inspiration, '产品想法')
    }
  },

  /**
   * 内部方法：运行 initial 阶段追问（M3-b 抽取，K4 改造）
   * 功能：调用 runCrystallize with stage='initial' + inspirationType，根据返回切换到 questioning
   * 实现方式：从 store 读取 inspirationType，透传给后端
   * K4 改造：新增 capsuleDecision / detectedCapsules 参数，透传给后端 _buildPrompt
   * @param {object} inspiration - 当前灵感
   * @param {string} inspirationType - 灵感类型
   * @param {string|null} capsuleDecision - 'use' | 'ignore' | null（K4 新增）
   * @param {Array} detectedCapsules - 识别到的胶囊数组（K4 新增）
   */
  _runInitialQuestioning: async (inspiration, inspirationType, capsuleDecision = null, detectedCapsules = []) => {
    set({ crystallizeLoading: true, crystallizeError: null })
    try {
      const result = await api.runCrystallize(inspiration.id, {
        stage: 'initial',
        userInput: inspiration.content || inspiration.title || '',
        crystalDraft: {},
        conversationHistory: [],
        inspirationType,
        // K4 新增：透传胶囊决策
        capsuleDecision,
        detectedCapsules
      })
      if (result.success === false) {
        set({ crystallizeError: result.error || '结晶失败', crystallizeLoading: false })
        return
      }
      const data = result.data || result
      // 根据返回的 stage 字段切换：A/B = 追问，C = 已生成结晶体
      if (data.stage === 'A' || data.stage === 'B') {
        set({
          crystallizeQuestions: data.clarifying_questions || [],
          crystallizeCurrentIdx: 0,
          crystallizeAnswers: {},
          crystallizeOtherAnswers: {},
          crystallizeStage: 'questioning',
          crystallizeLoading: false,
          // K4 新增：保存 selected_dimensions
          selectedDimensions: data.selected_dimensions || []
        })
      } else if (data.crystal || data.prd) {
        // LLM 直接生成了结晶体（跳过追问）
        set({
          crystallizePRD: data.crystal || data.prd,
          crystallizeStage: 'crystal_preview',
          crystallizeLoading: false,
          // K4 新增：保存 selected_dimensions
          selectedDimensions: data.selected_dimensions || []
        })
      } else {
        set({ crystallizeStage: 'done', crystallizeLoading: false })
      }
    } catch (err) {
      set({ crystallizeError: err.message, crystallizeLoading: false })
    }
  },

  /**
   * 确认灵感类型（sense_confirm 阶段，用户确认或修正后）
   * 功能：用户在 sense_confirm 阶段确认类型后，进入 questioning
   * @param {string} type - 用户确认的类型（可能修正过）
   */
  confirmInspirationType: (type) => {
    // 类型 → crystal_type 映射（与后端 TYPE_TO_CRYSTAL 一致）
    // K4 改造：删除"方法流程"映射（v4 迁移后历史数据归入"其他"）
    // K4-a 改造：新增"美学提案"映射
    const typeToCrystal = {
      '产品想法': 'prd', '氛围画面': 'scene_card', '设定世界观': 'worldview',
      '创作素材': 'creative_direction', '研究好奇': 'exploration_map',
      '角色人物': 'character_profile',
      '概念': 'concept_card', '美学提案': 'aesthetic_proposal', '其他': 'free_note'
    }
    set({
      inspirationType: type,
      crystalType: typeToCrystal[type] || 'free_note',
      crystallizeStage: 'questioning'
    })
  },

  /**
   * 确认胶囊使用决策（K4 新增：capsule_detection 阶段）
   * 功能：用户在 capsule_detection 阶段选择"使用胶囊"或"忽略，按原流程"
   * 实现方式：
   *   - 'use'：透传 detectedCapsules 给 _runInitialQuestioning，触发差异化提问
   *   - 'ignore'：按原流程提问，detectedCapsules 传空数组
   * @param {string} decision - 'use' | 'ignore'
   * @param {object} inspiration - 当前灵感
   */
  confirmCapsuleUsage: (decision, inspiration) => {
    set({ capsuleDecision: decision })
    set({ crystallizeStage: 'questioning' })
    if (decision === 'use') {
      // 使用胶囊：透传 detectedCapsules 触发差异化提问
      get()._runInitialQuestioning(inspiration, get().inspirationType, 'use', get().detectedCapsules)
    } else {
      // 忽略胶囊：按原流程提问，detectedCapsules 传空数组
      get()._runInitialQuestioning(inspiration, get().inspirationType, 'ignore', [])
    }
  },

  /**
   * 修改灵感类型（questioning 或之后阶段，用户想换类型重新追问）
   * 功能：重置 questioning 状态，用新类型重新触发 initial 追问
   * @param {string} newType - 新类型
   */
  changeInspirationType: (newType, inspiration) => {
    // K4 改造：删除"方法流程"映射（与后端 TYPE_TO_CRYSTAL 一致）
    // K4-a 改造：新增"美学提案"映射
    const typeToCrystal = {
      '产品想法': 'prd', '氛围画面': 'scene_card', '设定世界观': 'worldview',
      '创作素材': 'creative_direction', '研究好奇': 'exploration_map',
      '角色人物': 'character_profile',
      '概念': 'concept_card', '美学提案': 'aesthetic_proposal', '其他': 'free_note'
    }
    set({
      inspirationType: newType,
      crystalType: typeToCrystal[newType] || 'free_note',
      crystallizeQuestions: [],
      crystallizeCurrentIdx: 0,
      crystallizeAnswers: {},
      crystallizeOtherAnswers: {},
      crystallizeConversation: [],
      crystallizePRD: null,
      crystallizeStage: 'questioning'
    })
    // 用新类型重新触发追问
    if (inspiration) {
      get()._runInitialQuestioning(inspiration, newType)
    }
  },

  /**
   * 回答当前追问问题
   * 功能：把当前回答追加到对话历史，调用 CrystallizeAgent 决定下一步
   * 实现方式：
   *   - 若选中"其他"选项，answer = `其他：${otherText}`（保留原始选项 + 补充内容）
   *   - 若有更多问题则推进索引，否则进入 prd_preview
   */
  answerCrystallizeQuestion: async (inspiration) => {
    const state = get()
    const currentQ = state.crystallizeQuestions[state.crystallizeCurrentIdx]
    if (!currentQ) return
    const rawAnswer = state.crystallizeAnswers[currentQ.id]
    if (!rawAnswer) return

    // 处理"其他"选项：选中 __other__ 时拼接补充内容
    // 单选题：rawAnswer 是字符串；多选题：rawAnswer 是数组
    let finalAnswer = rawAnswer
    if (rawAnswer === '__other__') {
      const otherText = state.crystallizeOtherAnswers[currentQ.id] || ''
      // "其他"必须填写补充内容才能提交
      if (!otherText.trim()) return
      finalAnswer = `其他：${otherText.trim()}`
    }

    // 更新对话历史
    const updatedHistory = [
      ...state.crystallizeConversation,
      { role: 'assistant', content: currentQ.text },
      { role: 'user', content: finalAnswer }
    ]

    set({ crystallizeLoading: true, crystallizeError: null })
    try {
      const result = await api.runCrystallize(inspiration.id, {
        stage: 'questioning',
        userInput: finalAnswer,
        crystalDraft: state.crystallizePRD || {},
        conversationHistory: updatedHistory,
        inspirationType: state.inspirationType
      })
      if (result.success === false) {
        set({ crystallizeError: result.error || '结晶失败', crystallizeLoading: false })
        return
      }
      const data = result.data || result
      set({ crystallizeConversation: updatedHistory })
      if (data.crystal || data.prd) {
        // 信息已充分 → 生成结晶体
        set({
          crystallizePRD: data.crystal || data.prd,
          crystallizeStage: 'crystal_preview',
          crystallizeLoading: false
        })
      } else if (data.clarifying_questions && data.clarifying_questions.length > 0) {
        // 继续追问：替换问题列表并重置索引
        set({
          crystallizeQuestions: data.clarifying_questions,
          crystallizeCurrentIdx: 0,
          crystallizeAnswers: {},
          crystallizeOtherAnswers: {},
          crystallizeLoading: false
        })
      } else {
        // 没有继续问题也没有 PRD → 跳到生成 PRD
        set({ crystallizeLoading: false })
        get().skipToPRD(inspiration)
      }
    } catch (err) {
      set({ crystallizeError: err.message, crystallizeLoading: false })
    }
  },

  /**
   * 跳过追问，直接生成结晶体（M3-b 改造）
   * 功能：调用 generate_crystal 阶段强制 LLM 输出结晶体
   */
  skipToPRD: async (inspiration) => {
    if (!inspiration) return
    set({ crystallizeLoading: true, crystallizeError: null })
    try {
      const result = await api.runCrystallize(inspiration.id, {
        stage: 'generate_crystal',
        userInput: inspiration.content || inspiration.title || '',
        crystalDraft: get().crystallizePRD || {},
        inspirationType: get().inspirationType
      })
      if (result.success === false) {
        set({ crystallizeError: result.error || '生成结晶体失败', crystallizeLoading: false })
        return
      }
      const data = result.data || result
      if (data.crystal || data.prd) {
        set({ crystallizePRD: data.crystal || data.prd, crystallizeStage: 'crystal_preview', crystallizeLoading: false })
      } else {
        set({ crystallizeLoading: false, crystallizeError: '未返回结晶体' })
      }
    } catch (err) {
      set({ crystallizeError: err.message, crystallizeLoading: false })
    }
  },

  /**
   * 设置当前问题的答案（受控输入）
   * 功能：保存选中的选项 id 或文本到 crystallizeAnswers
   * 单选传字符串，多选传数组
   */
  setCrystallizeAnswer: (questionId, value) => {
    set((st) => ({
      crystallizeAnswers: { ...st.crystallizeAnswers, [questionId]: value }
    }))
  },

  /**
   * 设置"其他：请补充"输入框内容
   * 功能：每题都有"其他"选项，选中后展开输入框，内容存入 crystallizeOtherAnswers
   */
  setCrystallizeOtherAnswer: (questionId, value) => {
    set((st) => ({
      crystallizeOtherAnswers: { ...st.crystallizeOtherAnswers, [questionId]: value }
    }))
  },

  /**
   * 推进到下一问题
   */
  nextCrystallizeQuestion: () => {
    set((st) => ({ crystallizeCurrentIdx: st.crystallizeCurrentIdx + 1 }))
  },

  /**
   * 更新 PRD 草稿字段（在 prd_preview 阶段内联编辑）
   */
  updateCrystallizePRDField: (field, value) => {
    set((st) => ({
      crystallizePRD: { ...(st.crystallizePRD || {}), [field]: value }
    }))
  },

  /**
   * 确认结晶体并进入 done 阶段（M3-b 改造）
   * 功能：调用后端 updateCrystallizeCrystal 持久化，然后切换到 done
   */
  confirmPRD: async (inspirationId) => {
    if (!inspirationId) return
    set({ crystallizeLoading: true, crystallizeError: null })
    try {
      await api.updateCrystallizeCrystal(inspirationId, get().crystallizePRD)
      set({ crystallizeStage: 'done', crystallizeLoading: false })
    } catch (err) {
      set({ crystallizeError: err.message, crystallizeLoading: false })
    }
  },

  /**
   * 从 done 阶段手动分流到指定 Agent
   * 功能：调用 dispatchFromCrystallize 触发后端 agentHub.dispatch
   * 实现方式：成功后返回 next_agent 与结果，便于上层 UI 提示
   * M3-a：epitaxy/coalesce 尚未注册，dispatch 会返回 unknown agent 错误（被 UI 静默处理）
   */
  dispatchFromCrystallize: async (inspiration, targetAgent) => {
    if (!inspiration || !targetAgent) return null
    set({ crystallizeDispatching: true, crystallizeError: null })
    try {
      const result = await api.dispatchFromCrystallize(inspiration.id, {
        targetAgent,
        prd: get().crystallizePRD
      })
      set({ crystallizeDispatching: false })
      return result
    } catch (err) {
      set({ crystallizeDispatching: false, crystallizeError: err.message })
      return null
    }
  },

  // ========== Addenda（追加条目）状态与 Actions ==========
  // 功能：灵感原文之后的追加思考时间线，支持文本/链接/图片 + 评论 + 对话探究
  //   - addenda：当前选中灵感的追加条目列表（含 comments 与 saved_replies）
  //   - conversationAddendumId：当前对话探究的追加条目 ID
  //   - conversationMessages：对话消息流 [{ role, text, rawText, core, context, saved, replyId }]
  //     v9：rawText 含 [CORE] 标签原文（供保存与重新解析），text 为显示文本（标签已隐藏）
  //          core/context 为流末解析的分层字段（可空）
  //   - conversationConvertedHistory：已转化为评论的历史对话（v10 新增）
  //     来源：openConversation 时从 saved_replies 中分离出 converted=1 的项
  //     用途：在对话抽屉底部以折叠形式展示，保留可追溯性但不干扰当前对话流
  //   - savedRepliesList：所有灵感的已保存回答（继续思考面板用，仅含 converted=0）
  //   - commentDraft：转为评论的草稿 { addendumId, content, context }，供 AddendumSection 监听
  //     v9：新增 context 字段（可空），来自 AI 回复的阐释部分，用于评论折叠展示
  //   - commentSourceReplyId：转为评论时关联的源对话 ID（v10 新增，独立于 commentDraft）
  //     设计原因：commentDraft 会被 onDraftConsumed 立即清空，无法在 createComment 时再读取；
  //               独立字段避免被 CommentInput 的 useEffect 生命周期影响
  //     用途：createComment 成功后调 markReplyConverted(commentSourceReplyId) 标记源对话
  addenda: [],
  addendaLoading: false,
  addendaError: null,
  conversationAddendumId: null,
  conversationMessages: [],
  conversationConvertedHistory: [],
  conversationLoading: false,
  conversationError: null,
  savedRepliesList: [],
  savedRepliesLoading: false,
  showContinueThinking: false,
  commentDraft: null,
  commentSourceReplyId: null,

  /**
   * 加载追加条目列表
   * 功能：GET /inspirations/:id/addenda，缓存到 addenda
   * @param {string} inspirationId - 灵感 ID
   */
  loadAddenda: async (inspirationId) => {
    if (!inspirationId) return
    set({ addendaLoading: true, addendaError: null })
    try {
      const result = await api.listAddenda(inspirationId)
      if (result.success === false) {
        set({ addendaError: result.error || '加载追加条目失败', addendaLoading: false })
        return
      }
      set({ addenda: result.data || [], addendaLoading: false })
    } catch (err) {
      set({ addendaError: err.message, addendaLoading: false })
    }
  },

  /**
   * 创建追加条目
   * 成功后重新加载列表刷新 UI
   * @param {string} inspirationId - 灵感 ID
   * @param {object} data - { content, links, images }
   */
  createAddendum: async (inspirationId, data) => {
    set({ addendaError: null })
    try {
      await api.createAddendum(inspirationId, data)
      await get().loadAddenda(inspirationId)
    } catch (err) {
      set({ addendaError: err.message })
    }
  },

  /**
   * 更新追加条目
   * @param {string} addendumId - 追加条目 ID
   * @param {object} data - { content, links, images }
   * @param {string} inspirationId - 灵感 ID（用于刷新列表）
   */
  updateAddendum: async (addendumId, data, inspirationId) => {
    set({ addendaError: null })
    try {
      await api.updateAddendum(addendumId, data)
      if (inspirationId) await get().loadAddenda(inspirationId)
    } catch (err) {
      set({ addendaError: err.message })
    }
  },

  /**
   * 删除追加条目
   * @param {string} addendumId - 追加条目 ID
   * @param {string} inspirationId - 灵感 ID（用于刷新列表）
   */
  deleteAddendum: async (addendumId, inspirationId) => {
    set({ addendaError: null })
    try {
      await api.deleteAddendum(addendumId)
      if (inspirationId) await get().loadAddenda(inspirationId)
    } catch (err) {
      set({ addendaError: err.message })
    }
  },

  /**
   * 创建评论
   *   v9：新增 context 参数（可空），用于评论折叠展示
   *   v10：新增 sourceReplyId 参数 — 评论来源的 saved_ai_replies ID
   *        评论创建成功后调 markReplyConverted 标记源对话为"已转化"，
   *        让该条回复从"接着想"面板移除，并在再次进入对话窗口时折叠到"已处理历史"
   *        设计要点：sourceReplyId 不依赖 commentDraft（后者会被 onDraftConsumed 立即清空），
   *                  而是作为参数显式传入，保证标记链路可靠执行
   * @param {string} addendumId - 追加条目 ID
   * @param {string} content - 评论核心文本
   * @param {string} inspirationId - 灵感 ID（用于刷新列表）
   * @param {string} [context] - 评论展开/阐释部分（可空）
   * @param {string} [sourceReplyId] - 源对话 ID（v10，可空；非空时触发标记转化）
   */
  createComment: async (addendumId, content, inspirationId, context, sourceReplyId) => {
    set({ addendaError: null })
    // v10 全链路跟踪：打印关键参数，便于调试时确认 sourceReplyId 是否成功传递
    console.log('[Store] createComment called:', { addendumId, content: content?.slice(0, 30), inspirationId, hasContext: !!context, sourceReplyId })
    try {
      // 步骤 1：创建评论（核心步骤，失败则直接抛错）
      await api.createComment(inspirationId, addendumId, content, context)
      console.log('[Store] createComment: api.createComment succeeded')

      // 步骤 2：若有 sourceReplyId，标记源对话为"已转化"
      // 注意：此处不依赖 commentDraft（可能已被清空），直接用参数 sourceReplyId
      if (sourceReplyId) {
        console.log('[Store] createComment: marking reply converted, replyId =', sourceReplyId)
        try {
          const markResult = await api.markReplyConverted(sourceReplyId)
          console.log('[Store] markReplyConverted succeeded:', markResult)
          // 步骤 3：刷新"接着想"面板数据（让已转化项从列表中移除）
          // loadSavedReplies 后端已 WHERE converted=0 过滤，刷新后即从 UI 移除
          await get().loadSavedReplies()
          console.log('[Store] loadSavedReplies refreshed after conversion')
        } catch (markErr) {
          // 标记失败不阻塞评论创建（评论已成功写入），但显式记录错误供用户感知
          // 上一轮失败原因之一是 console.warn 静默吞错；此处改为 console.error 并 set addendaError
          console.error('[Store] markReplyConverted FAILED:', markErr.message)
          set({ addendaError: `评论已创建，但标记转化失败：${markErr.message}` })
        }
      } else {
        console.log('[Store] createComment: no sourceReplyId, skipping markReplyConverted')
      }

      // 步骤 4：清空 commentSourceReplyId（无论是否标记成功，避免下次评论误用旧值）
      set({ commentSourceReplyId: null })

      // 步骤 5：刷新 addenda 列表（让新评论出现在 AddendumSection 中）
      if (inspirationId) await get().loadAddenda(inspirationId)
    } catch (err) {
      console.error('[Store] createComment FAILED:', err.message)
      set({ addendaError: err.message })
    }
  },

  /**
   * 更新评论
   *   v9：新增 context 参数（undefined 不更新该字段，null 清空）
   * @param {string} commentId - 评论 ID
   * @param {string} content - 新评论核心文本
   * @param {string} inspirationId - 灵感 ID（用于刷新列表）
   * @param {string} [context] - 新评论展开/阐释部分（undefined 不更新，null 清空）
   */
  updateComment: async (commentId, content, inspirationId, context) => {
    set({ addendaError: null })
    try {
      await api.updateComment(commentId, content, context)
      if (inspirationId) await get().loadAddenda(inspirationId)
    } catch (err) {
      set({ addendaError: err.message })
    }
  },

  /**
   * 删除评论
   * @param {string} commentId - 评论 ID
   * @param {string} inspirationId - 灵感 ID（用于刷新列表）
   */
  deleteComment: async (commentId, inspirationId) => {
    set({ addendaError: null })
    try {
      await api.deleteComment(commentId)
      if (inspirationId) await get().loadAddenda(inspirationId)
    } catch (err) {
      set({ addendaError: err.message })
    }
  },

  /**
   * 打开对话探究抽屉
   * 功能：设置 drawer='conversation'，从 addenda 中找到该 addendum 的 saved_replies，
   *   按 converted 字段分组：
   *     - converted=0（未转化）：展开显示在 conversationMessages 主消息流
   *     - converted=1（已转化）：折叠到 conversationConvertedHistory 历史区
   *   v9：每条 reply 携带 core/context 字段，并从 answer（含 [CORE] 标签原文）派生显示文本
   *   v10：新增 converted 分组逻辑，未转化对话默认展开，已转化对话默认折叠
   * @param {string} addendumId - 追加条目 ID
   */
  openConversation: (addendumId) => {
    const addendum = get().addenda.find((a) => a.id === addendumId)
    const replies = addendum?.saved_replies || []
    // 把 saved_replies 按 converted 分组
    // 未转化（converted=0 或 undefined）：展开在主消息流
    // 已转化（converted=1）：折叠到历史区
    const activeMessages = []
    const convertedHistory = []
    for (const r of replies) {
      // v9：从 answer（可能含 [CORE] 标签）派生显示文本；若已存 core/context 直接复用
      const rawText = r.answer || ''
      const displayText = rawText.replace(/\[CORE\]/g, '').replace(/\[\/CORE\]/g, '')
      const userMsg = r.question ? { role: 'user', text: r.question, saved: false } : null
      const aiMsg = {
        role: 'ai',
        text: displayText,
        rawText,
        core: r.core || null,
        context: r.context || null,
        saved: true,
        replyId: r.id
      }
      // v10：按 converted 字段分组
      if (r.converted === 1) {
        if (userMsg) convertedHistory.push(userMsg)
        convertedHistory.push(aiMsg)
      } else {
        if (userMsg) activeMessages.push(userMsg)
        activeMessages.push(aiMsg)
      }
    }
    set({
      drawer: 'conversation',
      conversationAddendumId: addendumId,
      conversationMessages: activeMessages,
      conversationConvertedHistory: convertedHistory,
      conversationError: null,
      sidebarCompressed: true
    })
  },

  /**
   * 关闭对话探究抽屉
   * 功能：调用 closeDrawer 关闭抽屉，清空对话状态
   */
  closeConversation: () => {
    get().closeDrawer()
    set({
      conversationAddendumId: null,
      conversationMessages: [],
      conversationConvertedHistory: []
    })
  },

  /**
   * 对话探究：发送提问
   * 功能：把 question 追加到消息流，调用 API，把 AI answer 追加到消息流
   *   失败时回滚该轮提问（移除已追加的 user 消息）
   *   v9：流式过程中维护 rawText（含 [CORE] 标签原文），text 由 computeDisplayText 派生（标签隐藏）
   *        流结束 onDone 时解析出 core/context 存到消息上，供后续"转为评论/保存"使用
   * @param {string} question - 用户提问
   */
  askConversation: async (question) => {
    const { selectedInspiration, conversationAddendumId, conversationMessages } = get()
    if (!selectedInspiration || !conversationAddendumId || !question.trim()) return
    // 先追加 user 消息
    const userMsg = { role: 'user', text: question, saved: false }
    const prevMessages = [...conversationMessages]
    // 同时追加一个空的 ai 消息占位（streaming:true 标记流式进行中），后续逐 delta 填充 text
    // v9：rawText 累积含标签的原文，text 是派生的显示文本（标签已隐藏）
    const aiPlaceholder = { role: 'ai', text: '', rawText: '', saved: false, streaming: true }
    set({
      conversationMessages: [...conversationMessages, userMsg, aiPlaceholder],
      conversationLoading: true,
      conversationError: null
    })
    try {
      // 构造 history：传给后端的是"占位 ai 之前"的完整历史（即 prevMessages）
      // 注意排除当前刚追加的 user 消息本身，避免 question 重复
      // v9：history.content 传 rawText（含标签），保持 AI 上下文完整；无 rawText 时回退 text
      const history = prevMessages.map((m) => ({ role: m.role, content: m.rawText || m.text }))

      // 流式回调：每个 delta 累积到 rawText，text 由 computeDisplayText 派生
      const onDelta = (chunk) => {
        const cur = get().conversationMessages
        const next = cur.map((m, i) =>
          i === cur.length - 1 && m.role === 'ai'
            ? (() => {
                const newRaw = (m.rawText || '') + chunk
                return { ...m, rawText: newRaw, text: computeDisplayText(newRaw) }
              })()
            : m
        )
        set({ conversationMessages: next })
      }

      const onDone = (_searchUsed) => {
        // 流结束：清除最后一条 ai 的 streaming 标记；解析 core/context 存到消息上
        const cur = get().conversationMessages
        const next = cur.map((m, i) => {
          if (i === cur.length - 1 && m.role === 'ai') {
            const rawText = m.rawText || m.text || ''
            // 流末无需 hold-back，直接移除完整标签作为显示文本
            const displayText = rawText.replace(/\[CORE\]/g, '').replace(/\[\/CORE\]/g, '')
            // 解析 core/context，供"转为评论/保存到 DB"使用
            const { core, context } = parseCoreContext(rawText)
            return { ...m, streaming: false, text: displayText, core, context }
          }
          return m
        })
        set({ conversationMessages: next, conversationLoading: false })
      }

      const onError = (errMsg) => {
        // 出错：回滚到 prevMessages（移除占位 ai 与本次 user 消息），设置错误
        set({ conversationMessages: prevMessages, conversationError: errMsg, conversationLoading: false })
      }

      await api.askConversationStream(
        selectedInspiration.id,
        conversationAddendumId,
        { question, history },
        { onDelta, onDone, onError }
      )
    } catch (err) {
      // 流式 fetch 本身抛错（非业务 error 帧）：回滚
      set({ conversationMessages: prevMessages, conversationError: err.message, conversationLoading: false })
    }
  },

  /**
   * 保存对话回答到 DB（书签）
   * 功能：把 conversationMessages[messageIndex] 的 question+answer 存到 DB，
   *   标记 saved=true，存 replyId
   *   v9：answer 保存 rawText（含 [CORE] 标签原文），同时保存 core/context 分层字段
   *        这样从 DB 加载时无需重新解析，且 answer 保留可重新解析的原文
   * @param {number} messageIndex - AI 消息在 conversationMessages 中的索引
   */
  saveConversationReply: async (messageIndex) => {
    const { selectedInspiration, conversationAddendumId, conversationMessages } = get()
    if (!selectedInspiration || !conversationAddendumId) return
    const aiMsg = conversationMessages[messageIndex]
    if (!aiMsg || aiMsg.role !== 'ai' || aiMsg.saved) return
    // 找到上一条 user 消息作为 question
    let question = ''
    for (let i = messageIndex - 1; i >= 0; i--) {
      if (conversationMessages[i].role === 'user') {
        question = conversationMessages[i].text
        break
      }
    }
    try {
      // v9：answer 存 rawText（含标签原文），core/context 为解析后的分层字段
      // 若 rawText 缺失（旧消息回退），用 text 兜底，core/context 此时为 null
      const rawText = aiMsg.rawText || aiMsg.text || ''
      const result = await api.saveReply(selectedInspiration.id, conversationAddendumId, {
        question,
        answer: rawText,
        core: aiMsg.core || null,
        context: aiMsg.context || null
      })
      if (result.success === false) {
        set({ conversationError: result.error || '保存失败' })
        return
      }
      const replyId = result.data?.id
      // 标记 saved=true 并存 replyId
      const next = conversationMessages.map((m, i) =>
        i === messageIndex ? { ...m, saved: true, replyId } : m
      )
      set({ conversationMessages: next })
      // 同步刷新 addenda 中的 saved_replies
      get().loadAddenda(selectedInspiration.id)
    } catch (err) {
      set({ conversationError: err.message })
    }
  },

  /**
   * 取消保存对话回答（从 DB 删除）
   * @param {number} messageIndex - AI 消息在 conversationMessages 中的索引
   */
  unsaveConversationReply: async (messageIndex) => {
    const { selectedInspiration, conversationMessages } = get()
    const aiMsg = conversationMessages[messageIndex]
    if (!aiMsg || !aiMsg.saved || !aiMsg.replyId) return
    try {
      await api.deleteReply(aiMsg.replyId)
      // 标记 saved=false 并清 replyId
      const next = conversationMessages.map((m, i) =>
        i === messageIndex ? { ...m, saved: false, replyId: null } : m
      )
      set({ conversationMessages: next })
      if (selectedInspiration?.id) get().loadAddenda(selectedInspiration.id)
    } catch (err) {
      set({ conversationError: err.message })
    }
  },

  /**
   * 加载所有灵感的已保存回答（继续思考面板用）
   */
  loadSavedReplies: async () => {
    set({ savedRepliesLoading: true })
    try {
      const result = await api.listAllSavedReplies()
      set({ savedRepliesList: result.data || [], savedRepliesLoading: false })
    } catch (err) {
      set({ savedRepliesLoading: false })
    }
  },

  /**
   * 打开继续思考面板
   */
  openContinueThinking: () => {
    set({ showContinueThinking: true })
    get().loadSavedReplies()
  },

  /**
   * 关闭继续思考面板
   */
  closeContinueThinking: () => {
    set({ showContinueThinking: false })
  },

  /**
   * 设置评论草稿（"转为评论"功能用）
   * 功能：把 AI 回答内容带到 AddendumSection 的评论输入框
   *   v9：新增 context 参数 —— "转为评论"时把 AI 回答的 core 作为评论核心、context 作为折叠内容
   *   v10：新增 sourceReplyId 参数 —— 同步设置 commentSourceReplyId，供 createComment 标记转化
   *        设计原因：commentDraft 会被 CommentInput 的 useEffect 立即调 onDraftConsumed 清空，
   *                  无法在 createComment 时再从 commentDraft 读取 replyId；
   *                  独立字段 commentSourceReplyId 不被清空，createComment 末尾显式清空
   * @param {string} addendumId - 追加条目 ID
   * @param {string} content - 评论核心文本（来自 AI 的 core 或文本兜底）
   * @param {string} [context] - 评论展开/阐释部分（来自 AI 的 context，可空）
   * @param {string} [sourceReplyId] - 源对话 ID（v10，可空；用于标记转化）
   */
  setCommentDraft: (addendumId, content, context, sourceReplyId) => {
    console.log('[Store] setCommentDraft called:', { addendumId, hasContent: !!content, hasContext: !!context, sourceReplyId })
    set({
      commentDraft: { addendumId, content, context: context || null },
      commentSourceReplyId: sourceReplyId || null
    })
  },

  /**
   * 清空评论草稿
   *   v10：仅清空 commentDraft，不清空 commentSourceReplyId
   *        原因：CommentInput 的 useEffect 在预填后会立即调本函数清空 commentDraft，
   *              但 createComment 仍需要 commentSourceReplyId，故此处保留；
   *              commentSourceReplyId 在 createComment 末尾显式清空
   */
  clearCommentDraft: () => {
    set({ commentDraft: null })
  },

  // ========== 文件夹 Actions（v8 新增） ==========

  /**
   * 加载文件夹列表
   */
  loadFolders: async () => {
    try {
      const result = await api.getFolders()
      set({ folders: result.data || [] })
    } catch (err) {
      console.warn('[Store] loadFolders failed:', err.message)
    }
  },

  /**
   * 创建文件夹
   */
  createFolder: async (name, color) => {
    try {
      const result = await api.createFolder({ name, color })
      if (result.success && result.data) {
        set((state) => ({ folders: [...state.folders, result.data] }))
        return result.data
      }
    } catch (err) {
      console.warn('[Store] createFolder failed:', err.message)
    }
    return null
  },

  /**
   * 更新文件夹（名称/颜色）
   */
  updateFolder: async (id, data) => {
    try {
      const result = await api.updateFolder(id, data)
      if (result.success && result.data) {
        set((state) => ({
          folders: state.folders.map((f) => f.id === id ? result.data : f)
        }))
      }
    } catch (err) {
      console.warn('[Store] updateFolder failed:', err.message)
    }
  },

  /**
   * 删除文件夹（灵感散出）
   */
  deleteFolder: async (id) => {
    try {
      await api.deleteFolder(id)
      set((state) => ({
        folders: state.folders.filter((f) => f.id !== id),
        folderEditModal: state.folderEditModal?.id === id ? null : state.folderEditModal
      }))
      get().loadInspirations()
    } catch (err) {
      console.warn('[Store] deleteFolder failed:', err.message)
    }
  },

  /**
   * 移动灵感到文件夹（或散出）—— 乐观更新
   */
  moveInspirationToFolder: async (inspirationId, folderId) => {
    set((state) => ({
      inspirations: state.inspirations.map((ins) =>
        ins.id === inspirationId ? { ...ins, folder_id: folderId } : ins
      )
    }))
    try {
      await api.moveInspiration(inspirationId, folderId)
      get().loadFolders()
    } catch (err) {
      console.warn('[Store] moveInspirationToFolder failed:', err.message)
      get().loadInspirations()
    }
  },

  /**
   * 批量更新排序 —— 乐观更新
   */
  reorderItems: async ({ folders: folderItems, inspirations: inspirationItems }) => {
    if (inspirationItems?.length) {
      set((state) => ({
        inspirations: state.inspirations.map((ins) => {
          const item = inspirationItems.find((i) => i.id === ins.id)
          if (!item) return ins
          return { ...ins, sort_order: item.sort_order, folder_id: item.folder_id !== undefined ? item.folder_id : ins.folder_id }
        })
      }))
    }
    if (folderItems?.length) {
      set((state) => ({
        folders: state.folders.map((f) => {
          const item = folderItems.find((i) => i.id === f.id)
          return item ? { ...f, sort_order: item.sort_order } : f
        })
      }))
    }
    try {
      if (folderItems?.length) await api.reorderFolders(folderItems)
      if (inspirationItems?.length) await api.reorderInspirations(inspirationItems)
    } catch (err) {
      console.warn('[Store] reorderItems failed:', err.message)
      get().loadInspirations()
      get().loadFolders()
    }
  },

  /**
   * 切换文件夹展开/折叠
   */
  toggleFolderExpanded: (folderId) => {
    set((state) => ({
      folderExpanded: { ...state.folderExpanded, [folderId]: !state.folderExpanded[folderId] }
    }))
  },

  /**
   * 打开文件夹编辑弹窗
   */
  openFolderEdit: (folder) => {
    set({ folderEditModal: folder })
  },

  /**
   * 关闭文件夹编辑弹窗
   */
  closeFolderEdit: () => {
    set({ folderEditModal: null })
  },

  /**
   * 合并创建文件夹（Android 式拖拽合并）
   */
  createFolderFromMerge: async (inspirationIdA, inspirationIdB) => {
    try {
      const result = await api.createFolder({ name: '未命名文件夹', color: '#60a5fa' })
      if (result.success && result.data) {
        const folder = result.data
        await api.moveInspiration(inspirationIdA, folder.id)
        await api.moveInspiration(inspirationIdB, folder.id)
        set((state) => ({
          folders: [...state.folders, { ...folder, inspiration_count: 2 }],
          inspirations: state.inspirations.map((ins) =>
            (ins.id === inspirationIdA || ins.id === inspirationIdB)
              ? { ...ins, folder_id: folder.id }
              : ins
          ),
          folderExpanded: { ...state.folderExpanded, [folder.id]: true },
          folderEditModal: folder
        }))
      }
    } catch (err) {
      console.warn('[Store] createFolderFromMerge failed:', err.message)
    }
  }
}))

export default useStore
