// CollapsibleText 可折叠文本组件
// 功能：长文本默认折叠到指定行数（默认 6 行），超出部分显示"..."，点击按钮可展开/收起全貌
// 实现方式：
//   - 用 CSS -webkit-line-clamp 实现行数限制（内联样式，不依赖 Tailwind 动态类名）
//   - 用 useRef + useLayoutEffect 测量 scrollHeight 与 clientHeight，判断是否需要折叠按钮
//   - 行数 ≤maxLines 时不显示按钮，>maxLines 时才显示
//   - 展开/收起切换内联 style 的 WebkitLineClamp 值
//
// 应用场景：
//   - AddendumSection 的 addendum.content（长追加文本折叠）
//   - CommentItem 的 comment.content（长评论折叠）
//   - CommentItem 的 comment.context（阐释部分折叠）
import React, { useRef, useState, useLayoutEffect } from 'react'

/**
 * @param {object} props
 * @param {string} props.text - 待显示的文本（含换行符）
 * @param {number} [props.maxLines=6] - 折叠时显示的最大行数，默认 6
 * @param {string} [props.className] - 文本样式类名（字号、颜色、行高等）
 * @param {string} [props.wrapperClassName] - 外层包装样式类名
 */
function CollapsibleText({
  text,
  maxLines = 6,
  className = '',
  wrapperClassName = ''
}) {
  // expanded：false=折叠（默认），true=展开全貌
  const [expanded, setExpanded] = useState(false)
  // clamped：是否实际发生了行数截断（用于决定是否显示按钮）
  // 初始 false（假设不超出），测量后按真实情况修正
  const [clamped, setClamped] = useState(false)
  const ref = useRef(null)

  // 测量：每次 text 变化或组件挂载后，比较 scrollHeight 与 clientHeight
  // scrollHeight > clientHeight 说明内容超出可见区域，需要折叠按钮
  // 注意：测量时必须处于"折叠"状态，否则 line-clamp 不生效无法比较
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // 仅在折叠状态下测量（展开状态 scrollHeight===clientHeight 无意义）
    if (expanded) {
      setClamped(true) // 展开后假设原本有截断（保留按钮）
      return
    }
    const isOverflowing = el.scrollHeight > el.clientHeight + 1
    setClamped(isOverflowing)
  }, [text, expanded])

  // 空文本直接返回 null
  if (!text) return null

  return (
    <div className={wrapperClassName}>
      {/* 文本主体：折叠时设 WebkitLineClamp，展开时设 'none' */}
      <p
        ref={ref}
        className={`${className} whitespace-pre-wrap break-words`}
        style={{
          // 折叠时附加 -webkit-line-clamp（内联样式兜底，不依赖 Tailwind 动态类名）
          // 展开时设 'none' 移除限制
          WebkitLineClamp: !expanded ? maxLines : 'none',
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden'
        }}
      >
        {text}
      </p>
      {/* 展开按钮：仅在 clamped=true（内容确实超出）时显示 */}
      {clamped && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] text-ink/40 hover:text-ink/70 transition-colors font-sans"
        >
          {expanded ? '收起' : '展开'}
        </button>
      )}
    </div>
  )
}

export default CollapsibleText
