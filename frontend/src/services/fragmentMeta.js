// Fragment Meta 前端共享映射（K3-g，架构 §10.5 R9 单一来源）
// 功能：为每个 fragment_type 提供中文 label、对应 chunk kind、kind 颜色
// 实现方式：本文件是 backend/src/config/constants.js 中 FRAGMENT_META 的同步副本
//           （前端无法直接 import 后端模块，由开发约定保持语义一致）
// 使用方：EpitaxyPanel.jsx、InspirationDetail.jsx（外延档案区）等需要渲染 fragment 的组件
//
// 设计原则（架构 §10.5）：
//   - 后端 FRAGMENT_TEMPLATES + FRAGMENT_META 是单一来源
//   - 前端本文件是其同步副本，禁止在组件内硬编码 fragment_type 映射
//   - 新增 fragment_type 时必须同时改后端 constants.js 与本文件

// 8 种灵感类型 × 4 种 fragment_type + 兜底 4 种 = 36 种取值空间
// K4 改造：删除"方法流程"行（与后端 constants.js 同步，v4 迁移后历史数据归入"其他"）
// K4-a 改造：新增"美学提案"行
// fix6 改造：删除"概念命题"行，新增"概念"行（与后端 constants.js 同步）
// 契约：后端 excavate 只输出该灵感类型对应行的 4 种 key
export const FRAGMENT_TEMPLATES = {
  '产品想法': ['existing_case', 'anti_pattern', 'tech_constraint', 'user_scenario'],
  '氛围画面': ['visual_reference', 'sensory_detail', 'color_palette', 'mood_contrast'],
  '设定世界观': ['precedent', 'internal_logic', 'edge_case', 'cultural_root'],
  '创作素材': ['material_source', 'technique', 'variation', 'combination'],
  '研究好奇': ['existing_theory', 'open_question', 'counter_evidence', 'implication'],
  '角色人物': ['archetype', 'contradiction', 'motivation', 'voice'],
  '概念': ['concept_precedent', 'distinction_case', 'application_case', 'evolution_case'],  // fix6 新增
  '美学提案': ['aesthetic_precedent', 'variation_case', 'combination_case', 'cultural_root'],
  '其他': ['existing_case', 'concept', 'warning', 'blank']
}

// 每个 fragment_type 的元信息
// - label：中文标签（UI 展示）
// - kind：对应的 chunk kind 枚举值（reference/technique/imagery/concept/warning/material）
// - desc：LLM 提示描述（仅后端 prompt 使用，前端不需要但保留以便对账）
export const FRAGMENT_META = {
  // 产品想法
  existing_case:    { label: '同类案例', kind: 'reference', desc: '已存在的同类产品/功能案例，可借鉴其设计决策' },
  anti_pattern:     { label: '反面模式', kind: 'warning',   desc: '应避免的设计反模式或失败案例' },
  tech_constraint:  { label: '技术约束', kind: 'concept',   desc: '实现层面的技术限制、依赖与权衡' },
  user_scenario:    { label: '用户场景', kind: 'imagery',   desc: '用户使用此产品的具体场景与触发时机' },
  // 氛围画面
  visual_reference: { label: '视觉参考', kind: 'reference', desc: '可参考的视觉作品、画家、影像或摄影' },
  sensory_detail:   { label: '感官细节', kind: 'imagery',   desc: '具体的感官描写细节（视觉/听觉/触觉）' },
  color_palette:    { label: '配色方案', kind: 'material',  desc: '可借鉴的配色组合与色彩关系' },
  mood_contrast:    { label: '情绪对比', kind: 'concept',   desc: '画面中的情绪张力与对比结构' },
  // 设定世界观
  precedent:        { label: '先例',     kind: 'reference', desc: '类似世界观的已有作品先例与处理方式' },
  internal_logic:   { label: '内在逻辑', kind: 'concept',   desc: '世界观的自洽性规则与运行机制' },
  edge_case:        { label: '边界情况', kind: 'warning',   desc: '设定可能崩塌或被挑战的极端场景' },
  cultural_root:    { label: '文化根源', kind: 'reference', desc: '设定背后的文化、历史或哲学根源' },
  // 创作素材
  material_source:  { label: '素材来源', kind: 'material',  desc: '可用的原始素材来源（文献/实物/田野）' },
  technique:        { label: '技法',     kind: 'technique', desc: '处理此素材的具体技法或手法' },
  variation:        { label: '变体',     kind: 'concept',   desc: '素材可能的变体方向与演绎' },
  combination:      { label: '组合',     kind: 'concept',   desc: '素材间的组合可能与方法' },
  // 研究好奇
  existing_theory:  { label: '已有理论', kind: 'reference', desc: '相关领域的已有理论与经典论述' },
  open_question:    { label: '开放问题', kind: 'concept',   desc: '领域内尚未解决的核心问题' },
  counter_evidence: { label: '反证',     kind: 'warning',   desc: '与假设相悖的证据或反例' },
  implication:      { label: '推论',     kind: 'concept',   desc: '若假设成立可推导出的进一步结论' },
  // 角色人物
  archetype:        { label: '原型',     kind: 'reference', desc: '角色对应的原型或文学形象谱系' },
  contradiction:    { label: '矛盾',     kind: 'concept',   desc: '角色内在的矛盾张力与性格层次' },
  motivation:       { label: '动机',     kind: 'concept',   desc: '角色行为的深层动机与心理根源' },
  voice:            { label: '声音',     kind: 'imagery',   desc: '角色的语言风格、口吻与口头禅' },
  // 方法流程
  failure_mode:     { label: '失败模式', kind: 'warning',   desc: '流程可能失败的环节与典型故障' },
  optimization:     { label: '优化',     kind: 'technique', desc: '可优化的关键点与改进手法' },
  integration:      { label: '集成',     kind: 'concept',   desc: '与其他流程或系统的集成方式' },
  // 概念（fix6 新增，替换原"概念命题"的 support_arg/counter_arg/analogy）
  concept_precedent: { label: '概念先例', kind: 'reference', desc: '已有相似概念的先例，可借以理解这个概念的边界' },
  distinction_case:  { label: '区分案例', kind: 'concept',   desc: '与相邻概念的具体区分案例，展示何时该用/不该用此概念' },
  application_case:  { label: '应用案例', kind: 'imagery',   desc: '这个概念在具体场景中如何体现/落地的实际案例' },
  evolution_case:    { label: '演化可能', kind: 'concept',   desc: '这个概念未来可能演化为何种形态（命题/产品/美学/方法论）' },
  // 美学提案（K4-a 新增）
  aesthetic_precedent: { label: '美学先例', kind: 'reference', desc: '已有美学流派先例，作为参考或对比对象' },
  variation_case:      { label: '变体案例', kind: 'concept',   desc: '这个流派可能的变体方向与演绎案例' },
  combination_case:    { label: '组合案例', kind: 'technique', desc: '这个流派与其他流派组合的可能与方法' },
  // cultural_root 已在"设定世界观"中定义，复用即可
  // 兜底（其他）
  concept:          { label: '概念',     kind: 'concept',   desc: '与灵感相关的抽象概念' },
  warning:          { label: '陷阱',     kind: 'warning',   desc: '需注意的陷阱或风险' },
  blank:            { label: '笔记',     kind: 'material',  desc: '空白待填的笔记占位' }
}

// 词块 kind → 颜色映射
// 亮色模式改造：色值单一来源移至 services/themeTokens.js（按 dark/light 分组）
// 这里用 Proxy 保持原有 KIND_COLORS[kind] 访问方式不变，渲染期按当前主题取值
// （App 订阅 store.theme，主题切换时全树重渲染，取值自然跟随）
import { getKindColors, getKindColor } from './themeTokens.js'

export const KIND_COLORS = new Proxy({}, {
  get: (_, key) => getKindColors()[key],
  ownKeys: () => Reflect.ownKeys(getKindColors()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
})

// kind 中文标签
export const KIND_LABELS = {
  reference: '引用',
  technique: '技法',
  imagery:   '意象',
  concept:   '概念',
  warning:   '陷阱',
  material:  '素材'
}

// =========================================================================
// 辅助函数：从 fragment_type 取元信息
// =========================================================================

// 获取 fragment_type 对应的中文 label
// 功能：从 FRAGMENT_META 取 label，未知 type 回退到 '笔记'
export function getFragmentLabel(fragmentType) {
  return FRAGMENT_META[fragmentType]?.label || '笔记'
}

// 获取 fragment_type 对应的 chunk kind
// 功能：从 FRAGMENT_META 取 kind，未知 type 回退到 'material'
export function getFragmentKind(fragmentType) {
  return FRAGMENT_META[fragmentType]?.kind || 'material'
}

// 获取 fragment_type 对应的颜色（基于 kind 映射）
// 功能：先取 kind，再按当前主题取颜色，未知回退到主题灰
export function getFragmentColor(fragmentType) {
  const kind = getFragmentKind(fragmentType)
  return getKindColor(kind)
}

// 获取指定灵感类型对应的 4 种 fragment_type 列表
// 功能：从 FRAGMENT_TEMPLATES 取对应行，未知类型回退到兜底"其他"
export function getFragmentTypesForInspirationType(inspirationType) {
  return FRAGMENT_TEMPLATES[inspirationType] || FRAGMENT_TEMPLATES['其他']
}

// 获取 chunk kind 对应的颜色
// 功能：按当前主题取颜色，未知 kind 回退到主题灰（用于档案区展示词块）
export function getFragmentKindColor(kind) {
  return getKindColor(kind)
}

// 获取 chunk kind 对应的中文标签
// 功能：从 KIND_LABELS 取标签，未知 kind 回退到 '素材'（用于档案区展示词块）
export function getFragmentKindLabel(kind) {
  return KIND_LABELS[kind] || '素材'
}
