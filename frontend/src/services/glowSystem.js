// =========================================================================
// glowSystem — 微光系统核心模块（独立文件，可扩展）
// 功能：为所有"可互动组件"提供统一的"鼠标跟随光斑 + 边框呼应"发光效果
// 实现方式：
//   - 全局事件委托：只在 document 上挂一个 mousemove 监听，处理所有发光元素
//     （新组件只需套 .glow-btn / .glow-card 类即自动生效，杜绝再次发散）
//   - 边界：只有带发光类（或 data-glow）的元素才发光，背板/静态内容不参与
//   - 主题适配：颜色由 CSS 变量（index.css 中 --glow-*）按 data-theme 自动切换，
//     本模块只负责光斑坐标与激活态，不关心颜色细节
//   - 性能：getBoundingClientRect 仅在切换元素时计算一次；mousemove 只做算术 +
//     requestAnimationFrame 节流更新 2 个 CSS 变量（无重排、无布局动画）
//
// 扩展方式（新增颜色）：
//   1. 本文件 GLOW_COLORS 注册表加一条（供 JS 按主题取色）
//   2. index.css 加同名 --glow-* 变量 + [data-glow] 选择器
//   3. 组件里 data-glow="新key" 即可
// =========================================================================

// 光效色注册表（JS 侧单一来源，供需要按主题取色的场景使用）
// 结构：key → { light: 'R G B', dark: 'R G B' }（RGB 三元组，供 rgb()/透明度组合）
// 注意：CSS 侧在 index.css 中同步定义了 --glow-* 变量（类选择器用），两者须保持一致
export const GLOW_COLORS = {
  cyan:  { light: '8 145 178',  dark: '6 182 212'  },   // 默认交互（青）
  amber: { light: '217 119 6',  dark: '245 158 11' },   // 特殊功能（琥珀，如"接着想"）
  purple:{ light: '147 51 234', dark: '168 85 247' }    // 网络/外延强调（紫）
  // 未来扩展示例：
  // rose:  { light: '225 29 72',  dark: '244 63 94'  }, // 危险/删除强调
  // green: { light: '5 150 105',  dark: '16 185 129' } // 成功/完成强调
};

// 发光元素选择器：事件委托的匹配范围（背板/静态内容不带这些类，即不发光）
const GLOW_SELECTOR = '.glow-btn, .glow-card, [data-glow]';

// 当前正在发光的元素（单例：同一时刻只有鼠标所在的那一个）
let activeEl = null;
// 元素切换时缓存的 rect（避免 mousemove 高频调用 getBoundingClientRect 强制重排）
let cachedRect = null;
// rAF 句柄：把坐标写入合并到一帧，避免高频 style 写入
let rafId = 0;

/**
 * 从 hex 颜色转换为 'R G B' 三元组字符串
 * 功能：文件夹色是用户自选 hex，发光组件需转成 RGB 供 rgb(var(--glow)/alpha) 使用
 * 实现方式：正则校验 6 位 hex → parseInt 拆出 R/G/B
 * @param {string} hex - '#60a5fa' 或 '60a5fa'
 * @returns {string|null} '96 165 250' 或 null（格式非法时）
 */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/**
 * 按当前主题解析注册表颜色
 * 功能：供 JS 侧动态取色（如把某个 key 的颜色赋给 --glow 变量）
 * 实现方式：读 <html data-theme>（与 themeTokens.currentTheme 一致），未知 key 返回 null
 * @param {string} key - GLOW_COLORS 中的 key，如 'cyan'
 * @returns {string|null} '6 182 212' 或 null
 */
export function resolveGlowColor(key) {
  const entry = GLOW_COLORS[key];
  if (!entry) return null;
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  return entry[theme] || entry.dark;
}

/**
 * 单帧写入光斑坐标（rAF 节流：把 mousemove 的高频事件合并到渲染帧）
 * 功能：把缓存的 _mx/_my（相对发光元素的坐标）写入 CSS 变量 --mx/--my
 */
function flushSpot() {
  rafId = 0;
  if (!activeEl) return;
  activeEl.style.setProperty('--mx', `${activeEl._mx}px`);
  activeEl.style.setProperty('--my', `${activeEl._my}px`);
}

/**
 * 全局 mousemove 委托处理器
 * 功能：
 *   - 每次鼠标移动，从事件源向上查找最近的光元素（closest）
 *   - 若与当前激活元素不同 → 切换激活态（旧元素移除 .glow-active，新元素加上）
 *   - 同一时刻只有一个发光元素（鼠标所在的那个），其余保持安静
 * 实现方式：
 *   - closest 只在元素切换时调用 getBoundingClientRect（缓存 rect）
 *   - 坐标差值计算是纯算术，写入交给 rAF 节流
 * @param {MouseEvent} e
 */
function onGlobalMove(e) {
  const el = e.target && e.target.closest ? e.target.closest(GLOW_SELECTOR) : null;
  if (el !== activeEl) {
    // 切换激活元素：旧元素熄灭，新元素点亮并缓存其 rect
    if (activeEl) activeEl.classList.remove('glow-active');
    activeEl = el;
    if (el) {
      el.classList.add('glow-active');
      cachedRect = el.getBoundingClientRect();
    } else {
      cachedRect = null;
    }
  }
  if (activeEl && cachedRect) {
    // 计算鼠标相对发光元素左上角的坐标
    activeEl._mx = e.clientX - cachedRect.left;
    activeEl._my = e.clientY - cachedRect.top;
    if (!rafId) rafId = requestAnimationFrame(flushSpot);
  }
}

/**
 * 初始化微光系统（全局事件委托）
 * 功能：在 document 上挂载单个 mousemove 监听，管理所有发光元素的激活态与光斑坐标
 * 实现方式：被动监听（passive）不影响滚动；幂等（重复调用只挂一次）
 * 调用方：index.jsx 启动时调用一次即可
 */
export function initGlowSystem() {
  if (window.__glowSystemInit) return;  // 幂等保护，防止 StrictMode 双执行重复挂载
  window.__glowSystemInit = true;
  document.addEventListener('mousemove', onGlobalMove, { passive: true });
}

export default { GLOW_COLORS, hexToRgb, resolveGlowColor, initGlowSystem };
