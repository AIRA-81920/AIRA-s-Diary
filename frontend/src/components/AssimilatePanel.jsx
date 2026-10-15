// AssimilatePanel 消化面板（C 方案 · 深空智识美学）
// 功能：把追加/词块/对话产物消化回 crystal 核心定义——AI 分析分量，用户审阅确认
// 实现方式：
//   - 状态机：idle（入口）→ analyzing（AI 分析中）→ review（审阅提议）→ done（完成）
//   - 直接调用 api.js 消化三端点，不经 store（面板自管理局部状态）
//   - review 阶段分两类：改写性（旧值→新值 diff，逐条确认/拒绝）和材料性（挂到 evidence，可勾选）
//   - 用户逐条确认后调 confirmAssimilation 落盘新版本 crystal + 标记已消化
import React, { useState, useEffect } from 'react'
import { Loader2, GitCompare, FileText, Check, X, ArrowLeft, Sparkles, AlertCircle } from 'lucide-react'
import { getAssimilateStatus, analyzeAssimilation, confirmAssimilation } from '../services/api.js'

// crystal 字段中文标签（与 CrystallizePanel CRYSTAL_FIELD_META 对齐）
const FIELD_LABELS = {
  title: '标题', definition: '定义', distinction: '区分', origin: '起源',
  signature_features: '核心特征', applicable_context: '适用场景',
  evolution: '演进方向', goal: '目标', target_user: '目标用户',
  core_features: '核心功能', success_criteria: '成功标准',
  setting: '场景设置', sensory_detail: '感官细节', mood: '情绪基调',
  protagonist: '主角存在', moment: '关键瞬间',
  premise: '核心前提', rules: '运行规则', constraints: '约束边界',
  inhabitants: '居民形态', tension: '内在张力',
  emotion: '情感内核', imagery: '核心意象', rhythm: '节奏韵律',
  theme: '主题表达', counterpoint: '反差点',
}

function AssimilatePanel({ inspirationId, onClose }) {
  // 状态机：idle → analyzing → review → done
  const [stage, setStage] = useState('idle')
  // 待消化数量
  const [status, setStatus] = useState(null)
  // AI 分析结果
  const [proposal, setProposal] = useState(null)
  // 用户接受/拒绝的选择（索引列表）
  const [acceptedRevisions, setAcceptedRevisions] = useState([])
  const [acceptedMaterials, setAcceptedMaterials] = useState([])
  // 错误信息
  const [error, setError] = useState(null)

  // 首次加载：查询待消化数量
  useEffect(() => {
    if (stage === 'idle') {
      getAssimilateStatus(inspirationId).then(res => {
        if (res.success) setStatus(res.data)
      }).catch(() => {})
    }
  }, [inspirationId, stage])

  // 触发 AI 分析
  const handleAnalyze = async () => {
    setStage('analyzing')
    setError(null)
    try {
      const res = await analyzeAssimilation(inspirationId)
      if (res.success) {
        setProposal(res.data)
        setAcceptedRevisions([])
        setAcceptedMaterials([])
        setStage('review')
      } else {
        setError(res.error || '分析失败')
        setStage('idle')
      }
    } catch (e) {
      setError(e.message || '分析失败，请重试')
      setStage('idle')
    }
  }

  // 切换改写接受/拒绝
  const toggleRevision = (idx) => {
    setAcceptedRevisions(prev =>
      prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
    )
  }

  // 切换材料接受/拒绝
  const toggleMaterial = (idx) => {
    setAcceptedMaterials(prev =>
      prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]
    )
  }

  // 确认提交
  const handleConfirm = async () => {
    setStage('confirming')
    setError(null)
    try {
      const res = await confirmAssimilation(inspirationId, proposal, acceptedRevisions, acceptedMaterials)
      if (res.success) {
        setStage('done')
      } else {
        setError(res.error || '确认失败')
        setStage('review')
      }
    } catch (e) {
      setError(e.message || '确认失败，请重试')
      setStage('review')
    }
  }

  // ===== idle 阶段：入口 =====
  if (stage === 'idle') {
    // 无待消化内容时不占位（整个面板不渲染，追加区下方不留痕迹）
    // status 为 null（加载中）时同样不渲染，避免闪现
    if (!status || status.total === 0) {
      // 仅在有错误时显示一行轻量提示（如分析失败）
      if (error) {
        return (
          <div className="px-6 py-2">
            <p className="text-red-400/60 text-xs font-sans">{error}</p>
          </div>
        )
      }
      return null
    }
    return (
      <div className="animate-fade-in-up px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="h-px w-8 bg-veil/10" />
            <span className="text-ink/30 text-[11px] uppercase tracking-widest font-sans">消化</span>
          </div>
          <p className="text-ink/40 text-xs font-sans flex-1">
            <span className="text-ink/70 font-semibold">{status.total}</span> 条新内容待消化
            <span className="text-ink/25 ml-2">追加 {status.addenda} · 词块 {status.chunks} · 对话 {status.replies}</span>
          </p>
          <button
            type="button"
            onClick={handleAnalyze}
            className="glow-btn glass-card flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ink/70 hover:text-ink text-xs font-medium transition-all flex-shrink-0"
            data-glow="cyan"
          >
            <Sparkles size={13} style={{ color: 'var(--accent-cyan)' }} />
            <span>开始消化</span>
          </button>
        </div>
        {error && (
          <p className="text-red-400/60 text-xs font-sans mt-2">{error}</p>
        )}
      </div>
    )
  }

  // ===== analyzing 阶段：加载中 =====
  if (stage === 'analyzing' || stage === 'confirming') {
    const text = stage === 'analyzing' ? 'AI 正在审视新内容，判断哪些足以改写定义...' : '正在写入新版本...'
    return (
      <div className="animate-fade-in-up p-6">
        <div className="flex items-center gap-2 mb-6">
          <div className="h-px w-8 bg-veil/10" />
          <span className="text-ink/30 text-[11px] uppercase tracking-widest font-sans">消化</span>
        </div>
        <div className="text-center py-16">
          <Loader2 size={28} className="animate-spin mx-auto text-ink/30 mb-4" />
          <p className="text-ink/40 text-sm font-sans">{text}</p>
        </div>
      </div>
    )
  }

  // ===== review 阶段：审阅提议 =====
  if (stage === 'review' && proposal) {
    const { revisions = [], materials = [] } = proposal
    return (
      <div className="animate-fade-in-up p-6 max-h-[70vh] overflow-y-auto">
        {/* 标题 */}
        <div className="flex items-center gap-2 mb-6">
          <div className="h-px w-8 bg-veil/10" />
          <span className="text-ink/30 text-[11px] uppercase tracking-widest font-sans">消化 · 审阅提议</span>
        </div>

        {revisions.length === 0 && materials.length === 0 && (
          <div className="text-center py-12">
            <Check size={28} className="mx-auto text-ink/15 mb-3" />
            <p className="text-ink/30 text-sm font-sans">
              AI 认为当前新内容无需改写定义，也没有值得挂载的材料
            </p>
            <button
              type="button"
              onClick={handleConfirm}
              className="glow-btn glass-card flex items-center gap-2 px-4 py-2 rounded-lg text-ink/60 hover:text-ink text-xs font-medium transition-all mt-6 mx-auto"
            >
              <Check size={13} />
              <span>标记已消化</span>
            </button>
          </div>
        )}

        {/* 改写提议列表 */}
        {revisions.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-1.5 mb-3">
              <GitCompare size={14} style={{ color: 'var(--accent-amber)' }} />
              <span className="text-ink/50 text-xs font-sans">改写提议（{revisions.length} 条）</span>
            </div>
            <div className="space-y-3">
              {revisions.map((rev, idx) => (
                <div
                  key={idx}
                  className={`glass-card rounded-xl p-4 transition-all cursor-pointer ${
                    acceptedRevisions.includes(idx) ? 'ring-1 ring-amber-400/30' : ''
                  }`}
                  style={{ border: '1px solid rgb(var(--ink) / 0.06)' }}
                  onClick={() => toggleRevision(idx)}
                >
                  {/* 字段名 + 接受标记 */}
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-ink/60 text-xs font-sans">
                      {FIELD_LABELS[rev.field] || rev.field}
                    </span>
                    <div className={`w-5 h-5 rounded flex items-center justify-center transition-all ${
                      acceptedRevisions.includes(idx) ? 'bg-amber-400/20' : 'bg-veil/5'
                    }`}>
                      {acceptedRevisions.includes(idx) && <Check size={12} style={{ color: 'var(--accent-amber)' }} />}
                    </div>
                  </div>
                  {/* 旧值 → 新值 */}
                  <div className="space-y-2 text-xs font-sans leading-[1.7]">
                    <div className="text-ink/40 line-through decoration-ink/20">
                      {rev.old_summary || '（旧值）'}
                    </div>
                    <div className="text-ink/80 whitespace-pre-wrap">
                      {typeof rev.new_value === 'string' ? rev.new_value : JSON.stringify(rev.new_value, null, 2)}
                    </div>
                  </div>
                  {/* 理由 */}
                  {rev.reason && (
                    <p className="text-ink/30 text-[11px] font-sans mt-2 pt-2 border-t border-line/5">
                      {rev.reason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 材料挂载提议 */}
        {materials.length > 0 && (
          <div className="mb-6">
            <div className="flex items-center gap-1.5 mb-3">
              <FileText size={14} style={{ color: 'var(--accent-cyan)' }} />
              <span className="text-ink/50 text-xs font-sans">材料挂载（{materials.length} 条）</span>
            </div>
            <div className="space-y-2">
              {materials.map((mat, idx) => (
                <div
                  key={idx}
                  className={`glass-card rounded-lg p-3 transition-all cursor-pointer ${
                    acceptedMaterials.includes(idx) ? 'ring-1 ring-cyan-400/20' : ''
                  }`}
                  style={{ border: '1px solid rgb(var(--ink) / 0.04)' }}
                  onClick={() => toggleMaterial(idx)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <p className="text-ink/60 text-xs font-sans">{mat.content}</p>
                      {mat.note && (
                        <p className="text-ink/25 text-[11px] font-sans mt-1">
                          → 挂到 {FIELD_LABELS[mat.target_field] || mat.target_field} · {mat.note}
                        </p>
                      )}
                    </div>
                    <div className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 transition-all ${
                      acceptedMaterials.includes(idx) ? 'bg-cyan-400/20' : 'bg-veil/5'
                    }`}>
                      {acceptedMaterials.includes(idx) && <Check size={10} style={{ color: 'var(--accent-cyan)' }} />}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 底部操作栏 */}
        {revisions.length > 0 || materials.length > 0 ? (
          <div className="flex items-center gap-3 pt-4 border-t border-line/5">
            <button
              type="button"
              onClick={() => setStage('idle')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ink/40 hover:text-ink/60 text-xs font-sans transition-all"
            >
              <ArrowLeft size={13} />
              <span>返回</span>
            </button>
            <div className="flex-1" />
            <span className="text-ink/30 text-xs font-sans">
              接受 {acceptedRevisions.length} 改写 · {acceptedMaterials.length} 材料
            </span>
            <button
              type="button"
              onClick={handleConfirm}
              className="glow-btn glass-card flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-ink/80 hover:text-ink text-xs font-medium transition-all"
              data-glow="amber"
            >
              <Check size={13} />
              <span>确认消化</span>
            </button>
          </div>
        ) : null}

        {error && (
          <p className="text-red-400/60 text-xs font-sans mt-4 text-center">{error}</p>
        )}
      </div>
    )
  }

  // ===== done 阶段：完成 =====
  if (stage === 'done') {
    return (
      <div className="animate-fade-in-up p-6">
        <div className="text-center py-12">
          <Check size={32} className="mx-auto text-ink/15 mb-3" style={{ color: 'var(--accent-cyan)' }} />
          <p className="text-ink/60 text-sm font-sans mb-2">消化完成</p>
          <p className="text-ink/30 text-xs font-sans mb-6">
            新内容已合并进核心定义，旧版本保留在历史中
          </p>
          <button
            type="button"
            onClick={() => { setStage('idle'); setProposal(null) }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-ink/40 hover:text-ink/60 text-xs font-sans transition-all mx-auto"
          >
            <ArrowLeft size={13} />
            <span>返回</span>
          </button>
        </div>
      </div>
    )
  }

  return null
}

export default AssimilatePanel
