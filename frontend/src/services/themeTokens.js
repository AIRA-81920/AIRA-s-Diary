// 主题语义色单一来源（亮色模式改造新建）
// 功能：所有"按主题取不同值"的 JS 侧语义色集中在此，组件不再各自硬编码
// 实现方式：
//   - 常量按 dark / light 分组；dark 值与原硬编码完全一致（dark 视觉零变化）
//   - currentTheme() 直接读 <html data-theme>（store.setTheme 与 index.jsx 启动时都会设置），
//     避免与 store 形成循环依赖
//   - 组件在渲染期调用取值函数；App 订阅 store.theme，主题切换时全树重渲染，
//     因此渲染期取值天然跟随主题
// 使用方：fragmentMeta.js（KIND_COLORS 代理）、ForceGraph.jsx、InspirationDetail.jsx 等

/**
 * 当前主题
 * @returns {'dark'|'light'}
 */
export function currentTheme() {
  if (typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light') {
    return 'light'
  }
  return 'dark'
}

// 词块 kind → 颜色（fragmentMeta.KIND_COLORS 的数据源）
export const KIND_COLORS = {
  dark: {
    reference: '#3b82f6',
    technique: '#10b981',
    imagery:   '#f59e0b',
    concept:   '#a855f7',
    warning:   '#ef4444',
    material:  '#06b6d4'
  },
  light: {
    reference: '#2563eb',
    technique: '#059669',
    imagery:   '#d97706',
    concept:   '#9333ea',
    warning:   '#dc2626',
    material:  '#0891b2'
  }
}

// kind 未知时的兜底灰
export const KIND_FALLBACK = {
  dark: '#6b7280',
  light: '#64748b'
}

// 桥梁类型 → 颜色（原 InspirationDetail.jsx 与 ForceGraph.jsx 重复定义，此处统一）
// 2026-08：桥梁类型精简为 3 种（意象同构/结构共振/主题对立），移除情感回响/技法迁移
// 说明：库里历史遗留的 emotion_echo / technique_transfer 桥仍会显示，靠 BRIDGE_FALLBACK 灰兜底。
export const BRIDGE_COLORS = {
  dark: {
    imagery_isomorphism:  '#f59e0b',  // 意象同构：橙色
    structure_resonance:  '#3b82f6',  // 结构共振：蓝色
    theme_opposition:     '#ef4444'   // 主题对立：红色
  },
  light: {
    imagery_isomorphism:  '#d97706',
    structure_resonance:  '#2563eb',
    theme_opposition:     '#dc2626'
  }
}

// 桥梁色兜底（边/节点染色失败时）
export const BRIDGE_FALLBACK = {
  dark: '#6b7280',
  light: '#64748b'
}

// 主强调色
export const ACCENT = {
  dark:  { cyan: '#06b6d4', amber: '#f59e0b' },
  light: { cyan: '#0891b2', amber: '#d97706' }
}

// ForceGraph d3 直写色（SVG attr 无法走 CSS 变量，必须按主题取值）
export const GRAPH_THEME = {
  dark: {
    nodeFill: 'rgba(255,255,255,0.18)',      // 无桥节点填充
    nodeStroke: 'rgba(255,255,255,0.4)',     // 节点描边
    nodeStrokeIsolated: 'rgba(255,255,255,0.5)', // 孤立节点描边
    nodeHover: '#fff',                       // hover 描边
    labelFill: 'rgba(255,255,255,0.6)',      // 图例文字
    nodeAccent: '#06b6d4'                    // 有桥节点染色兜底
  },
  light: {
    nodeFill: 'rgba(27,36,56,0.22)',
    nodeStroke: 'rgba(27,36,56,0.45)',
    nodeStrokeIsolated: 'rgba(27,36,56,0.5)',
    nodeHover: '#1b2438',
    labelFill: 'rgba(27,36,56,0.62)',
    nodeAccent: '#0891b2'
  }
}

/**
 * 取当前主题的词块 kind 色表
 * @param {'dark'|'light'} [theme]
 */
export function getKindColors(theme = currentTheme()) {
  return KIND_COLORS[theme] || KIND_COLORS.dark
}

/**
 * 取当前主题的桥梁色表
 * @param {'dark'|'light'} [theme]
 */
export function getBridgeColors(theme = currentTheme()) {
  return BRIDGE_COLORS[theme] || BRIDGE_COLORS.dark
}

/**
 * 取某个 kind 的颜色（含兜底）
 * @param {string} kind
 * @param {'dark'|'light'} [theme]
 */
export function getKindColor(kind, theme = currentTheme()) {
  const colors = getKindColors(theme)
  return colors[kind] || KIND_FALLBACK[theme] || KIND_FALLBACK.dark
}

/**
 * 取某个桥梁类型的颜色（含兜底）
 * @param {string} bridgeType
 * @param {'dark'|'light'} [theme]
 */
export function getBridgeColor(bridgeType, theme = currentTheme()) {
  const colors = getBridgeColors(theme)
  return colors[bridgeType] || BRIDGE_FALLBACK[theme] || BRIDGE_FALLBACK.dark
}

/**
 * 取 ForceGraph 当前主题的 d3 色表
 * @param {'dark'|'light'} [theme]
 */
export function getGraphTheme(theme = currentTheme()) {
  return GRAPH_THEME[theme] || GRAPH_THEME.dark
}

// ========== 文件夹预设色板（v8 新增） ==========
// 暗色模式用偏亮色（深底上可见），亮色模式用偏暗色（浅底上有对比）
// 与 sem-* / KIND_COLORS / BRIDGE_COLORS 取值策略一致
export const FOLDER_PRESET_COLORS = {
  dark: {
    blue:   '#60a5fa',
    purple: '#c084fc',
    cyan:   '#22d3ee',
    green:  '#4ade80',
    amber:  '#fbbf24',
    red:    '#f87171',
    pink:   '#f472b6',
    slate:  '#94a3b8'
  },
  light: {
    blue:   '#2563eb',
    purple: '#9333ea',
    cyan:   '#0891b2',
    green:  '#16a34a',
    amber:  '#d97706',
    red:    '#dc2626',
    pink:   '#db2777',
    slate:  '#64748b'
  }
}

/**
 * 取当前主题的文件夹预设色板
 * @param {'dark'|'light'} [theme]
 * @returns {Object<string, string>} { blue: '#60a5fa', ... }
 */
export function getFolderPresetColors(theme = currentTheme()) {
  return FOLDER_PRESET_COLORS[theme] || FOLDER_PRESET_COLORS.dark
}

// ========== 灵感类型色板（UI 精修，v7 定稿） ==========
// 功能：9 种灵感类型各自的代表色，用于：
//   - 灵感网络图节点 fill（节点 = 灵感类型色，边 = 桥梁色，两者分离互不影响）
//   - 侧边栏灵感条目右侧 8px 类型小色点
// 设计约束（v7 定稿，经用户逐色审查）：
//   - 整体平淡化：低饱和、高明度，深背景不刺眼
//   - "产品想法"天蓝与"研究好奇"青蓝拉开；"角色人物"亮黄与"美学提案"浅玫红拉开
//   - "创作素材"用黄绿（黄多于绿）；"概念"用紫罗兰、"设定世界观"用朱红（用户指定互换）
//   - 与文件夹预设色（分组维度）部分接近属预期：类型色用于小色点/网络图节点，
//     文件夹色用于侧边栏分组/微光，尺寸与位置不同，实际混淆风险低
// 取值策略与 KIND_COLORS / BRIDGE_COLORS 一致：暗色用偏亮、亮色用偏深。
export const INSPIRATION_TYPE_COLORS = {
  dark: {
    '产品想法': '#4e93ec',   // 柔天蓝：理性、构建
    '氛围画面': '#e5a84e',   // 柔琥珀：感官、氛围
    '设定世界观': '#dd5b52', // 朱红：想象、设定（用户指定与概念互换）
    '创作素材': '#aecb60',   // 黄绿偏黄：生长、素材
    '研究好奇': '#38bdd6',   // 青蓝：探索、追问
    '角色人物': '#e8cf5a',   // 亮黄：情感、人物
    '概念': '#a58cf0',       // 紫罗兰：抽象、命名（用户指定与世界观互换）
    '美学提案': '#e9859f',   // 浅玫红：风格、主张
    '其他': '#93a1b3'        // 柔灰：兜底
  },
  light: {
    '产品想法': '#3572c9',
    '氛围画面': '#c78f36',
    '设定世界观': '#b8453d',
    '创作素材': '#8ca94b',
    '研究好奇': '#2a93a8',
    '角色人物': '#c4ab3e',
    '概念': '#7f66d6',
    '美学提案': '#c46884',
    '其他': '#5f6e84'
  }
}

/**
 * 取当前主题的灵感类型色
 * 功能：按灵感类型取代表色；未知类型返回 null（调用方自行兜底灰色）
 * @param {string} [type] - 灵感类型（如 '产品想法'）；inspiration_type 字段
 * @param {'dark'|'light'} [theme]
 * @returns {string|null} hex 色值或 null
 */
export function getInspirationTypeColor(type, theme = currentTheme()) {
  if (!type) return null
  const table = INSPIRATION_TYPE_COLORS[theme] || INSPIRATION_TYPE_COLORS.dark
  return table[type] || null
}
