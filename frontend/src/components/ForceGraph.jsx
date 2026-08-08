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
import React, { useRef, useEffect, useState, useMemo } from 'react'
import * as d3Force from 'd3-force'
import { select } from 'd3-selection'
import { zoom, zoomIdentity } from 'd3-zoom'
import { drag } from 'd3-drag'
import { X, Loader2, AlertCircle, Network, Sparkles } from 'lucide-react'
import useStore from '../services/store.js'
// UI 精修：节点按灵感类型着色（与桥梁色分离），色板单一来源 themeTokens
import { getBridgeColors, getBridgeColor, getGraphTheme, getInspirationTypeColor, INSPIRATION_TYPE_COLORS } from '../services/themeTokens.js'

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
// 桥梁类型中文标签（2026-08 精简为 3 种；历史遗留类型无 label 时显示原始 key）
const BRIDGE_LABELS = {
  imagery_isomorphism:  '意象同构',
  structure_resonance:  '结构共振',
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
  // 边：bridgeType 主色（按主题取值）；同步刷新 stroke-dasharray，
  // 否则主题切换时 selectAll 重设 stroke 会让 pending 虚线样式丢失
  svg.selectAll('g.links line')
    .attr('stroke', d => getBridgeColor(d.bridgeType))
    .attr('stroke-dasharray', d => d.status === 'pending' ? '5 3' : null)
  // 节点：UI 精修——fill = 灵感类型色（与边/桥梁色彻底分离），未知类型兜底主题灰
  svg.selectAll('g.node-group circle')
    .attr('fill', d => getInspirationTypeColor(d.inspirationType) || gt.nodeFill)
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
  const forceGraphScanning = useStore((s) => s.forceGraphScanning)
  const scanAllBridges = useStore((s) => s.scanAllBridges)
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
  // 边 hover 状态：存储 { edge, x, y }（edge 数据 + 鼠标视口坐标），null 表示无 hover
  const [hoveredEdge, setHoveredEdge] = useState(null)
  // 边锁定选中状态：click 边后固化浮窗在当前边的中点，鼠标移开也不消失
  // 存储 { edge, x, y }（x/y 为边中点的视口坐标），null 表示未锁定
  const [lockedEdge, setLockedEdge] = useState(null)
  // 当前缩放/平移 transform（tick 内转为边中点屏幕坐标用，zoom handler 里更新）
  const graphTransformRef = useRef({ x: 0, y: 0, k: 1 })
  // 每条边中点在 SVG 坐标系的缓存 { edgeId: { dx, dy } }，tick 回调内实时更新
  const edgeMidpointsRef = useRef({})
  // 锁定边状态的 ref 镜像（解决 d3 事件闭包过期：d3 handler 只随 useEffect 重建，
  // 直接读 lockedEdge state 会拿到旧值，故用 ref 实时同步）
  const lockedEdgeRef = useRef(null)
  useEffect(() => { lockedEdgeRef.current = lockedEdge }, [lockedEdge])

  /**
   * 高亮/恢复一条可见边（供感应线事件调用）
   * 功能：按边 id 找出 .link-visual line，过渡加粗/提亮或恢复原样
   * 实现方式：全局 select .link-visual line 并 filter 数据匹配的边，改 stroke 属性
   * @param {{id: string, vectorScore?: number, llmScore?: number}} d - 边数据
   * @param {number} extraWidth - 加粗的额外宽度；0 表示恢复原宽
   * @param {number|null} opacity - 目标透明度；null 表示恢复原始映射
   */
  const setEdgeHighlight = (d, extraWidth, opacity) => {
    const target = select(svgRef.current)
      .selectAll('.link-visual line')
      .filter(function () { return this.__data__ && this.__data__.id === d.id })
    const baseWidth = 0.6 + (d.vectorScore || 0) * 2.2
    const baseOpacity = 0.2 + (d.llmScore || 0) * 0.7
    target
      .transition().duration(150)
      .attr('stroke-width', opacity == null ? baseWidth : baseWidth + extraWidth)
      .attr('stroke-opacity', opacity == null ? baseOpacity : opacity)
  }

  /**
   * 把边中点 SVG 坐标转视口屏幕坐标（供锁定浮窗定位）
   * 功能：svg.clientRect.offset + zoom transform(current ref) 换算
   * @param {{dx:number, dy:number}} mid - SVG 坐标系的中点
   * @returns {{x:number, y:number}} 视口坐标（position:fixed 用）
   */
  const toScreenXY = (mid) => {
    const rect = svgRef.current.getBoundingClientRect()
    const { x: tx, y: ty, k } = graphTransformRef.current
    return { x: rect.left + tx + mid.dx * k, y: rect.top + ty + mid.dy * k }
  }

  // UI 精修：类型图例数据——只显示当前图中出现的类型（按色板固定顺序，避免图例过长）
  const typeLegend = useMemo(() => {
    if (!data?.nodes?.length) return []
    const list = []
    for (const type of Object.keys(INSPIRATION_TYPE_COLORS.dark)) {
      // 该类型至少有一个节点才进图例
      if (data.nodes.some((n) => n.inspirationType === type)) {
        const color = getInspirationTypeColor(type)
        if (color) list.push({ type, color })
      }
    }
    return list
  }, [data])

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
    // 双线技巧：先画一条透明且更粗的"感应线"（碰撞箱/热区），再叠一条可见细线。
    // 目的：保持可见边外观不变（细线），但把鼠标可交互/点击的热区扩到宽范围，
    //       解决"线太细难点到/难 hover"的问题。交互事件全部绑在感应在线。
    const link = g.append('g')
      .attr('class', 'links')
      .selectAll('.link-hit')
      .data(edges)
      .enter()
      .append('line')
      .attr('class', 'link-hit')
      // 感应线：透明、宽热区，唯一视觉上是不可见的（stroke=none via opacity 0）
      .attr('stroke', d => getBridgeColor(d.bridgeType))
      .attr('stroke-width', 16)  // 碰撞箱宽度：约 16px，远超可见线，方便 hover/点击
      .attr('stroke-opacity', 0)  // 完全透明（只做热区）
      .attr('stroke-linecap', 'round')
      // 边 hover 事件（绑在透明粗感应线上）：
      //  - mouseenter：显示审批卡片 + 视觉强调（临时加粗可见线，稍后实现可见线加粗）
      //  - click：锁定选中，浮窗固化到边中点（鼠标移开不消失）
      // 注意：必须用 function(event, d) 形式，d3 的 this 指向当前 line DOM 元素
      .on('mouseenter', function(event, d) {
        // 已有锁定选中时，不再被普通 hover 打断（保持固化浮窗）
        // 用 ref 读取锁定状态（d3 handler 闭包不随 state 更新，直接读 state 会过期）
        if (lockedEdgeRef.current && lockedEdgeRef.current.edge.id !== d.id) return
        setHoveredEdge({ edge: d, x: event.clientX, y: event.clientY })
        // 视觉强调：加粗对应可见线（通过 attribute 同步），提亮
        setEdgeHighlight(d, 1.5, 0.9)
      })
      .on('mouseleave', function(event, d) {
        // 若边已锁定选中，鼠标移开仍保留固化浮窗，不清空 hoveredEdge
        if (lockedEdgeRef.current && lockedEdgeRef.current.edge.id === d.id) return
        setHoveredEdge(null)
        setEdgeHighlight(d, 0, null)
      })
      .on('click', function(event, d) {
        // 点击桥：锁定浮窗（固化到边中点位置），并高亮可见线
        event.stopPropagation()  // 阻止冒泡到覆盖层（否则空白点击会关闭）
        const mid = edgeMidpointsRef.current[d.id]
        const { x, y } = toScreenXY(mid || { dx: 0, dy: 0 })
        setLockedEdge({ edge: d, x, y })
        setHoveredEdge({ edge: d, x, y })  // 让卡片位置锁定到中点
        setEdgeHighlight(d, 1.5, 0.9)
      })

    // 可见线层（叠在感应线上，纯视觉，不接交互事件）
    const linkVisual = g.append('g')
      .attr('class', 'link-visual')
      .selectAll('line')
      .data(edges)
      .enter()
      .append('line')
      .attr('stroke', d => getBridgeColor(d.bridgeType))
      .attr('stroke-width', d => 0.6 + (d.vectorScore || 0) * 2.2)  // 粗细 = vectorScore（UI 精修：整体调细）
      .attr('stroke-opacity', d => 0.2 + (d.llmScore || 0) * 0.7)  // 透明度 = llmScore
      .attr('stroke-linecap', 'round')
      // 桥梁状态虚线渲染：pending=虚线（待审批），confirmed/其他=实线
      // 颜色仍由 bridgeType 决定（getBridgeColor），不因 status 改变
      .attr('stroke-dasharray', d => d.status === 'pending' ? '5 3' : null)

    // 创建节点组
    const node = g.append('g')
      .attr('class', 'nodes')
      .selectAll('circle')
      .data(nodes)
      .enter()
      .append('g')
      .attr('class', 'node-group')
      .style('cursor', 'pointer')

    // 节点圆形：UI 精修——fill = 灵感类型色（与桥梁色分离），未知类型兜底主题灰
    // 孤立节点（hasBridges=false 且 bridgeCount=0）仍用虚线灰色描边区分
    node.append('circle')
      .attr('r', d => nodeRadius(d.bridgeCount))
      .attr('fill', d => getInspirationTypeColor(d.inspirationType) || gt.nodeFill)
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
      // 同时移动感应线（热区）与可见线（视觉）
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y)
      linkVisual
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y)
      node.attr('transform', d => `translate(${d.x},${d.y})`)
      // 记录每条边中点的 SVG 坐标系坐标，供 click 锁定浮窗定位使用
      edgesRef.current.forEach((e) => {
        const sx = e.source && typeof e.source === 'object' ? e.source.x : 0
        const sy = e.source && typeof e.source === 'object' ? e.source.y : 0
        const tx = e.target && typeof e.target === 'object' ? e.target.x : 0
        const ty = e.target && typeof e.target === 'object' ? e.target.y : 0
        edgeMidpointsRef.current[e.id] = { dx: (sx + tx) / 2, dy: (sy + ty) / 2 }
      })
    })

    /**
     * d3-zoom 缩放/平移行为
     * 功能：滚轮缩放 + 拖拽平移 + 视图状态保存
     */
    const zoomBehavior = zoom()
      .scaleExtent([0.2, 4])  // 缩放范围 0.2x ~ 4x
      .on('zoom', (event) => {
        g.attr('transform', event.transform)
        // 记录当前 transform，供边中点转屏幕坐标用
        graphTransformRef.current = { x: event.transform.x, y: event.transform.y, k: event.transform.k }
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
      // 点击覆盖层空白处：取消边锁定、关闭审批浮窗（失去焦点）
      // 注意：边/节点 click 已 stopPropagation，故此处只收集真正的"空白点击"
      onClick={() => {
        setLockedEdge(null)
        setHoveredEdge(null)
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
              className="glow-btn glass-card flex items-center gap-1.5 px-3 py-2 rounded-lg text-ink/70 hover:text-ink/90 text-xs transition-colors"
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

        {/* UI 精修：类型图例（左上角）——告诉用户每种颜色的点代表哪种灵感类型 */}
        {typeLegend.length > 0 && (
          <div
            className="absolute top-4 left-4 glass-card rounded-lg px-3 py-2 animate-fade-in-up"
            style={{ background: 'rgb(var(--deep-rgb) / 0.85)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
          >
            <p className="text-ink/40 text-[10px] uppercase tracking-wider mb-1.5 font-sans">节点类型</p>
            <div className="flex flex-col gap-1">
              {typeLegend.map(({ type, color }) => (
                <div key={type} className="flex items-center gap-1.5">
                  <span
                    className="w-2 h-2 rounded-full flex-shrink-0"
                    style={{ background: color, boxShadow: `0 0 5px ${color}80` }}
                  />
                  <span className="text-ink/60 text-[10px] font-sans whitespace-nowrap">{type}</span>
                </div>
              ))}
            </div>
          </div>
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

        {/* 边 hover 审批卡片浮层（跟随鼠标，position: fixed 用视口坐标） */}
        {hoveredEdge && (() => {
          // 卡片宽度（用于右边界溢出检测）
          const cardWidth = 240
          // 卡片定位：默认在鼠标右下方 +12px；超出视口右边界时翻到鼠标左侧
          let cardLeft = hoveredEdge.x + 12
          if (cardLeft + cardWidth > window.innerWidth) {
            cardLeft = hoveredEdge.x - cardWidth - 12
          }
          const cardTop = hoveredEdge.y + 12
          const edge = hoveredEdge.edge
          // 桥梁类型主色（用于类型标签圆点 + 光晕）
          const bridgeColor = getBridgeColor(edge.bridgeType)
          const isPending = edge.status === 'pending'
          // 获取源灵感 ID：d3-force 运行后 edge.source 被替换为节点对象，需取 .id；
          // 若未经过 simulation（仍是字符串 ID）则直接使用
          const src = edge.source
          const inspirationId = typeof src === 'object' && src ? src.id : src
          // 连接描述：后端 graph 接口当前不下发 reason/connection，条件渲染以备将来扩展
          const description = edge.reason || edge.connection

          /**
           * 确认桥梁处理
           * 功能：调用 store.curateBridge（乐观更新 coalesceBridges + 后端持久化），
           *       并同步更新 forceGraphData 中对应边的 status → 'confirmed'，
           *       触发 useEffect 重渲染（虚线变实线）
           */
          const handleConfirm = () => {
            useStore.getState().curateBridge(inspirationId, edge.id, 'confirm')
            useStore.setState((state) => ({
              forceGraphData: state.forceGraphData ? {
                ...state.forceGraphData,
                edges: state.forceGraphData.edges.map((e) =>
                  e.id === edge.id ? { ...e, status: 'confirmed' } : e
                )
              } : state.forceGraphData
            }))
            // 立即关闭卡片 + 解除锁定，避免卡片悬空（边数据变化后旧引用失效）
            setHoveredEdge(null)
            setLockedEdge(null)
          }

          /**
           * 忽略桥梁处理
           * 功能：调用 store.curateBridge（乐观更新 + 后端持久化），
           *       并从 forceGraphData.edges 中移除该边，
           *       触发 useEffect 重渲染（边 DOM 元素随之移除）
           */
          const handleDismiss = () => {
            useStore.getState().curateBridge(inspirationId, edge.id, 'dismiss')
            useStore.setState((state) => ({
              forceGraphData: state.forceGraphData ? {
                ...state.forceGraphData,
                edges: state.forceGraphData.edges.filter((e) => e.id !== edge.id)
              } : state.forceGraphData
            }))
            setHoveredEdge(null)
            setLockedEdge(null)
          }

          return (
            <div
              className="glass-card rounded-xl animate-fade-in-up"
              // 卡片内部点击不冒泡到覆盖层（否则"空白点击关闭"会误关正在操作的卡片）
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              style={{
                position: 'fixed',
                left: cardLeft,
                top: cardTop,
                width: cardWidth,
                background: 'rgb(var(--deep-rgb) / 0.85)',
                backdropFilter: 'blur(12px)',
                WebkitBackdropFilter: 'blur(12px)',
                zIndex: 60,
                boxShadow: '0 10px 30px rgba(0, 0, 0, 0.45)'
              }}
            >
              {/* 顶部：桥梁类型标签（彩色圆点 + 中文名） + 状态徽章 */}
              <div className="px-3.5 pt-3 pb-2.5 border-b border-white/5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ background: bridgeColor, boxShadow: `0 0 6px ${bridgeColor}80` }}
                    />
                    <span className="text-ink/90 text-xs font-semibold font-sans truncate">
                      {BRIDGE_LABELS[edge.bridgeType] || edge.bridgeType || '桥梁'}
                    </span>
                  </div>
                  {isPending ? (
                    <span className="text-[9px] uppercase tracking-wider text-amber-400/80 font-sans flex-shrink-0">
                      待审批
                    </span>
                  ) : (
                    <span className="text-[9px] uppercase tracking-wider text-emerald-400/80 font-sans flex-shrink-0">
                      已确认
                    </span>
                  )}
                </div>
              </div>

              {/* 连接描述（如有 reason/connection 字段，展示全文，卡片高度随内容自适应） */}
              {description && (
                <div className="px-3.5 py-2 border-b border-white/5">
                  <p className="text-ink/55 text-[11px] font-sans leading-relaxed">
                    {description}
                  </p>
                </div>
              )}

              {/* 评分信息：vectorScore + llmScore（百分比展示） */}
              <div className="px-3.5 py-2 flex flex-col gap-1">
                <div className="flex items-center justify-between text-[10px] font-sans">
                  <span className="text-ink/40">向量分</span>
                  <span className="text-ink/70">{((edge.vectorScore || 0) * 100).toFixed(0)}%</span>
                </div>
                <div className="flex items-center justify-between text-[10px] font-sans">
                  <span className="text-ink/40">LLM 分</span>
                  <span className="text-ink/70">{((edge.llmScore || 0) * 100).toFixed(0)}%</span>
                </div>
              </div>

              {/* 审批按钮区（仅 pending 状态显示） */}
              {isPending && (
                <div className="px-3.5 pb-3 pt-1 flex items-center gap-2">
                  {/* 确认按钮：绿色系，hover 加深 */}
                  <button
                    type="button"
                    onClick={handleConfirm}
                    className="flex-1 py-1.5 rounded-md text-[11px] font-sans font-medium transition-all duration-200"
                    style={{
                      background: 'rgba(16, 185, 129, 0.15)',
                      border: '1px solid rgba(16, 185, 129, 0.4)',
                      color: '#34d399'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(16, 185, 129, 0.3)'
                      e.currentTarget.style.borderColor = 'rgba(16, 185, 129, 0.7)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(16, 185, 129, 0.15)'
                      e.currentTarget.style.borderColor = 'rgba(16, 185, 129, 0.4)'
                    }}
                  >
                    确认
                  </button>
                  {/* 忽略按钮：灰色系，hover 加深 */}
                  <button
                    type="button"
                    onClick={handleDismiss}
                    className="flex-1 py-1.5 rounded-md text-[11px] font-sans font-medium transition-all duration-200"
                    style={{
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                      color: 'rgba(255, 255, 255, 0.5)'
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'
                      e.currentTarget.style.color = 'rgba(255, 255, 255, 0.7)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'
                      e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)'
                      e.currentTarget.style.color = 'rgba(255, 255, 255, 0.5)'
                    }}
                  >
                    忽略
                  </button>
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* 底部提示栏 */}
      <div className="px-6 py-3 border-t border-line/5 flex items-center justify-between text-[11px] text-ink/35 font-sans">
        <div className="flex items-center gap-4">
          {/* 左下角：全量扫描桥梁按钮（与灵感详情"扫描桥梁"同款样式） */}
          <button
            type="button"
            onClick={scanAllBridges}
            disabled={forceGraphScanning || loading}
            className="glow-btn flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-sans transition-all disabled:opacity-50"
            style={{
              background: 'rgb(var(--cyan-bright-rgb) / 0.1)',
              color: 'var(--accent-cyan-bright)',
              border: '1px solid rgb(var(--cyan-bright-rgb) / 0.2)'
            }}
          >
            {forceGraphScanning ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Sparkles size={12} />
            )}
            <span>{forceGraphScanning ? '扫描中...' : '扫描桥梁'}</span>
          </button>
          <span className="hidden md:inline">拖拽节点 · 滚轮缩放 · 拖拽空白处平移</span>
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
