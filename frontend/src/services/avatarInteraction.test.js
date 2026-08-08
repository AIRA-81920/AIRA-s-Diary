// AIRA 头像交互逻辑测试
// 测试纯函数模块 avatarInteraction.js 的核心行为：
// 1. 长按判定（150ms 阈值区分单击和长按）
// 2. 抖动角度增长（长按期间幅度从 0 线性增长到最大值）
// 3. 衰减角度（松手后幅度从当前值线性衰减到 0）
// 4. 导航判定（长按达到 1500ms 触发跳转）
import { describe, it, expect } from 'vitest'
import {
  isLongPress,
  getShakeAmplitude,
  getDecayAmplitude,
  shouldNavigate,
  LONG_PRESS_THRESHOLD,
  NAVIGATE_HOLD_MS,
  MAX_SHAKE_ANGLE,
  GROWTH_DURATION_MS,
  DECAY_DURATION_MS,
} from './avatarInteraction.js'

describe('isLongPress', () => {
  it('按住不足 150ms 时判定为单击（非长按）', () => {
    expect(isLongPress(0)).toBe(false)
    expect(isLongPress(100)).toBe(false)
    expect(isLongPress(149)).toBe(false)
  })

  it('按住达到 150ms 时判定为长按', () => {
    expect(isLongPress(150)).toBe(true)
    expect(isLongPress(500)).toBe(true)
  })
})

describe('getShakeAmplitude', () => {
  it('长按刚开始时（0ms）幅度为 0', () => {
    expect(getShakeAmplitude(0)).toBe(0)
  })

  it('长按到最大增长时长时幅度达到 MAX_SHAKE_ANGLE', () => {
    expect(getShakeAmplitude(GROWTH_DURATION_MS)).toBeCloseTo(MAX_SHAKE_ANGLE, 5)
  })

  it('幅度随时间线性增长', () => {
    // 中间点应约为最大角度的一半
    const midAmplitude = getShakeAmplitude(GROWTH_DURATION_MS / 2)
    expect(midAmplitude).toBeCloseTo(MAX_SHAKE_ANGLE / 2, 1)
  })

  it('超过最大增长时长后幅度封顶在 MAX_SHAKE_ANGLE', () => {
    expect(getShakeAmplitude(GROWTH_DURATION_MS + 500)).toBe(MAX_SHAKE_ANGLE)
  })

  it('负值输入返回 0（防御无效时间）', () => {
    expect(getShakeAmplitude(-100)).toBe(0)
  })
})

describe('getDecayAmplitude', () => {
  it('衰减开始时幅度等于峰值', () => {
    expect(getDecayAmplitude(8, 0)).toBe(8)
  })

  it('衰减结束时幅度降为 0', () => {
    expect(getDecayAmplitude(8, DECAY_DURATION_MS)).toBe(0)
  })

  it('衰减过程中幅度线性递减', () => {
    // 中间点应约为峰值的一半
    const midAmplitude = getDecayAmplitude(10, DECAY_DURATION_MS / 2)
    expect(midAmplitude).toBeCloseTo(5, 1)
  })

  it('衰减超过时长后幅度保持 0', () => {
    expect(getDecayAmplitude(8, DECAY_DURATION_MS + 200)).toBe(0)
  })

  it('峰值为 0 时衰减结果始终为 0', () => {
    expect(getDecayAmplitude(0, 0)).toBe(0)
    expect(getDecayAmplitude(0, 250)).toBe(0)
  })
})

describe('shouldNavigate', () => {
  it('按住不足 1500ms 时不触发导航', () => {
    expect(shouldNavigate(0)).toBe(false)
    expect(shouldNavigate(500)).toBe(false)
    expect(shouldNavigate(1499)).toBe(false)
  })

  it('按住达到 1500ms 时触发导航', () => {
    expect(shouldNavigate(1500)).toBe(true)
    expect(shouldNavigate(2000)).toBe(true)
  })
})

describe('常量', () => {
  it('LONG_PRESS_THRESHOLD 应为 150ms', () => {
    expect(LONG_PRESS_THRESHOLD).toBe(150)
  })

  it('NAVIGATE_HOLD_MS 应为 1500ms', () => {
    expect(NAVIGATE_HOLD_MS).toBe(1500)
  })

  it('MAX_SHAKE_ANGLE 应为正数（度）', () => {
    expect(MAX_SHAKE_ANGLE).toBeGreaterThan(0)
    expect(MAX_SHAKE_ANGLE).toBeLessThanOrEqual(15)
  })

  it('GROWTH_DURATION_MS 应等于 NAVIGATE_HOLD_MS - LONG_PRESS_THRESHOLD', () => {
    expect(GROWTH_DURATION_MS).toBe(NAVIGATE_HOLD_MS - LONG_PRESS_THRESHOLD)
  })

  it('DECAY_DURATION_MS 应为正数', () => {
    expect(DECAY_DURATION_MS).toBeGreaterThan(0)
  })
})
