// CoalesceAgent — 跨灵感桥梁 Agent（K3 架构改造版）
// 功能：基于语义指纹 + 原文摘要，用 LLM 深挖两个灵感之间的跨界连接
// 实现方式：继承 BaseAgent，提供静态 deepen(pair) 方法供 CoalesceScanService 调用
//
// 架构文档 §10.2 接口契约：
//   interface CoalesceAgent {
//     deepen(pair: { a: PairSide; b: PairSide }): Promise<{ bridgeType: BridgeType; reason: string; llmScore: number }>;
//   }
//   interface PairSide {
//     inspirationId: string;
//     title: string;
//     fingerprint: string;        // 150-200 字语义指纹
//     contentExcerpt: string;     // 原文摘要 ≤500 字
//   }
//
// 关键约束（架构 §6.3 + §6.5 + §13）：
//   - 输入：双方 fingerprint（必填）+ 原文摘要（≤500 字）
//   - 输出：bridgeType（5 种之一）+ reason（具体连接说明）+ llmScore（0-1 信心分）
//   - LLM 超时 45s（LLM_LIMITS.SCAN_TIMEOUT_MS）
//   - 失败重试 1 次（带修正提示）
//   - JSON 输出非法时不写入任何产物（L1）
//   - 使用 COALESCE agent 配置（per-agent，可独立切换模型/服务商）
//
// 桥梁类型（5 种，来自 constants.BRIDGE_TYPES）：
//   imagery_isomorphism  — 意象同构：两个灵感中的意象在视觉/听觉层面有同构关系
//   structure_resonance  — 结构共振：两个灵感的内在结构（节奏/层次/形态）有共振
//   emotion_echo         — 情感回响：两个灵感唤起相似或互补的情感
//   technique_transfer   — 技法迁移：一个灵感的技法可迁移到另一个
//   theme_opposition     — 主题对立：两个灵感在主题上形成对立张力

import BaseAgent from './baseAgent.js';
import { AGENT_TYPES, getOpenAIClient, withRetry, withTimeout } from '../services/openai.js';
import { getTemperature } from '../config/modelConfig.js';
import {
  BRIDGE_TYPES,
  BRIDGE_TYPE_VALUES,
  LLM_LIMITS
} from '../config/constants.js';

// 桥梁类型中文标签（用于 prompt 内说明，不入库）
const BRIDGE_TYPE_LABELS = {
  imagery_isomorphism: '意象同构（不同主题但画面感相似）',
  structure_resonance: '结构共振（内在结构/逻辑相似）',
  emotion_echo: '情感回响（唤起相似情绪）',
  technique_transfer: '技法迁移（可借用方法）',
  theme_opposition: '主题对立（互为镜像/反面）'
};

class CoalesceAgent extends BaseAgent {
  constructor() {
    super('CoalesceAgent', '跨灵感桥梁 → 新灵感种子');
    this.type = AGENT_TYPES.COALESCE;
    this.systemPrompt = `你是 AIRA 系统的跨界连接师，擅长在看似无关的灵感之间发现深层联系。

## 核心原则
1. **找到真连接**：不是"都是创意"这种废话，是具体的、可操作的连接
2. **桥梁类型准确**：5 种类型必须选最贴切的那一种
3. **理由具体**：reason 必须说明"哪个意象/结构/情感/技法/主题"对应"哪个"
4. **基于指纹**：连接应基于双方的语义指纹（已浓缩了原文+crystal+chunks 的语义）

## 5 种桥梁类型
- imagery_isomorphism（意象同构）：两个灵感中的意象在视觉/听觉层面有同构关系
- structure_resonance（结构共振）：两个灵感的内在结构（节奏/层次/形态）有共振
- emotion_echo（情感回响）：两个灵感唤起相似或互补的情感
- technique_transfer（技法迁移）：一个灵感的技法可迁移到另一个
- theme_opposition（主题对立）：两个灵感在主题上形成对立张力

## 输出格式
严格的 JSON 对象，字段：
- bridgeType：上述 5 种之一（英文 key）
- reason：100-200 字的具体连接说明
- llmScore：0-1 的信心分（0.7 以上表示确信存在连接）

仅输出 JSON，无任何额外文字、markdown 标记或代码块包裹。`;
  }

  /**
   * 深挖桥梁（架构 §10.2 核心契约方法）
   * 功能：基于双方的 fingerprint + 原文摘要，LLM 生成 bridgeType + reason + llmScore
   * 实现方式：
   *   1. 构建 prompt（双方指纹 + 原文摘要）
   *   2. withTimeout(SCAN_TIMEOUT_MS) + withRetry(RETRY_TIMES) 调用 LLM
   *   3. 解析 JSON，校验 bridgeType ∈ BRIDGE_TYPE_VALUES，llmScore ∈ [0,1]
   *   4. 失败重试 1 次（带修正提示），仍失败抛错（不写入任何产物）
   * @param {{ a: object, b: object }} pair - 双方 PairSide
   * @returns {Promise<{ bridgeType: string, reason: string, llmScore: number }>}
   * @throws {Error} LLM 超时/输出非法/字段缺失时抛错
   */
  async deepen(pair) {
    if (!pair || !pair.a || !pair.b) {
      const err = new Error('pair.a and pair.b are required');
      err.code = 'DEEPEN_INVALID_INPUT';
      throw err;
    }

    const prompt = this._buildDeepenPrompt(pair.a, pair.b);

    // 第一次调用
    let result;
    try {
      result = await this._callDeepenLLM(prompt);
    } catch (err) {
      // 重试 1 次（带修正提示）
      console.warn(`[CoalesceAgent] first deepen failed (${err.message}), retrying with hint...`);
      const retryPrompt = prompt + '\n\n## 上次生成失败，请重新生成，严格遵守 JSON 格式与字段约束。';
      result = await this._callDeepenLLM(retryPrompt);
    }

    // 字段校验
    if (!BRIDGE_TYPE_VALUES.includes(result.bridgeType)) {
      const err = new Error(`Invalid bridgeType: ${result.bridgeType}`);
      err.code = 'LLM_OUTPUT_INVALID';
      throw err;
    }
    if (typeof result.llmScore !== 'number' || result.llmScore < 0 || result.llmScore > 1) {
      const err = new Error(`Invalid llmScore: ${result.llmScore}`);
      err.code = 'LLM_OUTPUT_INVALID';
      throw err;
    }
    if (!result.reason || typeof result.reason !== 'string' || result.reason.trim().length === 0) {
      const err = new Error('Invalid reason: empty');
      err.code = 'LLM_OUTPUT_INVALID';
      throw err;
    }

    return {
      bridgeType: result.bridgeType,
      reason: result.reason.trim(),
      llmScore: result.llmScore
    };
  }

  /**
   * 构建 deepen prompt（架构 §10.2）
   * 功能：组装双方的 fingerprint + 原文摘要，要求 LLM 输出 JSON
   * 实现方式：模板拼接 + 双方分块标注
   * @private
   * @param {object} sideA - PairSide A
   * @param {object} sideB - PairSide B
   * @returns {string} 完整 prompt
   */
  _buildDeepenPrompt(sideA, sideB) {
    return `请基于以下两个灵感的语义指纹与原文摘要，深挖它们之间的跨界连接。

## 灵感 A
- 标题：${sideA.title || '无'}
- 语义指纹：${sideA.fingerprint || '（无指纹，仅参考原文）'}
- 原文摘要：${sideA.contentExcerpt || '无'}

## 灵感 B
- 标题：${sideB.title || '无'}
- 语义指纹：${sideB.fingerprint || '（无指纹，仅参考原文）'}
- 原文摘要：${sideB.contentExcerpt || '无'}

## 任务
判断这两个灵感之间最贴切的桥梁类型，并给出具体连接说明与信心分。

## 桥梁类型说明
${Object.entries(BRIDGE_TYPE_LABELS).map(([k, v]) => `- ${k}：${v}`).join('\n')}

## 输出 JSON 格式（严格遵守）
{
  "bridgeType": "imagery_isomorphism",
  "reason": "100-200 字的具体连接说明，指出 A 的 X 与 B 的 Y 形成 Z 关系...",
  "llmScore": 0.85
}

## 关键约束
1. bridgeType 必须是上述 5 种之一（英文 key 原样）
2. reason 必须具体指出"哪个元素"对应"哪个元素"，禁止"两者都很有趣"这种废话
3. llmScore 反映你对连接的信心：0.9+ 极强连接，0.7-0.9 较强，0.5-0.7 中等，<0.5 弱
4. 仅输出 JSON，无任何前后缀文字`;
  }

  /**
   * 调用 LLM 执行 deepen（架构 §6.5 错误处理）
   * 功能：用 COALESCE agent 配置调用 LLM，withTimeout + withRetry 双重保护
   * 实现方式：
   *   1. 取 coalesce agent 的 client + model + temperature
   *   2. withTimeout(SCAN_TIMEOUT_MS=45s) 包裹
   *   3. withRetry(RETRY_TIMES=1) 包裹（指数退避 1s）
   *   4. 提取 content → _parseJSON → 校验字段
   * @private
   * @param {string} prompt - 完整 prompt
   * @returns {Promise<{ bridgeType: string, reason: string, llmScore: number }>}
   * @throws {Error} LLM 超时/输出非法 JSON/字段缺失时抛错
   */
  async _callDeepenLLM(prompt) {
    const { client, model } = getOpenAIClient(AGENT_TYPES.COALESCE);
    if (!client) {
      const err = new Error('OpenAI client not configured for coalesce agent');
      err.code = 'LLM_NOT_CONFIGURED';
      throw err;
    }

    const temperature = getTemperature(AGENT_TYPES.COALESCE);
    const messages = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: prompt }
    ];

    // withTimeout + withRetry 双重保护
    const result = await withRetry(
      () => withTimeout(
        client.chat.completions.create({ model, messages, temperature }),
        LLM_LIMITS.SCAN_TIMEOUT_MS
      ),
      { maxRetries: LLM_LIMITS.RETRY_TIMES, baseDelayMs: LLM_LIMITS.RETRY_BACKOFF_MS[0] || 1000 }
    );

    const content = this._extractContent(result);
    if (!content) {
      const err = new Error('LLM returned empty content');
      err.code = 'LLM_OUTPUT_INVALID';
      throw err;
    }

    const parsed = this._parseJSON(content);
    if (parsed.error || !parsed.bridgeType) {
      const err = new Error(`LLM output invalid JSON: ${parsed.error || 'missing bridgeType'}`);
      err.code = 'LLM_OUTPUT_INVALID';
      throw err;
    }

    return {
      bridgeType: parsed.bridgeType,
      reason: parsed.reason || '',
      llmScore: typeof parsed.llmScore === 'number' ? parsed.llmScore : 0.5
    };
  }

  // 兼容 BaseAgent.run 接口（供 agentHub.dispatch 调用，本期未使用）
  async run(context) {
    const { pair } = context;
    return this.deepen(pair);
  }
}

// 静态便捷方法：供 CoalesceScanService 直接调用（无需实例化）
CoalesceAgent.deepen = function(pair) {
  return new CoalesceAgent().deepen(pair);
};

// 保留旧接口兼容（已废弃，新代码应使用 deepen）
// 警告：excavateBridges 不再被 CoalesceScanService 调用，仅保留向后兼容
CoalesceAgent.excavateBridges = function(_inspirationId, _candidates) {
  console.warn('[CoalesceAgent] excavateBridges is deprecated, use deepen() instead');
  return Promise.resolve({ success: true, data: { bridges: [] } });
};

export default CoalesceAgent;
