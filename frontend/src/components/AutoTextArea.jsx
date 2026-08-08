// AutoTextArea 自适应高度 textarea
// 功能：文本框高度跟随内容变化，内容多则变高，内容少则变小，上限超出后滚动条
// 实现方式：
//   - useRef 拿到 DOM
//   - useLayoutEffect 在 value 变化时先 height=auto 重置，再按 scrollHeight 设置高度
//   - maxHeight 兜底防无限增高（超出后 overflow-y: auto 出现滚动条）
//   - minRows 提供起始行高（仅用于初始/空内容时撑开可见高度）
//   - forwardRef 暴露内部 textarea DOM，让调用方可调 .focus() 等
//
// 用法：
//   <AutoTextArea value={text} onChange={setText} className="..." placeholder="..." />
//   const ref = useRef(); <AutoTextArea ref={ref} ... />; ref.current.focus();
//
// 替换场景：
//   - AddendumSection 编辑框 / CommentInput 评论输入框 / ImageCard 描述框 / AddendumInputModal 内容框
//   - InspirationModal 标题内容框 / InspirationDetail content 编辑框
import React, { useRef, useLayoutEffect, useCallback, forwardRef, useImperativeHandle } from 'react'

const AutoTextArea = forwardRef(function AutoTextArea({
  value,
  onChange,
  minRows = 1,
  maxHeight = 400,
  className = '',
  placeholder = '',
  autoFocus = false,
  disabled = false,
  onBlur,
  onKeyDown,
  ...rest
}, outerRef) {
  // 内部 ref 拿到 DOM（外部 ref 通过 useImperativeHandle 转发）
  const innerRef = useRef(null)
  // 暴露 DOM 给外部 ref，调用方可调 .focus() / .scrollHeight 等
  useImperativeHandle(outerRef, () => innerRef.current, [])

  // 高度调整函数：先重置为 auto，再按 scrollHeight 设置（受 maxHeight 上限约束）
  const resize = useCallback(() => {
    const el = innerRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${next}px`
    // 超过 maxHeight 时启用滚动条
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [maxHeight])

  // value 变化或组件挂载时重算高度
  useLayoutEffect(() => {
    resize()
  }, [value, resize])

  // 初次挂载时也调整一次（防止 SSR 或初始值已存在但未触发 effect）
  useLayoutEffect(() => {
    resize()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 计算 minRows 对应的像素高度（作为 minHeight 内联样式兜底）
  // 一行高度约 1.6em，按 fontSize 估算不可靠，故用 rows 属性让浏览器自动撑开
  return (
    <textarea
      ref={innerRef}
      value={value}
      onChange={(e) => {
        onChange?.(e.target.value)
        // onChange 后立即重算（不等 effect，让响应更即时）
        requestAnimationFrame(resize)
      }}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={disabled}
      rows={minRows}
      className={className}
      style={{
        resize: 'none',
        overflow: 'hidden',
        // minHeight 不强制设值，由 rows 属性撑开初始高度
        // maxHeight 用内联样式兜底（防 className 中的 maxHeight 未生效）
        maxHeight: `${maxHeight}px`
      }}
      {...rest}
    />
  )
})

export default AutoTextArea
