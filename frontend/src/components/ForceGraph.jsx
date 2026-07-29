// ForceGraph 力导向图全屏覆盖层（K3-f 新建，架构文档 §5.4 Layer 2 + §9.3 GraphResponse）
// 功能：d3-force 渲染全局灵感网络，节点=灵感，边=桥梁
// 实现方式：
//   - 全屏覆盖层（fixed inset-0，z-index 最高），打开时 Layer 1 冻结不卸载
//   - d3-force 力模拟（forceManyBody/forceLink/forceCenter/forceCollide）
//   - d3-zoom 缩放/平移，视图状态保存到 store（重开恢复视角）
//   - d3-drag 节点拖拽
//   - 节点半径 = bridgeCount 映射（min 6 / max 18）
//   - 边颜色 = bridgeType（5 色），粗细 = vectorScore，透明度 = llmScore
//   - 点击节点 → 关闭覆盖层并跳转该灵感 Detail
//   - 节点上限 500（R5），超出截断 + 计数提示
//
// 架构文档 ADR-7：废弃同心圆 SVG 布局，采用 d3-force 表达"自然聚簇 → 看见母题"
import React, { useRef, useEffect, useState } from 'react'
import * as d3Force from 'd3-force'
import { select } from 'd3-selection'
import { zoom, zoomIdentity } from 'd3-zoom'
import { drag } from 'd3-drag'
import { X, Loader2, AlertCircle, Network, Sparkles } from 'lucide-react'
import useStore from '../services/store.js'
import { getBridgeColors, getBridgeColor, getGraphTheme } from '../services/themeTokens.js'

/**
 * 桥梁类型 → 颜色映射（渲染期按当前主题取值，单一来源 themeTokens.js）
 */
const BRIDGE_COLORS = new Proxy({}, {
  get: (_, key) => getBridgeColors()[key],
  ownKeys: () => Reflect.ownKeys(getBridgeColors()),
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
})

/**
 * 桥梁类型中文标签
 */
const BRIDGE_LABELS = {
  imagery_isomorphism:  '意象同构',
  structure_resonance:  '结构共振',
  emotion_echo:         '情感回响',
  technique_transfer:   '技法迁移',
  theme_opposition:     '主题对立'
}

/**
 * 节点半径映射函数
 * 功能：根据 bridgeCount 映射节点半径（min 6 / max 18）
 * @param {number} bridgeCount
 * @returns {number} 半径 px
 */
function nodeRadius(bridgeCount, hovered) {
  const count = bridgeCount || 0
  // 孤立节点 8px，有桥节点 10px，鼠标悬停时额外 +2px
  const base = count > 0 ? 10 : 8
  return base + (hovered ? 2 : 0)
}

/**
 * ForceGraph 主组件
 * 功能：全屏力导向图覆盖层
 * 实现方式：
 *   - 从 store 读取 forceGraphOpen/data/loading/error/viewport
 *   - 用 useRef 持有 SVG 容器和 simulation 实例
 *   - useEffect 在 data 变化时重建 simulation
 *   - d3-zoom 监听视图变化保存到 store
 */
/**
 * 按主题刷新 SVG 已渲染元素的颜色（不销毁重建图）
 * 功能：主题切换时直接 selectAll 更新边/节点/图例的 d3 attr
 * @param {object} svg - d3 selection（svg 根）
 * @param {Array} edges - 边数据（节点染色需查边类型）
 * @param {object} gt - getGraphTheme() 返回的当前主题色表
 */
function applyGraphColors(svg, edges, gt) {
  if (!svg) return
  // 边：bridgeType 主色（按主题取值）
  svg.selectAll('g.links line')
    .attr('stroke', d => getBridgeColor(d.bridgeType))
  // 节点：有桥节点用边类型主色，无桥节点用主题灰
  svg.selectAll('g.node-group circle')
    .attr('fill', d => {
      const nodeEdges = edges.filter(e => e.source === d.id || e.target === d.id || e.source?.id === d.id || e.target?.id === d.id)
      if (nodeEdges.length > 0) {
        return BRIDGE_COLORS[nodeEdges[0].bridgeType] || gt.nodeAccent
      }
      return gt.nodeFill
    })
    .attr('stroke', d => d.hasBridges === false ? gt.nodeStrokeIsolated : gt.nodeStroke)
  // 图例：线条主色 + 文字色
  svg.selectAll('g.legend-layer line')
    .attr('stroke', d => getBridgeColor(d))
  svg.selectAll('g.legend-layer text')
    .attr('fill', gt.labelFill)
}

function ForceGraph() {
  // 从 store 读取状态与 actions
  const open = useStore((s) => s.forceGraphOpen)
  const data = useStore((s) => s.forceGraphData)
  const loading = useStore((s) => s.forceGraphLoading)
  const error = useStore((s) => s.forceGraphError)
  const viewport = useStore((s) => s.forceGraphViewport)
  const truncated = useStore((s) => s.forceGraphTruncated)
  const closeForceGraph = useStore((s) => s.closeForceGraph)
  const setForceGraphViewport = useStore((s) => s.setForceGraphViewport)
  const clickForceGraphNode = useStore((s) => s.clickForceGraphNode)
  // 当前主题（dark/light）：d3 SVG attr 无法走 CSS 变量，主题切换时需手动刷新
  const theme = useStore((s) => s.theme)

  // SVG 容器 ref
  const svgRef = useRef(null)
  // simulation 实例 ref（避免重建）
  const simulationRef = useRef(null)
  // zoom 行为 ref
  const zoomRef = useRef(null)
  // 内部节点/边数据 ref（带 x/y 坐标）
  const nodesRef = useRef([])
  const edgesRef = useRef([])
  // 当前图谱主题色表 ref（hover 处理器内读取，避免闭包过期）
  const graphThemeRef = useRef(getGraphTheme())
  // hover 状态
  const [hoveredNode, setHoveredNode] = useState(null)

  // viewport ref：避免 viewport 变化触发 useEffect 重跑（会导致 zoom → setState → effect 重跑 → 恢复 transform → 再触发 zoom 的无限循环）
  // 功能：缓存最新 viewport 供 effect 内部读取，不作为 useEffect 依赖
  const viewportRef = useRef(viewport)
  useEffect(() => {
    viewportRef.current = viewport
  }, [viewport])

  /**
   * useEffect：data 变化时重建 simulation
   * 功能：初始化 d3-force 力模拟 + 渲染 SVG 节点/边
   * 注意：必须在 early return 之前声明，Hooks 顺序规则（React §Rules of Hooks）
   */
  useEffect(() => {
    // 覆盖层未打开时不执行（避免无效初始化）
    if (!open || !data || !svgRef.current) return

    const svg = select(svgRef.current)
    const width = svgRef.current.clientWidth
    const height = svgRef.current.clientHeight
    // 当前主题的 d3 色表（SVG attr 不支持 CSS 变量，必须直写色值）
    const gt = getGraphTheme()
    graphThemeRef.current = gt

    // 准备节点/边数据（深拷贝避免污染 store）
    const nodes = (data.nodes || []).map(n => ({ ...n }))
    const edges = (data.edges || []).map(e => ({ ...e }))
    nodesRef.current = nodes
    edgesRef.current = edges

    // 清空旧内容（保留 g.zoom-layer）
    svg.selectAll('g.zoom-layer').remove()
    svg.selectAll('g.legend-layer').remove()

    // 创建 zoom-layer（所有内容挂在这层，便于缩放/平移）
    const g = svg.append('g').attr('class', 'zoom-layer')

    // 创建边组（在节点之下）
    const link = g.append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(edges)
      .enter()
      .append('line')
      .attr('stroke', d => getBridgeColor(d.bridgeType))
      .attr('stroke-width', d => 1 + (d.vectorScore || 0) * 4)  // 粗细 = vectorScore
      .attr('stroke-opacity', d => 0.2 + (d.llmScore || 0) * 0.7)  // 透明度 = llmScore
      .attr('stroke-linecap', 'round')

    // 创建节点组
    const node = g.append('g')
      .attr('class', 'nodes')
      .selectAll('circle')
      .data(nodes)
      .enter()
      .append('g')
      .attr('class', 'node-group')
      .style('cursor', 'pointer')

    // 节点圆形：孤立节点（有 hasBridges=false 且 bridgeCount=0）用虚线灰色描边区分
    node.append('circle')
      .attr('r', d => nodeRadius(d.bridgeCount))
      .attr('fill', d => {
        // 有桥梁的节点用 bridgeType 主色染色（取第一条边的类型）
        const nodeEdges = edges.filter(e => e.source === d.id || e.target === d.id || e.source?.id === d.id || e.target?.id === d.id)
        if (nodeEdges.length > 0) {
          return BRIDGE_COLORS[nodeEdges[0].bridgeType] || gt.nodeAccent
        }
        return gt.nodeFill  // 无桥梁：更柔和的灰色填充
      })
      .attr('stroke', d => d.hasBridges === false ? gt.nodeStrokeIsolated : gt.nodeStroke)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', d => d.hasBridges === false ? '3 3' : null)  // 孤立节点：虚线描边

    // 节点标题（hover 时显示，用 SVG title 元素）
    node.append('title').text(d => {
      const bridgeText = d.hasBridges ? `${d.bridgeCount || 0} 桥梁` : '暂无桥梁'
      return `${d.title || '未命名'}（${bridgeText}）`
    })

    /**
     * 节点点击事件：关闭覆盖层并跳转该灵感 Detail
     */
    node.on('click', (event, d) => {
      event.stopPropagation()
      clickForceGraphNode(d.id)
    })

    /**
     * 节点 hover 事件：高亮 + 显示标题
     */
    node.on('mouseenter', (event, d) => {
      setHoveredNode(d)
      select(event.currentTarget).select('circle')
        .transition().duration(200)
        .attr('r', nodeRadius(d.bridgeCount, true))
        .attr('stroke', graphThemeRef.current.nodeHover)
        .attr('stroke-width', 2.5)
    })
    .on('mouseleave', (event, d) => {
      setHoveredNode(null)
      select(event.currentTarget).select('circle')
        .transition().duration(200)
        .attr('r', nodeRadius(d.bridgeCount, false))
        .attr('stroke', graphThemeRef.current.nodeStroke)
        .attr('stroke-width', 1.5)
    })

    /**
     * d3-drag 节点拖拽行为
     */
    const dragBehavior = drag()
      .on('start', (event, d) => {
        if (!event.active) simulationRef.current.alphaTarget(0.3).restart()
        d.fx = d.x
        d.fy = d.y
      })
      .on('drag', (event, d) => {
        d.fx = event.x
        d.fy = event.y
      })
      .on('end', (event, d) => {
        if (!event.active) simulationRef.current.alphaTarget(0)
        d.fx = null
        d.fy = null
      })
    node.call(dragBehavior)

    /**
     * d3-force 力模拟
     * - forceManyBody：排斥力（-80，节点间互斥）
     * - forceLink：边吸引力（距离 80，强度按 vectorScore）
     * - forceCenter：中心引力
     * - forceCollide：碰撞检测（避免节点重叠）
     * - forceX/forceY：弱 X/Y 引力（防止节点飞出视口）
     */
    const simulation = d3Force.forceSimulation(nodes)
      .force('link', d3Force.forceLink(edges).id(d => d.id).distance(70).strength(d => 0.3 + (d.vectorScore || 0) * 0.5))
      .force('charge', d3Force.forceManyBody().strength(-200))
      .force('center', d3Force.forceCenter(width / 2, height / 2))
      .force('collide', d3Force.forceCollide().radius(d => nodeRadius(d.bridgeCount) + 4))
      .force('x', d3Force.forceX(width / 2).strength(0.03))
      .force('y', d3Force.forceY(height / 2).strength(0.03))
      .alpha(1)
      .alphaDecay(0.025)  // 迭代次数封顶（R5 防 CPU 占用）
    simulationRef.current = simulation

    /**
     * tick 回调：每帧更新节点/边位置
     */
    simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y)
      node.attr('transform', d => `translate(${d.x},${d.y})`)
    })

    /**
     * d3-zoom 缩放/平移行为
     * 功能：滚轮缩放 + 拖拽平移 + 视图状态保存
     */
    const zoomBehavior = zoom()
      .scaleExtent([0.2, 4])  // 缩放范围 0.2x ~ 4x
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
        setForceGraphViewport({ x: event.transform.x, y: event.transform.y, k: event.transform.k })
      })
    zoomRef.current = zoomBehavior
    svg.call(zoomBehavior)

    // 恢复上次保存的 viewport（§5.4 规则：重开恢复视角）
    // 从 viewportRef 读取，不作为 useEffect 依赖（否则会无限循环）
    const savedViewport = viewportRef.current
    if (savedViewport) {
      svg.call(zoomBehavior.transform, zoomIdentity.translate(savedViewport.x, savedViewport.y).scale(savedViewport.k))
    }

    /**
     * 图例（右上角）：5 种 bridgeType 颜色说明
     * line 绑定 bridgeType datum，主题切换时 applyGraphColors 可直接刷新颜色
     */
    const legend = svg.append('g').attr('class', 'legend-layer')
      .attr('transform', `translate(${width - 160}, 20)`)
    const legendItems = Object.keys(getBridgeColors())
    legendItems.forEach((type, idx) => {
      const legendRow = legend.append('g').attr('transform', `translate(0, ${idx * 20})`)
      legendRow.append('line')
        .datum(type)
        .attr('x1', 0).attr('y1', 6).attr('x2', 20).attr('y2', 6)
        .attr('stroke', getBridgeColor(type)).attr('stroke-width', 3).attr('stroke-linecap', 'round')
      legendRow.append('text')
        .attr('x', 26).attr('y', 9).attr('fill', gt.labelFill)
        .attr('font-size', '11px').attr('font-family', 'sans-serif')
        .text(BRIDGE_LABELS[type] || type)
    })

    // 清理函数：组件卸载或 data 变化时停止 simulation
    return () => {
      if (simulationRef.current) {
        simulationRef.current.stop()
        simulationRef.current = null
      }
    }
  }, [data, open, setForceGraphViewport, clickForceGraphNode])

  /**
   * useEffect：主题切换时刷新 SVG 颜色（不销毁重建图）
   * 功能：直接 selectAll 更新边/节点/图例的 d3 attr；React 层照常走 CSS 变量
   */
  useEffect(() => {
    const gt = getGraphTheme()
    graphThemeRef.current = gt
    if (!open || !svgRef.current) return
    applyGraphColors(select(svgRef.current), edgesRef.current, gt)
  }, [theme, open])

  // 覆盖层未打开：不渲染（必须在所有 Hooks 之后）
  if (!open) return null

  return (
    // 全屏覆盖层：fixed inset-0，z-index 最高（Layer 2）
    <div
      className="fixed inset-0 z-50 flex flex-col"
      style={{
        background: 'rgb(var(--deep-rgb) / 0.95)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)'
      }}
    >
      {/* 顶部工具栏：标题 + 节点/边统计 + 关闭按钮 */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-line/5">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div
              className="absolute inset-0 rounded-full blur-md animate-pulse-soft"
              style={{ background: 'rgba(168,85,247,0.3)' }}
            />
            <Network size={22} className="relative" style={{ color: '#a855f7' }} />
          </div>
          <div className="flex flex-col">
            <h2
              className="font-display text-lg font-semibold text-ink/90 leading-none"
              style={{ letterSpacing: '-0.01em' }}
            >
              灵感网络
            </h2>
            <p className="text-ink/35 text-[10px] mt-1 font-sans">
              {data ? `${data.nodes?.length || 0} 节点 · ${data.edges?.length || 0} 桥梁` : '加载中...'}
            </p>
          </div>
        </div>

        {/* 截断提示（R5） */}
        {truncated && (
          <div className="flex items-center gap-1.5 text-xs text-amber-400/80 px-3 py-1.5 rounded-md bg-amber-500/5 border border-amber-500/20">
            <AlertCircle size={11} />
            <span>节点超过 500，已截断显示 bridgeCount 最高的 500 个</span>
          </div>
        )}

        <button
          type="button"
          onClick={closeForceGraph}
          className="modal-close-btn p-2 rounded-md text-ink/40"
          title="关闭灵感网络"
        >
          <X size={18} />
        </button>
      </div>

      {/* 主区域：SVG 力导向图 */}
      <div className="flex-1 relative">
        {/* 加载态 */}
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
            <Loader2 size={32} className="animate-spin mb-3" style={{ color: '#a855f7' }} />
            <p className="text-ink/40 text-sm font-sans">正在构建灵感网络...</p>
          </div>
        )}

        {/* 错误态 */}
        {error && !loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8">
            <AlertCircle size={32} className="mb-3 text-rose-400/60" />
            <p className="text-rose-300/80 text-sm font-sans mb-2">加载图谱失败</p>
            <p className="text-ink/40 text-xs font-sans mb-4">{error}</p>
            <button
              type="button"
              onClick={() => useStore.getState().openForceGraph()}
              className="glass-card flex items-center gap-1.5 px-3 py-2 rounded-lg text-ink/70 hover:text-ink/90 text-xs transition-colors"
            >
              <Sparkles size={12} />
              <span>重试</span>
            </button>
          </div>
        )}

        {/* 空态：无节点 */}
        {!loading && !error && data && data.nodes?.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8">
            <Network size={48} className="mb-4 text-ink/15" strokeWidth={1} />
            <h3 className="font-display text-lg text-ink/60 mb-2">灵感网络尚未形成</h3>
            <p className="text-ink/35 text-xs font-sans max-w-md leading-relaxed">
              灵感网络由跨界桥梁连接而成。请在灵感详情的"聚合"阶段点击"扫描桥梁"，发现灵感之间的深层连接后，网络将自然浮现。
            </p>
          </div>
        )}

        {/* SVG 容器（力导向图渲染区） */}
        {!loading && !error && data && data.nodes?.length > 0 && (
          <svg
            ref={svgRef}
            className="w-full h-full"
            style={{ cursor: 'grab' }}
          />
        )}

        {/* hover 节点信息浮层（右下角） */}
        {hoveredNode && (
          <div
            className="absolute bottom-6 right-6 px-4 py-3 rounded-xl glass-card animate-fade-in-up max-w-xs"
            style={{ background: 'rgb(var(--deep-rgb) / 0.85)' }}
          >
            <p className="text-ink/40 text-[10px] uppercase tracking-wider mb-1 font-sans">灵感</p>
            <p className="font-display text-ink/90 text-sm font-semibold mb-1 leading-tight">
              {hoveredNode.title || '未命名'}
            </p>
            <div className="flex items-center gap-3 text-[11px] font-sans">
              <span className="text-ink/50">{hoveredNode.bridgeCount || 0} 桥梁</span>
              {hoveredNode.inspirationType && (
                <span style={{ color: 'var(--accent-cyan-bright)' }}>{hoveredNode.inspirationType}</span>
              )}
            </div>
            <p className="text-ink/30 text-[10px] mt-2 font-sans italic">点击跳转到该灵感</p>
          </div>
        )}
      </div>

      {/* 底部提示栏 */}
      <div className="px-6 py-3 border-t border-line/5 flex items-center justify-between text-[11px] text-ink/35 font-sans">
        <div className="flex items-center gap-4">
          <span>拖拽节点 · 滚轮缩放 · 拖拽空白处平移</span>
        </div>
        <div className="flex items-center gap-4">
          <span>节点大小 = 桥梁数量</span>
          <span>边粗细 = 向量分</span>
          <span>边透明度 = LLM 分</span>
        </div>
      </div>
    </div>
  )
}

export default ForceGraph
