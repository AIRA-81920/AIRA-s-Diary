// 提问支路（AI 阐释）控制器
// 功能：处理 POST /api/explain 端点的 SSE 请求——用户在结晶追问屏答题前，就问"这题到底在问什么 / 某选项是什么意思"向 AI 要一段解释。
// 实现方式：
//   1. 设置 SSE 响应头（Content-Type: text/event-stream + 禁用代理缓冲）
//   2. 从 req.body 取 { question, context, thread }，做基础校验（不满足则回一帧 error 后正常结束，不抛 500）
//   3. 调用 ExplainAgent.explainStream，通过 onDelta 回调逐 chunk 写 SSE data 帧
//   4. 每帧 data 为 JSON：{ type: 'delta', text } 或 { type: 'done' } 或 { type: 'error', error }
//
// 旁路约束：本控制器不 import 任何数据库/文件存储，不读写任何表或文件。
//   - 不推进主线、不落盘；question/context/thread 全部来自前端请求体，原样透传给 Agent。

import ExplainAgent from '../agents/explainAgent.js';

// 单例：ExplainAgent 无状态，复用一个实例
const agent = new ExplainAgent();

/**
 * 流式阐释入口（SSE）
 * 功能：POST /api/explain
 *       body: { question: { text, options, multi, max_select, targetConcept, targetConceptName, targetConceptEvidence },
 *               context: { inspirationTitle, inspirationContent, inspirationType, crystalType, conceptMapSummary, answeredRecord },
 *               thread: [{ role, content }] }
 * 实现方式：
 *   1. 设置 SSE 响应头（Content-Type: text/event-stream + 禁用缓冲）
 *   2. 校验 question.text / thread 结构，不满足则发 error 帧后正常结束
 *   3. 调用 agent.explainStream，通过 onDelta 回调逐 chunk 写 SSE data 帧
 *   4. 流结束发 done 帧；异常在 catch 里记日志并发 error 帧
 * 关键坑点：必须监听 res.on('close') 而非 req.on('close')
 *   - req 'close' 在请求体读取完成后就会触发（Express 4.x），会误判为客户端断开
 *   - res 'close' 只在响应连接真正关闭时触发，适合 SSE 断开检测
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function explainStream(req, res) {
  // SSE 响应头：禁用 nginx/代理缓冲，保持长连接
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // 写入前刷新头部，确保客户端立刻收到响应头
  res.flushHeaders?.();

  // 客户端断开标记：连接关闭时置 true，避免继续写入
  // 必须用 res 'close' 而非 req 'close'（见上方 JSDoc 关键坑点说明）
  let clientClosed = false;
  const onClose = () => { clientClosed = true; };
  res.on('close', onClose);

  /**
   * 发送一帧 SSE 数据
   * 功能：把对象序列化为 JSON，按 SSE 协议写入 data: 行 + 空行分隔
   * @param {Object} payload - { type, ... }
   */
  const sendFrame = (payload) => {
    if (clientClosed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const { question, context, thread } = req.body || {};

    // 校验 1：题干必须是非空字符串
    if (!question || typeof question.text !== 'string' || !question.text.trim()) {
      sendFrame({ type: 'error', error: '缺少题目内容（question.text）' });
      return;
    }
    // 校验 2：thread 必须是非空数组
    if (!Array.isArray(thread) || thread.length === 0) {
      sendFrame({ type: 'error', error: '缺少对话内容（thread）' });
      return;
    }
    // 校验 3：thread 最后一条必须是用户的非空提问
    const lastMessage = thread[thread.length - 1];
    if (!lastMessage || lastMessage.role !== 'user'
      || typeof lastMessage.content !== 'string' || !lastMessage.content.trim()) {
      sendFrame({ type: 'error', error: '对话最后一条必须是用户的提问' });
      return;
    }

    // 调用 agent.explainStream，每个 delta 立刻发一帧
    await agent.explainStream({
      question,
      context: context || {},
      thread,
      onDelta: (chunk) => sendFrame({ type: 'delta', text: chunk }),
    });

    // 流结束：发 done 帧
    sendFrame({ type: 'done' });
  } catch (e) {
    console.error('[ExplainController] explainStream failed:', e.message);
    sendFrame({ type: 'error', error: e.message });
  } finally {
    // 清理连接监听 + 结束响应
    res.off('close', onClose);
    if (!clientClosed) {
      res.end();
    }
  }
}