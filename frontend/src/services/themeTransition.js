// 主题切换过渡（亮色模式改造新建）
// 功能：点击主题卡片时，先在水滴落点扩散 2 个涟漪圆环，
//       再用 View Transitions API 让新主题从点击坐标圆形扩散到全屏
// 实现方式：
//   - spawnRippleRings：fixed 定位容器插入 2 个 .theme-ripple-ring（CSS 动画，错开 120ms），900ms 后移除
//   - document.startViewTransition 包裹主题应用；ready 后对 ::view-transition-new(root)
//     做 clip-path circle 扩散动画，半径取点击点到最远屏幕角的距离
//   - 不支持 View Transitions 的浏览器静默降级为直接切换（涟漪圆环照常播放）

/**
 * 在点击坐标生成水滴涟漪圆环（纯视觉，动画结束自动移除）
 * @param {number} x - clientX
 * @param {number} y - clientY
 */
function spawnRippleRings(x, y) {
  const container = document.createElement('div')
  container.className = 'theme-ripple-container'
  container.style.left = `${x}px`
  container.style.top = `${y}px`
  container.appendChild(document.createElement('span'))
  container.appendChild(document.createElement('span'))
  container.childNodes.forEach((el) => { el.className = 'theme-ripple-ring' })
  document.body.appendChild(container)
  setTimeout(() => container.remove(), 1100)
}

/**
 * 水波扩散式主题切换
 * @param {number} x - 点击点 clientX（扩散圆心）
 * @param {number} y - 点击点 clientY（扩散圆心）
 * @param {() => void} applyTheme - 实际切换主题的回调（通常是 store.setTheme）
 */
export function rippleSwitchTheme(x, y, applyTheme) {
  // 水滴水花：圆环先走，不依赖 View Transitions 是否可用
  spawnRippleRings(x, y)

  if (!document.startViewTransition) {
    applyTheme()
    return
  }

  const vt = document.startViewTransition(() => applyTheme())
  vt.ready.then(() => {
    const r = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    )
    document.documentElement.animate(
      {
        clipPath: [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${r * 1.05}px at ${x}px ${y}px)`
        ]
      },
      {
        duration: 850,
        easing: 'cubic-bezier(.22,.61,.36,1)',
        pseudoElement: '::view-transition-new(root)'
      }
    )
  }).catch(() => { /* 过渡被跳过（如快速连续切换）时静默忽略 */ })
}
