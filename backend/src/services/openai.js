// OpenAI 客户端工厂服务
// 功能：提供客户端缓存、限流重试、超时控制等基础设施
// 实现方式：使用 Map 缓存客户端实例，withRetry 实现指数退避，withTimeout 用 Promise.race

import { createOpenAIClient, getModel, AGENT_TYPES } from '../config/modelConfig.js';

// 客户端缓存（按 agentType 缓存，避免重复创建 OpenAI 实例）
const clientCache = new Map();

// 每 Agent 类型的限流配置（为后续里程碑铺路，本里程碑仅作配置预留）
const RATE_LIMITS = {
  research:    { rpm: 20, maxConcurrent: 2 },
  evaluation:  { rpm: 15, maxConcurrent: 1 },
  execution:   { rpm: 10, maxConcurrent: 1 },
  default:     { rpm: 60, maxConcurrent: 3 }
};

// 获取或创建 OpenAI 客户端
// 功能：按 agentType 缓存客户端，返回 { client, model }
// 实现方式：Map 缓存，无 API key 时返回 { client: null, model }
export function getOpenAIClient(agentType = AGENT_TYPES.DEFAULT) {
  // 命中缓存直接返回
  if (clientCache.has(agentType)) return clientCache.get(agentType);
  // 新建并缓存：client 可能为 null（无 API key 时），model 总是从配置读取
  const result = { client: createOpenAIClient(agentType), model: getModel(agentType) };
  clientCache.set(agentType, result);
  return result;
}

// 指数退避重试
// 功能：失败时自动重试，429 限流时退避时间加倍
// 实现方式：for 循环 + setTimeout，maxRetries 默认 2（共 3 次尝试）
export async function withRetry(fn, { maxRetries = 2, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // 最后一次尝试仍失败则抛出
      if (attempt === maxRetries) throw error;
      // 429 限流时退避加倍，其他错误用标准指数退避
      const isRateLimit = error?.status === 429;
      const delay = isRateLimit
        ? baseDelayMs * Math.pow(2, attempt) * 2
        : baseDelayMs * Math.pow(2, attempt);
      console.warn(`[OpenAI] Attempt ${attempt + 1} failed, retrying in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// 超时控制
// 功能：给 Promise 包裹超时限制
// 实现方式：Promise.race 与 setTimeout 竞速，超时则 reject
export async function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${timeoutMs}ms`)), timeoutMs)
    )
  ]);
}

// 流式生成（为后续里程碑预留接口，本里程碑不强制实现流式）
// 功能：async generator 逐 chunk 生成内容
// 实现方式：调用 OpenAI stream API，逐 chunk yield 内容
export async function* generateStream(agentType, messages, systemPrompt = null) {
  const { client, model } = getOpenAIClient(agentType);
  if (!client) throw new Error('OpenAI client not configured');
  // 有 systemPrompt 时拼接到消息数组头部
  const finalMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;
  const stream = await client.chat.completions.create({
    model,
    messages: finalMessages,
    stream: true
  });
  let full = '';
  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    full += content;
    yield content;
  }
  return full;
}

export { AGENT_TYPES };
