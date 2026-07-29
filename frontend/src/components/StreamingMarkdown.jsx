// StreamingMarkdown 流式 Markdown 渲染器
// 功能：把流式输入的文本按"稳定区/不稳定区"切割，
//       稳定区用 ReactMarkdown 渲染（支持 GFM 表格/删除线/任务列表），
//       不稳定区用纯文本显示（防止 **、`、[ 等标记被拆到一半时错误渲染），
//       流式进行中在末尾显示闪烁光标
// 实现方式：
//   1. 每次收到新 text，从尾部往前找最后一个"安全切割点"（不处于任何未闭合 Markdown 标记内）
//   2. 切割点之前 → stableText → ReactMarkdown 渲染
//   3. 切割点之后 → pendingText → 纯文本 span（HTML 转义防注入）
//   4. streaming=false 时，整段视为稳定区全部渲染
//   5. 安全切割点检测：换行符天然安全；未闭合的 ``` / ` / ** / [ / ![ 则回退到该标记开始前
//
// 参考：用户提供的 StreamingMarkdownRenderer 设计模式（稳定区/不稳定区双缓冲）

import React, { useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 找最后一个安全切割点
 * 功能：从 text 末尾往前扫，找到一个不处于任何未闭合 Markdown 标记内部的位置
 * 实现方式：依次检查代码块/标题/表格行/行内代码/粗体/斜体/链接/图片等状态，
 *           若处于未闭合状态则回退到该标记开始之前；换行符天然安全
 * 参考：用户提供的 StreamingMarkdownRenderer._findSafeCutPoint 设计
 * @param {string} text - 当前完整文本
 * @returns {number} 安全切割点的索引（0~text.length）
 */
function findSafeCutPoint(text) {
  const len = text.length
  if (len === 0) return 0

  // 1. 检查未闭合的代码块 ```（奇数个 ``` = 在代码块内）
  //    代码块内的内容应整体作为不稳定区，回退到最后一个 ``` 之前
  const codeBlockMatches = text.match(/```/g)
  if (codeBlockMatches && codeBlockMatches.length % 2 === 1) {
    return text.lastIndexOf('```')
  }

  // 2. 从末尾往前找最后一个换行符作为候选安全点
  //    换行后是新行，行级语法（标题/表格/列表）天然完整
  let cut = text.lastIndexOf('\n')
  if (cut === -1) cut = 0

  // 当前行内容（cut 之后的部分，用于行级与行内标记检测）
  const lineStart = cut === 0 ? 0 : cut + 1
  const currentLine = text.slice(lineStart)

  // 3. 检查当前行是否是未完成的标题 # xxx
  //    标题以 1-6 个 # 开头后跟空格，整行未换行则不安全，回退到上一行末尾
  if (/^#{1,6}\s/.test(currentLine)) {
    return cut === 0 ? 0 : cut
  }

  // 4. 检查当前行是否是未完成的表格行 | a | b |
  //    保守策略：当前行含 | 且未换行就认为不安全，等换行后再推进
  if (currentLine.includes('|')) {
    return cut === 0 ? 0 : cut
  }

  // 4.5 检查当前行是否是代码块围栏行 ```（开围栏或闭合围栏）
  //     代码块已闭合（偶数个 ```）时，末尾的 ``` 是闭合围栏，应包含进稳定区
  //     否则闭合围栏留在不稳定区，stable 区代码块未闭合会导致 ReactMarkdown 渲染异常
  const fenceMatch = currentLine.match(/^```[^\n]*/)
  if (fenceMatch) {
    // 围栏行本身是完整的行级标记，包含进稳定区；围栏后的内容留在不稳定区
    return lineStart + fenceMatch[0].length
  }

  // 5. 检查 cut 之后的行内标记是否闭合（行内标记不跨行，用 currentLine 统计）

  // 5.1 行内代码 ` 未闭合（奇数个 = 在行内代码内）
  //     先剥离 ``` 围栏反引号，防止代码块围栏被误统计为行内代码
  const codeStrippedLine = currentLine.replace(/```/g, '')
  const inlineCodeCount = (codeStrippedLine.match(/`/g) || []).length
  if (inlineCodeCount % 2 === 1) {
    return text.lastIndexOf('`')
  }

  // 5.2 粗体 ** 未闭合（奇数个 ** = 在粗体内）
  const boldMatches = currentLine.match(/\*\*/g)
  if (boldMatches && boldMatches.length % 2 === 1) {
    return text.lastIndexOf('**')
  }

  // 5.3 斜体 *xxx* 未闭合
  //     统计独立的 * 数量，需排除：** 的一部分、转义 \*、行首列表项 * 后跟空格
  let italicCount = 0
  let lastItalicIdx = -1
  for (let i = 0; i < currentLine.length; i++) {
    const ch = currentLine[i]
    if (ch !== '*') continue
    // 排除 ** 的一部分：后跟 * 或前一个是 *
    if (currentLine[i + 1] === '*') continue
    if (i > 0 && currentLine[i - 1] === '*') continue
    // 排除转义 \*
    if (i > 0 && currentLine[i - 1] === '\\') continue
    // 排除行首列表项（* 后跟空格）
    if (i === 0 && currentLine[i + 1] === ' ') continue
    italicCount++
    lastItalicIdx = i
  }
  // 斜体未闭合：回退到最后一个独立 * 之前（转换为 text 绝对索引）
  if (italicCount % 2 === 1) {
    return lineStart + lastItalicIdx
  }

  // 5.4 链接 [text](url) / 图片 ![alt](url) 未闭合
  //     找最后一个 [，若其后没有完整的 ](...) 闭合，则回退到该 [ 之前
  //     注意：图片 ![ 与链接 [ 的闭合检测逻辑一致，lastIndexOf('[') 已覆盖两者
  const lastBracket = text.lastIndexOf('[')
  if (lastBracket >= 0) {
    const after = text.slice(lastBracket)
    // 检查是否有完整的 ](url) 闭合（url 内不含括号，简化处理）
    if (!/\]\([^)]*\)/.test(after)) {
      return lastBracket
    }
  }

  // 6. cut 之后安全，返回 cut 之后的位置（保留换行符在稳定区）
  return cut === 0 ? 0 : cut + 1
}

/**
 * StreamingMarkdown 组件
 * @param {{ text: string, streaming?: boolean }} props
 */
function StreamingMarkdown({ text, streaming = false }) {
  // useMemo 缓存切割结果，避免每次渲染都重算
  const { stableText, pendingText } = useMemo(() => {
    // 流式结束或文本为空：全部稳定
    if (!streaming || !text) {
      return { stableText: text, pendingText: '' }
    }
    const cut = findSafeCutPoint(text)
    return {
      stableText: text.slice(0, cut),
      pendingText: text.slice(cut)
    }
  }, [text, streaming])

  // 空文本且流式中：只显示光标
  if (!text && streaming) {
    return <span className="streaming-cursor" />
  }

  return (
    <div className="streaming-md">
      {/* 稳定区：ReactMarkdown 渲染（GFM 支持表格/删除线/任务列表） */}
      {stableText && (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
          // 各元素自定义渲染，融入深空美学
          h1: ({ node, ...props }) => <h1 className="text-base font-semibold text-ink/90 mt-3 mb-2 font-sans" {...props} />,
          h2: ({ node, ...props }) => <h2 className="text-[15px] font-semibold text-ink/90 mt-3 mb-2 font-sans" {...props} />,
          h3: ({ node, ...props }) => <h3 className="text-sm font-semibold text-ink/85 mt-2.5 mb-1.5 font-sans" {...props} />,
          h4: ({ node, ...props }) => <h4 className="text-sm font-semibold text-ink/80 mt-2 mb-1 font-sans" {...props} />,
          p: ({ node, ...props }) => <p className="my-1.5 leading-[1.7]" {...props} />,
          ul: ({ node, ...props }) => <ul className="my-1.5 pl-4 space-y-0.5 list-disc list-outside" {...props} />,
          ol: ({ node, ...props }) => <ol className="my-1.5 pl-4 space-y-0.5 list-decimal list-outside" {...props} />,
          li: ({ node, ...props }) => <li className="leading-[1.7]" {...props} />,
          strong: ({ node, ...props }) => <strong className="font-semibold text-ink" {...props} />,
          em: ({ node, ...props }) => <em className="text-ink/80" {...props} />,
          // 行内代码
          code: ({ node, inline, ...props }) =>
            inline
              ? <code className="px-1 py-0.5 rounded text-[12px] font-mono" style={{ background: 'rgb(var(--cyan-rgb) / 0.12)', color: 'var(--accent-cyan-light)' }} {...props} />
              : <code className="font-mono text-[12px]" {...props} />,
          // 代码块
          pre: ({ node, ...props }) => (
            <pre
              className="my-2 p-2.5 rounded-lg overflow-x-auto text-[12px] font-mono"
              style={{ background: 'var(--code-bg)', border: '1px solid rgb(var(--ink) / 0.06)' }}
              {...props}
            />
          ),
          // 引用块
          blockquote: ({ node, ...props }) => (
            <blockquote
              className="my-2 pl-2.5 py-0.5 text-ink/70"
              style={{ borderLeft: '2px solid rgb(var(--amber-rgb) / 0.4)' }}
              {...props}
            />
          ),
          // 分隔线
          hr: () => <hr className="my-2.5 border-line/8" />,
          // 链接
          a: ({ node, ...props }) => <a className="streaming-link underline underline-offset-2" target="_blank" rel="noopener noreferrer" {...props} />,
          // 表格
          table: ({ node, ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full text-[12px] border-collapse" {...props} />
            </div>
          ),
          th: ({ node, ...props }) => <th className="px-2 py-1 text-left font-semibold text-ink/85 border border-line/10" style={{ background: 'rgb(var(--ink) / 0.03)' }} {...props} />,
          td: ({ node, ...props }) => <td className="px-2 py-1 text-ink/70 border border-line/8" {...props} />,
        }}>
          {stableText}
        </ReactMarkdown>
      )}
      {/* 不稳定区：纯文本显示（防 HTML 注入用 span 包裹），流式中加闪烁光标 */}
      {pendingText && (
        <span className="text-ink/85">{pendingText}</span>
      )}
      {streaming && <span className="streaming-cursor" />}
    </div>
  )
}

export default StreamingMarkdown
