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
export const BRIDGE_COLORS = {
  dark: {
    imagery_isomorphism:  '#f59e0b',  // 意象同构：橙色
    structure_resonance:  '#3b82f6',  // 结构共振：蓝色
    emotion_echo:         '#ec4899',  // 情感回响：粉色
    technique_transfer:   '#10b981',  // 技法迁移：绿色
    theme_opposition:     '#ef4444'   // 主题对立：红色
  },
  light: {
    imagery_isomorphism:  '#d97706',
    structure_resonance:  '#2563eb',
    emotion_echo:         '#db2777',
    technique_transfer:   '#059669',
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
