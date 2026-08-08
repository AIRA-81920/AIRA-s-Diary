// BaseAgent 基础类
// 功能：所有 Agent 的基类，提供 LLM 调用、灵感查询、结果保存等通用方法
// 实现方式：ES6 class，子类继承并实现 run() 方法

import { getOpenAIClient, withRetry, withTimeout, AGENT_TYPES } from '../services/openai.js';
import { getTemperature } from '../config/modelConfig.js';
import Inspiration from '../models/Inspiration.js';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

// LLM 单次调用超时（毫秒）：120s。deepseek 端点高峰可到 60-90s，120s 是宽松上限；
// 超过则抛错由上层 catch 转成可见错误，避免请求无限挂起（fix：原无超时控制）
const LLM_TIMEOUT_MS = 120000;

class BaseAgent {
  // 构造器：设置 Agent 名称、描述、类型与系统提示词
  // 子类应在构造器中覆盖 this.type 与 this.systemPrompt
  constructor(name, description) {
    this.name = name;
    this.description = description;
    this.type = AGENT_TYPES.DEFAULT;
    this.systemPrompt = '';
  }

  // 调用 LLM 生成内容
  // 功能：发送 prompt 到 OpenAI，返回完整响应对象
  // 实现方式：使用 getOpenAIClient 获取客户端，withRetry 包裹调用以支持限流重试
  // fix：增加超时控制（LLM 端点慢时避免请求无限挂起，前端卡在加载态）
  async generate(prompt, systemPrompt = null) {
    const { client, model } = getOpenAIClient(this.type);
    // 无 API key 时抛错，由调用方 try/catch 处理
    if (!client) throw new Error('OpenAI API key not configured');
    const finalSystem = systemPrompt || this.systemPrompt;
    const messages = [];
    if (finalSystem) messages.push({ role: 'system', content: finalSystem });
    messages.push({ role: 'user', content: prompt });
    const temperature = getTemperature(this.type);
    // withRetry 自动处理 429 限流与瞬时错误
    // 外层 withTimeout：单次调用超过 LLM_TIMEOUT_MS 则抛错，由上层 catch 转为可见错误
    return withTimeout(
      withRetry(() => client.chat.completions.create({ model, messages, temperature })),
      LLM_TIMEOUT_MS
    );
  }

  // 获取灵感对象
  // 功能：按 ID 查询灵感记录
  // 实现方式：调用 Inspiration.getById，无 id 时返回 null
  async getInspiration(inspirationId) {
    if (!inspirationId) return null;
    return Inspiration.getById(inspirationId);
  }

  // 保存结果到 per-inspiration 文件存储
  // 功能：在 inspirations/{id}/{subDir}/ 下写入 {timestamp}_{uuid}.json
  // 实现方式：fs.mkdir recursive 创建子目录，文件名含时间戳与短 uuid 保证唯一且可按时间排序
  async saveResult(inspirationId, subDir, data) {
    const dataDir = process.env.DATA_DIR || './data';
    const dir = path.join(dataDir, 'inspirations', inspirationId, subDir);
    await fs.mkdir(dir, { recursive: true });
    // 时间戳中的 : 与 . 替换为 -，保证文件名合法
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${timestamp}_${uuidv4().slice(0, 8)}.json`;
    const filePath = path.join(dir, fileName);
    // 写入内容附带时间戳与保存者信息
    const content = { ...data, timestamp: new Date().toISOString(), saved_by: this.name };
    await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8');
    return { file: fileName, path: filePath };
  }

  // 日志输出
  // 功能：统一前缀的 console.log，便于调试追踪 Agent 行为
  log(message) {
    console.log(`[${this.name}] ${message}`);
  }

  // 从 LLM 响应中提取 JSON
  // 功能：尝试从文本中解析 JSON，失败时正则匹配 {...} 块再解析
  // 实现方式：先 JSON.parse，失败后正则匹配，再失败返回 { raw, error }
  _parseJSON(content) {
    if (!content) return { raw: '' };
    try {
      // 直接尝试解析（最理想情况：LLM 返回纯 JSON）
      return JSON.parse(content);
    } catch {
      // 正则匹配 JSON 块（贪婪匹配最外层花括号）
      const match = content.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch { /* fallthrough */ }
      }
      return { raw: content, error: 'JSON parse failed' };
    }
  }

  // 从 OpenAI 响应中提取文本内容
  // 功能：从 chat completion 响应对象中取出 message.content
  // 实现方式：可选链访问 choices[0].message.content，无值返回空串
  _extractContent(result) {
    return result?.choices?.[0]?.message?.content || '';
  }
}

export default BaseAgent;
