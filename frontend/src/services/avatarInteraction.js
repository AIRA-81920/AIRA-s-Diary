// AIRA 头像交互纯逻辑模块
// 功能：提供长按判定、抖动幅度计算、衰减计算、导航判定的纯函数
// 实现方式：所有函数无副作用、无 DOM 依赖，便于单元测试
// 这些函数被 Header.jsx 中的 AIRAAvatar 组件调用，控制弹跳和雨刮式抖动交互

// ==================== 常量 ====================

// 长按判定阈值：按住超过此时间则从"等待单击"切换为"开始抖动"
export const LONG_PRESS_THRESHOLD = 150 // ms

// 触发导航的总按住时长：从 mousedown 开始计算，达到此时间后跳转 GitHub
export const NAVIGATE_HOLD_MS = 1500 // ms

// 抖动增长阶段时长：从长按开始到导航触发之间的时间（1500 - 150 = 1350ms）
// 在此期间抖动幅度从 0 线性增长到 MAX_SHAKE_ANGLE
export const GROWTH_DURATION_MS = NAVIGATE_HOLD_MS - LONG_PRESS_THRESHOLD // 1350ms

// 衰减阶段时长：松手后抖动幅度从当前值线性衰减到 0 的时间
export const DECAY_DURATION_MS = 500 // ms

// 雨刮式抖动的最大角度（度）：增长阶段的最终幅度封顶值
export const MAX_SHAKE_ANGLE = 10 // 度

// ==================== 纯函数 ====================

/**
 * 判定按住时长是否构成长按
 * @param {number} holdDurationMs - 从 mousedown 到当前的时间（毫秒）
 * @returns {boolean} - true 表示已超过阈值，进入长按/抖动阶段
 */
export function isLongPress(holdDurationMs) {
  return holdDurationMs >= LONG_PRESS_THRESHOLD
}

/**
 * 计算抖动增长阶段的当前幅度（角度）
 * 在长按开始后（超过 150ms 阈值），幅度从 0 线性增长到 MAX_SHAKE_ANGLE
 * 超过 GROWTH_DURATION_MS 后封顶在 MAX_SHAKE_ANGLE
 * @param {number} growthElapsedMs - 从长按开始（超过阈值后）经过的时间（毫秒）
 * @returns {number} - 当前抖动幅度（度），范围 0 ~ MAX_SHAKE_ANGLE
 */
export function getShakeAmplitude(growthElapsedMs) {
  // 防御负值输入
  if (growthElapsedMs <= 0) return 0
  // 线性插值：elapsed / duration * maxAngle
  const ratio = growthElapsedMs / GROWTH_DURATION_MS
  // 封顶：超过增长时长后幅度不再增加
  return Math.min(ratio, 1) * MAX_SHAKE_ANGLE
}

/**
 * 计算衰减阶段的当前幅度（角度）
 * 松手后，抖动幅度从松手时的峰值线性衰减到 0
 * @param {number} peakAngle - 松手时的抖动幅度峰值（度）
 * @param {number} decayElapsedMs - 从松手开始经过的衰减时间（毫秒）
 * @returns {number} - 当前衰减后的抖动幅度（度），范围 0 ~ peakAngle
 */
export function getDecayAmplitude(peakAngle, decayElapsedMs) {
  // 峰值为 0 时无需衰减
  if (peakAngle <= 0) return 0
  // 衰减超过时长后幅度为 0
  if (decayElapsedMs >= DECAY_DURATION_MS) return 0
  // 线性衰减：peak * (1 - elapsed / duration)
  const ratio = 1 - decayElapsedMs / DECAY_DURATION_MS
  return peakAngle * Math.max(ratio, 0)
}

/**
 * 判定按住时长是否触发导航跳转
 * @param {number} holdDurationMs - 从 mousedown 到当前的时间（毫秒）
 * @returns {boolean} - true 表示应跳转到 GitHub
 */
export function shouldNavigate(holdDurationMs) {
  return holdDurationMs >= NAVIGATE_HOLD_MS
}
