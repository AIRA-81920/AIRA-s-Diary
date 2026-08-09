import React, { useState, useEffect, useRef } from 'react'
import { flushSync } from 'react-dom'
import useStore from '../services/store.js'
import { rippleSwitchTheme } from '../services/themeTransition.js'
import { X, Settings, Globe, Eye, EyeOff, Archive, RotateCcw, Trash2, Clock, Info, BookOpen, Github, Bug } from 'lucide-react'
// v12 快照机制：快照管理区块需要调用快照 API（列表/恢复/物理删除）
import api from '../services/api.js'
import { openExternalLink } from '../services/openLink.js'

// 各 Agent 元信息：label 显示名、description 描述、color 圆点颜色
// v11 多模态扩展：新增 VISION（识图）、DISTILL（提炼）
const AGENT_META = {
  CRYSTALLIZE: { label: '结晶 Crystallize', description: '灵感感知·追问·生成结晶体', color: 'var(--accent-cyan)' },
  EPITAXY: { label: '外延 Epitaxy', description: '方向提案·深挖·选词提炼', color: '#3b82f6' },
  COALESCE: { label: '融合 Coalesce', description: '跨灵感语义桥梁生成', color: '#a855f7' },
  CONVERSATION: { label: '对话 Conversation', description: '灵感上下文追问·联网搜索', color: 'var(--accent-amber)' },
  VISION: { label: '识图 Vision', description: '图片→客观描述（需多模态模型）', color: '#10b981' },
  DISTILL: { label: '提炼 Distill', description: '多文件→标题+描述提炼', color: '#f59e0b' }
}

// 推荐模型列表（datalist 下拉提示）
// v11 多模态扩展：新增 glm-4.6v、glm-4v-flash 视觉模型
const SUGGESTED_MODELS = [
  'gpt-4o', 'gpt-4o-mini', 'gpt-4.1',
  'deepseek-v4-pro', 'deepseek-v4-flash',
  'claude-4-sonnet', 'claude-4-haiku',
  'glm-4.6v', 'glm-4v-flash'
]

const CATEGORIES = [
  { key: 'api', label: 'API 设置', icon: Globe }
]

function FormField({ label, children, hint }) {
  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-ink/60 text-xs font-medium tracking-wide">{label}</label>
      </div>
      {children}
      {hint && <p className="text-ink/20 text-[10px] mt-1 leading-relaxed">{hint}</p>}
    </div>
  )
}

function PasswordInput({ value, onChange, placeholder }) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <input
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-veil/[0.04] border border-line/[0.08] rounded-lg px-3 py-2 text-sm text-ink/80 placeholder-ink/20 focus:outline-none focus:border-cyan-500/40 focus:bg-veil/[0.06] transition-all pr-10"
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink/30 hover:text-ink/60 transition-colors"
      >
        {show ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  )
}

function ModelInput({ value, onChange }) {
  const [focused, setFocused] = useState(false)
  const [listId] = useState(() => 'model-list-' + Math.random().toString(36).slice(2))
  const filtered = value
    ? SUGGESTED_MODELS.filter((m) => m.toLowerCase().includes(value.toLowerCase()))
    : SUGGESTED_MODELS
  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="输入模型名或选择…"
        list={listId}
        className="w-full bg-veil/[0.04] border border-line/[0.08] rounded-lg px-3 py-2 text-sm text-ink/80 placeholder-ink/20 focus:outline-none focus:border-cyan-500/40 focus:bg-veil/[0.06] transition-all"
      />
      <datalist id={listId}>
        {SUGGESTED_MODELS.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
      {focused && filtered.length > 0 && (
        <div className="absolute z-20 left-0 right-0 top-full mt-1 bg-[rgb(var(--deep2-rgb)_/_0.95)] backdrop-blur-xl border border-line/10 rounded-lg shadow-2xl max-h-40 overflow-y-auto">
          {filtered.map((m) => (
            <button
              key={m}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(m); setFocused(false) }}
              className="w-full text-left px-3 py-2 text-sm text-ink/70 hover:bg-veil/10 hover:text-ink/90 transition-colors"
            >
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TempSlider({ value, onChange }) {
  const display = value !== null && value !== undefined && !isNaN(value) ? value : 0.5
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min="0"
        max="2"
        step="0.1"
        value={display}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 h-1.5 bg-veil/[0.08] rounded-full appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:shadow-lg"
        style={{ filter: 'none', boxShadow: 'inset 0px 4px 8px 0px rgba(0, 0, 0, 0.25)' }}
      />
      <span className="text-ink/50 text-xs font-mono w-8 text-right tabular-nums">
        {display.toFixed(1)}
      </span>
    </div>
  )
}

function ApiSettingsTab() {
  const settingsData = useStore((s) => s.settingsData)
  const [local, setLocal] = useState(null)
  const [expandedAgent, setExpandedAgent] = useState(null)
  const settingsSaving = useStore((s) => s.settingsSaving)
  const saveSettings = useStore((s) => s.saveSettings)
  // 检测功能：检测中状态、检测结果、检测 action
  const settingsTesting = useStore((s) => s.settingsTesting)
  const testResults = useStore((s) => s.testResults)
  const testSettings = useStore((s) => s.testSettings)
  const clearTestResults = useStore((s) => s.clearTestResults)

  useEffect(() => {
    if (settingsData) {
      setLocal(structuredClone(settingsData))
    }
  }, [settingsData])

  if (!local) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-cyan-400/30 border-t-cyan-400" />
      </div>
    )
  }

  const updateGlobal = (key, val) => {
    setLocal((prev) => ({ ...prev, global: { ...prev.global, [key]: val } }))
  }
  const updateAgent = (agent, key, val) => {
    setLocal((prev) => ({
      ...prev,
      agents: { ...prev.agents, [agent]: { ...prev.agents[agent], [key]: val } }
    }))
  }
  const updateSearch = (key, val) => {
    setLocal((prev) => ({ ...prev, search: { ...prev.search, [key]: val } }))
  }

  const handleSave = () => {
    saveSettings(local)
  }

  // 点击检测：提交当前表单值到后端测试（不写入 .env）
  const handleTest = () => {
    testSettings(local)
  }

  return (
    <div className="space-y-6">
      {/* 全局默认 */}
      <div>
        <h3 className="text-ink/50 text-[10px] uppercase tracking-[0.2em] mb-3 font-sans">全局默认</h3>
        <div className="glow-card bg-veil/[0.03] border border-line/[0.06] rounded-xl p-5 space-y-1">
          <FormField label="API 密钥" hint="所有 Agent 共用的默认密钥">
            <PasswordInput
              value={local.global.api_key || ''}
              onChange={(v) => updateGlobal('api_key', v)}
              placeholder="sk-..."
            />
          </FormField>
          <FormField label="Base URL" hint="AI 网关地址，留空默认 OpenAI">
            <input
              type="text"
              value={local.global.base_url || ''}
              onChange={(e) => updateGlobal('base_url', e.target.value)}
              placeholder="https://api.openai.com/v1"
              className="w-full bg-veil/[0.04] border border-line/[0.08] rounded-lg px-3 py-2 text-sm text-ink/80 placeholder-ink/20 focus:outline-none focus:border-cyan-500/40 focus:bg-veil/[0.06] transition-all"
            />
          </FormField>
          <FormField label="默认模型" hint="未单独配置时各 Agent 共用的模型">
            <ModelInput
              value={local.global.default_model || ''}
              onChange={(v) => updateGlobal('default_model', v)}
            />
          </FormField>
          <FormField label="默认温度" hint="创造性控制，0 = 确定，2 = 自由">
            <TempSlider
              value={local.global.default_temperature}
              onChange={(v) => updateGlobal('default_temperature', v)}
            />
          </FormField>
        </div>
      </div>

      {/* 各 Agent 配置 */}
      <div>
        <h3 className="text-ink/50 text-[10px] uppercase tracking-[0.2em] mb-3 font-sans">按 Agent 自定义</h3>
        <div className="space-y-2">
          {Object.entries(AGENT_META).map(([key, meta]) => {
            const cfg = local.agents[key]
            const isExpanded = expandedAgent === key
            const hasOverride = !!(cfg?.model || cfg?.api_key || cfg?.base_url || (cfg?.temperature !== null && cfg?.temperature !== undefined))
            return (
              <div key={key} className="glow-card bg-veil/[0.03] border border-line/[0.06] rounded-xl overflow-hidden transition-all">
                <button
                  type="button"
                  onClick={() => setExpandedAgent(isExpanded ? null : key)}
                  className="glow-btn w-full flex items-center gap-3 px-5 py-3.5 text-left hover:bg-veil/[0.03] transition-colors rounded-xl"
                >
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: meta.color }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-ink/80 font-medium">{meta.label}</div>
                    <div className="text-[10px] text-ink/30 mt-0.5">{meta.description}</div>
                  </div>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${hasOverride ? 'bg-cyan-500/10 text-cyan-400/80' : 'bg-veil/[0.04] text-ink/30'}`}>
                    {hasOverride ? '已自定义' : '使用全局'}
                  </span>
                  <svg
                    className={`w-4 h-4 text-ink/30 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {isExpanded && (
                  <div className="px-5 pb-4 pt-1 border-t border-line/[0.04] space-y-1">
                    <FormField label="模型" hint={'覆盖全局默认模型'}>
                      <ModelInput value={cfg?.model || ''} onChange={(v) => updateAgent(key, 'model', v)} />
                    </FormField>
                    <FormField label="温度" hint="覆盖全局默认温度">
                      <TempSlider value={cfg?.temperature} onChange={(v) => updateAgent(key, 'temperature', v)} />
                    </FormField>
                    <FormField label="API 密钥（覆盖）" hint="为此 Agent 使用独立密钥">
                      <PasswordInput value={cfg?.api_key || ''} onChange={(v) => updateAgent(key, 'api_key', v)} placeholder="留空使用全局密钥" />
                    </FormField>
                    <FormField label="Base URL（覆盖）" hint="为此 Agent 使用独立网关">
                      <input
                        type="text"
                        value={cfg?.base_url || ''}
                        onChange={(e) => updateAgent(key, 'base_url', e.target.value)}
                        placeholder="留空使用全局 URL"
                        className="w-full bg-veil/[0.04] border border-line/[0.08] rounded-lg px-3 py-2 text-sm text-ink/80 placeholder-ink/20 focus:outline-none focus:border-cyan-500/40 focus:bg-veil/[0.06] transition-all"
                      />
                    </FormField>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* 联网搜索 */}
      <div>
        <h3 className="text-ink/50 text-[10px] uppercase tracking-[0.2em] mb-3 font-sans">联网搜索</h3>
        <div className="glow-card bg-veil/[0.03] border border-line/[0.06] rounded-xl p-5">
          <FormField label="Serper API 密钥" hint="用于对话中的联网搜索，留空则不启用。获取：serper.dev">
            <PasswordInput
              value={local.search.serper_api_key || ''}
              onChange={(v) => updateSearch('serper_api_key', v)}
              placeholder="留空禁用搜索"
            />
          </FormField>
        </div>
      </div>

      {/* 检测结果展示区：有结果时淡入显示 */}
      {testResults && (
        <div className="glow-card bg-veil/[0.03] border border-line/[0.06] rounded-xl p-4 space-y-2 animate-[fadeIn_0.2s_ease-out]">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-ink/60 text-[10px] uppercase tracking-[0.2em] font-sans">检测结果</h4>
            <button
              type="button"
              onClick={clearTestResults}
              className="text-ink/30 hover:text-ink/60 transition-colors text-[10px]"
            >
              关闭
            </button>
          </div>
          {testResults.map((r, i) => (
            <div
              key={i}
              className={`flex items-start gap-3 px-3 py-2 rounded-lg ${
                r.ok ? 'bg-emerald-500/[0.04]' : 'bg-rose-500/[0.04]'
              }`}
            >
              <span className={`flex-shrink-0 mt-0.5 ${r.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                {r.ok ? '✓' : '✗'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-ink/80 font-medium">{r.name}</span>
                  {r.model && <span className="text-[10px] text-ink/40 font-mono">{r.model}</span>}
                  {r.baseURL && (
                    <span className="text-[10px] text-ink/30 truncate max-w-[200px]">{r.baseURL}</span>
                  )}
                  {r.ok && r.latency != null && (
                    <span className="text-[10px] text-ink/30 ml-auto">{r.latency}ms</span>
                  )}
                </div>
                {r.ok ? (
                  r.reply && (
                    <p className="text-[11px] text-ink/40 mt-0.5 truncate">响应: {r.reply}</p>
                  )
                ) : (
                  <p className="text-[11px] text-rose-400/70 mt-0.5">{r.error}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 底部操作区：检测按钮 + 保存按钮 */}
      <div className="flex items-center justify-between pt-4 border-t border-line/[0.06]">
        <p className="text-ink/20 text-[10px]">
          保存后配置立即生效（无需重启）
        </p>
        <div className="flex items-center gap-3">
          {/* 检测按钮：用当前表单值测试 API 可用性，不写入 .env */}
          <button
            type="button"
            onClick={handleTest}
            disabled={settingsTesting || settingsSaving}
            className="glow-btn glass-card flex items-center gap-2 px-4 py-2.5 rounded-xl text-ink/70 hover:text-ink/95 text-sm font-medium transition-all disabled:opacity-50"
          >
            {settingsTesting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-2 border-line/30 border-t-cyan-400" />
                <span>检测中</span>
              </>
            ) : (
              <span>检测</span>
            )}
          </button>
          {/* 保存按钮：写入 .env 并立即 reload */}
          <button
            type="button"
            onClick={handleSave}
            disabled={settingsSaving || settingsTesting}
            className="glow-btn btn-accent flex items-center gap-2 px-5 py-2.5 rounded-xl text-white text-sm font-medium disabled:opacity-50"
          >
            {settingsSaving ? (
              <div className="animate-spin rounded-full h-4 w-4 border-2 border-line/30 border-t-white" />
            ) : (
              <span>保存 API 配置</span>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

function AppearanceTab() {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)

  /**
   * 点击主题卡片：以点击坐标为水波圆心切换主题（View Transitions 圆形扩散 + 涟漪圆环）
   * 当前主题卡片不响应点击
   */
  const handlePick = (target) => (e) => {
    if (target === theme) return
    // flushSync：强制 React 在 View Transitions 回调内同步完成 DOM 更新，
    // 保证"新主题"截图包含 JS 侧语义色（themeTokens）的最新值
    rippleSwitchTheme(e.clientX, e.clientY, () => flushSync(() => setTheme(target)))
  }

  const cards = [
    { key: 'dark', label: '暗色模式' },
    { key: 'light', label: '亮色模式' }
  ]

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-ink/50 text-[10px] uppercase tracking-[0.2em] mb-3 font-sans">配色方案</h3>
        <div className="bg-veil/[0.03] border border-line/[0.06] rounded-xl p-5">
          <div className="flex gap-3">
            {cards.map(({ key, label }) => {
              const active = theme === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={handlePick(key)}
                  className={`glow-btn flex items-center gap-3 p-3 rounded-lg border transition-all text-left ${
                    active
                      ? 'bg-veil/[0.06] border-line/10 cursor-default'
                      : 'bg-veil/[0.02] border-line/[0.05] cursor-pointer hover:bg-veil/[0.06] hover:border-line/[0.12]'
                  }`}
                >
                  <div
                    className={`w-3.5 h-3.5 rounded-full border-2 ${
                      active ? 'border-cyan-400 bg-cyan-400' : 'border-line/20'
                    }`}
                  />
                  <div>
                    <div className={`text-sm ${active ? 'text-ink/80' : 'text-ink/50'}`}>{label}</div>
                    <div className={`text-[10px] ${active ? 'text-ink/30' : 'text-ink/20'}`}>
                      {active ? '当前' : '点击切换'}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function SettingsPanel() {
  const settingsOpen = useStore((s) => s.settingsOpen)
  const settingsLoading = useStore((s) => s.settingsLoading)
  const settingsError = useStore((s) => s.settingsError)
  const closeSettings = useStore((s) => s.closeSettings)
  const [activeTab, setActiveTab] = useState('api')
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)
  const panelRef = useRef(null)

  useEffect(() => {
    if (settingsOpen) {
      setVisible(true)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setExiting(false))
      })
    } else if (visible) {
      setExiting(true)
      const timer = setTimeout(() => setVisible(false), 300)
      return () => clearTimeout(timer)
    }
  }, [settingsOpen, visible])

  useEffect(() => {
    if (!visible) return
    const handleKey = (e) => {
      if (e.key === 'Escape') closeSettings()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [visible, closeSettings])

  if (!visible) return null

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center transition-all duration-300 ${
        exiting ? 'opacity-0' : 'opacity-100'
      }`}
    >
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-[rgb(var(--mask-rgb)_/_0.6)] backdrop-blur-sm"
        onClick={closeSettings}
      />

      {/* 浮窗主体 */}
      <div
        ref={panelRef}
        className={`relative w-full max-w-[700px] max-h-[85vh] mx-4 rounded-2xl border border-line/[0.08] flex overflow-hidden transition-all duration-300 ${
          exiting ? 'scale-95 opacity-0 translate-y-4' : 'scale-100 opacity-100 translate-y-0'
        }`}
        style={{
          background: 'rgb(var(--deep2-rgb) / 0.85)',
          backdropFilter: 'blur(40px)',
          WebkitBackdropFilter: 'blur(40px)',
          boxShadow: '0 0 100px rgb(var(--cyan-rgb) / 0.06), 0 25px 60px rgba(0,0,0,0.5)'
        }}
      >
        {/* 左侧分类导航 */}
        <div className="w-44 flex-shrink-0 border-r border-line/[0.06] flex flex-col">
          <div className="flex items-center gap-2 px-4 py-4 border-b border-line/[0.06]">
            <Settings size={16} className="text-ink/40" />
            <span className="text-xs font-medium text-ink/60 tracking-wider">设置</span>
          </div>
          <nav className="flex-1 py-2">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon
              const isActive = activeTab === cat.key
              return (
                <button
                  key={cat.key}
                  type="button"
                  onClick={() => setActiveTab(cat.key)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-all text-sm ${
                    isActive
                      ? 'text-ink/90 bg-veil/[0.06] border-r-2 border-cyan-400/50'
                      : 'text-ink/40 hover:text-ink/60 hover:bg-veil/[0.03]'
                  }`}
                >
                  <Icon size={14} />
                  <span>{cat.label}</span>
                </button>
              )
            })}
            <button
              type="button"
              onClick={() => setActiveTab('appearance')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-all text-sm ${
                activeTab === 'appearance'
                  ? 'text-ink/90 bg-veil/[0.06] border-r-2 border-cyan-400/50'
                  : 'text-ink/40 hover:text-ink/60 hover:bg-veil/[0.03]'
              }`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
              </svg>
              <span>外观设置</span>
            </button>
            {/* v12 快照管理：软删除的灵感（回收站），支持恢复/物理删除 */}
            <button
              type="button"
              onClick={() => setActiveTab('snapshot')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-all text-sm ${
                activeTab === 'snapshot'
                  ? 'text-ink/90 bg-veil/[0.06] border-r-2 border-cyan-400/50'
                  : 'text-ink/40 hover:text-ink/60 hover:bg-veil/[0.03]'
              }`}
            >
              <Archive size={14} />
              <span>快照管理</span>
            </button>
            {/* 关于 tab：使用指南 / GitHub / Issue / 版本号 */}
            <button
              type="button"
              onClick={() => setActiveTab('about')}
              className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-left transition-all text-sm ${
                activeTab === 'about'
                  ? 'text-ink/90 bg-veil/[0.06] border-r-2 border-cyan-400/50'
                  : 'text-ink/40 hover:text-ink/60 hover:bg-veil/[0.03]'
              }`}
            >
              <Info size={14} />
              <span>关于</span>
            </button>
          </nav>
        </div>

        {/* 右侧内容区 */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 顶部栏 */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-line/[0.06]">
            <h2 className="text-sm font-medium text-ink/80">
              {activeTab === 'api' ? 'API 设置' : activeTab === 'snapshot' ? '快照管理' : activeTab === 'about' ? '关于' : '外观设置'}
            </h2>
            <button
              type="button"
              onClick={closeSettings}
              className="modal-close-btn p-1.5 rounded-lg text-ink/30"
            >
              <X size={18} />
            </button>
          </div>

          {/* 内容 */}
          <div className="flex-1 overflow-y-auto px-6 py-5">
            {settingsLoading ? (
              <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-cyan-400/30 border-t-cyan-400" />
              </div>
            ) : settingsError ? (
              <div className="flex flex-col items-center justify-center h-64 gap-3">
                <p className="text-red-400/80 text-sm">加载失败：{settingsError}</p>
                <button
                  type="button"
                  onClick={closeSettings}
                  className="text-ink/40 text-xs hover:text-ink/60 transition-colors"
                >
                  关闭重试
                </button>
              </div>
            ) : activeTab === 'api' ? (
              <ApiSettingsTab />
            ) : activeTab === 'snapshot' ? (
              // v12 快照管理：软删除灵感列表（回收站）
              <SnapshotTab />
            ) : activeTab === 'about' ? (
              <AboutTab />
            ) : (
              <AppearanceTab />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// v12 快照管理区块
// 功能：展示软删除（回收站）的灵感快照，支持恢复与物理删除
// 实现方式：
//   - 挂载时 getSnapshots() 拉取快照列表（按删除时间倒序）
//   - 每张卡片显示标题、删除时间、剩余保留天数
//   - "恢复"：restoreSnapshot 清除软删标记 → 刷新侧边栏列表 + 快照列表
//   - "删除"：先进入确认态，二次点击才 purgeSnapshot（物理删除，不可恢复）
//   - 空状态：Archive 图标 + 引导文案
// ============================================================
function SnapshotTab() {
  const [snapshots, setSnapshots] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirmingId, setConfirmingId] = useState(null)

  // 加载快照列表
  const loadSnapshots = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.getSnapshots()
      setSnapshots(res.data || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSnapshots()
  }, [])

  // 恢复快照：清除软删标记 → 回到删除前文件夹 → 刷新侧边栏列表
  const handleRestore = async (id) => {
    try {
      await api.restoreSnapshot(id)
      // 恢复后同步刷新主界面灵感列表（侧边栏立即出现该灵感）
      await useStore.getState().loadInspirations()
      // 恢复后刷新文件夹计数（灵感回到原文件夹，数量 +1）
      useStore.getState().loadFolders()
      // 恢复后刷新"接着想"面板：软删除期间 saved_ai_replies 数据保留，
      // 恢复后后端 listSavedRepliesForFeed 会重新纳入该灵感的 saved replies
      useStore.getState().loadSavedReplies()
      loadSnapshots()
    } catch (err) {
      setError(err.message)
    }
  }

  // 物理删除快照：先确认再删除（二次点击），删除后刷新列表
  const handlePurge = async (id) => {
    if (confirmingId !== id) {
      setConfirmingId(id)
      return
    }
    try {
      await api.purgeSnapshot(id)
      setConfirmingId(null)
      // 物理删除后刷新"接着想"面板：后端 Inspiration.delete() 已级联清理 saved_ai_replies，
      // 前端需重新请求让面板即时移除被 purge 灵感的对话
      useStore.getState().loadSavedReplies()
      loadSnapshots()
    } catch (err) {
      setError(err.message)
    }
  }

  // 剩余保留天数：deleted_until - now，向上取整
  const remainingDays = (deletedUntil) => {
    const diff = new Date(deletedUntil).getTime() - Date.now()
    return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)))
  }

  // 删除时间格式化：YYYY-MM-DD HH:mm
  const formatTime = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    const pad = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-6 w-6 border-2 border-cyan-400/30 border-t-cyan-400" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-red-400/80 text-sm">加载失败：{error}</p>
        <button type="button" onClick={loadSnapshots} className="text-ink/40 text-xs hover:text-ink/60 transition-colors">
          重试
        </button>
      </div>
    )
  }

  if (snapshots.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-center px-6">
        <Archive size={32} className="text-ink/10" strokeWidth={1.5} />
        <p className="text-ink/30 text-sm">暂无快照</p>
        <p className="text-ink/20 text-xs leading-relaxed">
          删除的灵感会先进入快照区保留 30 天，期间可随时恢复
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2.5">
      {/* 顶部说明条 */}
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cyan-400/[0.05] border border-cyan-400/10">
        <Clock size={13} className="text-cyan-400/60 flex-shrink-0" />
        <p className="text-[11px] text-ink/40 leading-relaxed">
          快照默认保留 30 天，到期自动清除；恢复后灵感回到删除前的文件夹
        </p>
      </div>

      {/* 快照列表卡片 */}
      {snapshots.map((snap) => {
        const days = remainingDays(snap.deleted_until)
        const isConfirming = confirmingId === snap.id
        return (
          <div
            key={snap.id}
            className="flex items-center gap-3 px-4 py-3 rounded-xl border border-line/[0.08] bg-veil/[0.04] transition-all"
          >
            {/* 标题与元信息 */}
            <div className="flex-1 min-w-0">
              <p className="text-sm text-ink/80 truncate">{snap.title || '（无标题）'}</p>
              <p className="text-[11px] text-ink/30 mt-0.5">
                删除于 {formatTime(snap.deleted_at)} · 剩余 {days} 天
              </p>
            </div>

            {/* 操作区：恢复 / 物理删除（二次确认） */}
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <button
                type="button"
                onClick={() => handleRestore(snap.id)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-cyan-400/80 hover:text-cyan-300 hover:bg-cyan-400/10 transition-all"
              >
                <RotateCcw size={13} />
                恢复
              </button>
              <button
                type="button"
                onClick={() => handlePurge(snap.id)}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs transition-all ${
                  isConfirming
                    ? 'text-white bg-red-500/80 hover:bg-red-500'
                    : 'text-red-400/60 hover:text-red-400 hover:bg-red-500/10'
                }`}
              >
                <Trash2 size={13} />
                {isConfirming ? '确认删除' : '删除'}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ============================================================
// 关于 tab：使用指南 / GitHub / Issue / 版本号
// 功能：提供应用信息与外部链接入口，点击通过 openExternalLink 打开
// ============================================================
function AboutTab() {
  // 版本号由 Vite define 注入（读取根 package.json 的 version 字段）
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0'

  // 链接列表：使用指南 PDF、GitHub 仓库、Issue 反馈
  const links = [
    { icon: BookOpen, label: '使用指南', desc: '点击打开 PDF 使用文档', url: './How2Use.pdf' },
    { icon: Github, label: 'GitHub 仓库', desc: '查看源码、提 Issue、Star', url: 'https://github.com/AIRA-81920/AIRA-s-Diary' },
    { icon: Bug, label: '提交 Issue', desc: '反馈 Bug 或建议功能', url: 'https://github.com/AIRA-81920/AIRA-s-Diary/issues' },
  ]

  return (
    <div className="space-y-2">
      {links.map((item) => (
        <button
          key={item.url}
          type="button"
          onClick={() => openExternalLink(item.url)}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-line/[0.06] hover:border-cyan-400/30 hover:bg-veil/[0.04] transition-all text-left group"
        >
          <item.icon size={18} className="text-ink/40 group-hover:text-cyan-400/70 transition-colors shrink-0" />
          <div className="min-w-0">
            <p className="text-sm text-ink/70 group-hover:text-ink/90 transition-colors">{item.label}</p>
            <p className="text-xs text-ink/25 mt-0.5">{item.desc}</p>
          </div>
        </button>
      ))}
      {/* 版本号 */}
      <div className="flex items-center justify-center px-4 py-6 mt-4">
        <span className="text-ink/20 text-xs font-sans">AIRA's Diary  v{version}</span>
      </div>
    </div>
  )
}
