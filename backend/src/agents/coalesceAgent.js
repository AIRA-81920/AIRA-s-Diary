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
// 2026-08 精简为 3 种：意象同构 / 结构共振 / 主题对立
const BRIDGE_TYPE_LABELS = {
  imagery_isomorphism: '意象同构（一方具体的意象、画面能被另一方具体承接或回应）',
  structure_resonance: '结构共振（双方内在的组织/结构/逻辑存在可指认的相似）',
  theme_opposition: '主题对立（双方在同一个具体命题上形成对立或张力）'
};

class CoalesceAgent extends BaseAgent {
  constructor() {
    super('CoalesceAgent', '跨灵感桥梁 → 新灵感种子');
    this.type = AGENT_TYPES.COALESCE;
    this.systemPrompt = `你是 AIRA 系统的跨界连接师，负责判断两个灵感之间是否存在"真连接"。

## 最高原则：宁可拒绝，不可强连
你没有义务为每一对灵感都建立桥梁。**如果你的深思熟虑后认为两者之间没有实质联系，就必须明确拒绝**。
强行凑出的连接不但无用，还会污染整个灵感网络。判断标准是"我真的理解了这两个东西，并确认存在可验证的联系"，而不是"我能不能硬说出一个共性"。

## 如何判断"真连接"：必须可点对点验证
连接必须能落到双方**具体的、可指认的元素**上，并说明"谁"对应"谁"。禁止使用"都体现XX精神""都有XX的意味""本质上是同一种XX"这类**不可证伪的抽象套话**。

判断时先自问三个问题：
1. 我是否能从灵感 A 里找到一个**具体的**元素（一个意象、一段结构、一个主张）？
2. A 的这个具体元素，是否能在灵感 B 里找到**一个具体的**对应物（承接、结构相似、或对立）？
3. 这个对应是否**换了媒介/换了语境仍然成立**，而不是只因为标题或表面关键词像？

只要以上任一无法指向具体证据，就说明连接不扎实，此时应**拒绝**而非硬连。

## 允许的连接类型（仅 3 种）
- imagery_isomorphism（意象同构）：一方某**具体意象/画面**，能被另一方**具体**承接或回应。必须指出 A 的"哪个意象"对应 B 的"哪个意象"，禁止停留在"都有氛围感"。
- structure_resonance（结构共振）：双方**内在的组织方式、推进节奏、逻辑骨架**有可指认的相似。必须说明"结构上是如何对应"的，禁止只停留在"都很复杂/都是层层递进"这种模糊表述。
- theme_opposition（主题对立）：双方在**同一个具体命题**上站在对立面。必须点明"这个共同命题是什么、双方各自持什么立场"，否则不构成对立。

若两者的关系不属于以上任何一类——最常见情况——**应当拒绝建立桥梁**。

## 输出格式
严格的 JSON 对象，字段：
- bridgeType：上述 3 种之一（英文 key）；若判定无实质连接，则返回 "no_link"
- reason：50-150 字的具体连接说明（must：指出 A 的哪个具体元素与 B 的哪个具体元素如何对应；拒绝时简述为什么判定无关）
- llmScore：0-1 的实数值，表示"你对这个判断的把握"。
  - 0.85+：你非常确信存在**扎实的、可验证的**连接
  - 0.60-0.85：连接存在，但可能只涉及局部或程度有限
  - 0.40-0.60：临界——连接存疑，你偏向存在但站不住；此时若无法自圆其说，应返回 no_link
  - <0.40：你倾向认为**不存在实质连接**，应返回 no_link
  
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
    // bridgeType 合法值：BRIDGE_TYPE_VALUES（3 类真连接）+ 拒绝值 'no_link'（2026-08 新增拒绝权）
    if (result.bridgeType !== 'no_link' && !BRIDGE_TYPE_VALUES.includes(result.bridgeType)) {
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
      bridgeType: result.bridgeType,          // 可能为 'no_link'（表示拒绝）
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
    return `请基于以下两个灵感的语义指纹与原文摘要，判断它们之间是否存在"真连接"。

## 灵感 A
- 标题：${sideA.title || '无'}
- 语义指纹：${sideA.fingerprint || '（无指纹，仅参考原文）'}
- 原文摘要：${sideA.contentExcerpt || '无'}

## 灵感 B
- 标题：${sideB.title || '无'}
- 语义指纹：${sideB.fingerprint || '（无指纹，仅参考原文）'}
- 原文摘要：${sideB.contentExcerpt || '无'}

## 任务
1. 先**独立理解**这两个灵感各自在说什么、核心主张/形态是什么。
2. 再判断：A 里能否找到一个**具体元素**，能在 B 里找到**具体的对应物**（承接 / 结构相似 / 对立）。
3. 只有当你找到**可点对点验证**的真连接时才建立桥梁；否则**返回 no_link 拒绝**。你没有义务为每一对建立联系。

## 允许的桥梁类型（仅 3 种）
${Object.entries(BRIDGE_TYPE_LABELS).map(([k, v]) => `- ${k}：${v}`).join('\n')}

## 反例（强烈禁止的"假连接"）
以下都是**不可证伪的抽象套话**，属于强连，直接判定为 no_link：
- "都体现了'从混乱到有序'的过程"
- "两者都带有'漂浮到锚定'的意味"
- "本质上是关于XX的深层探讨"
- "都让人联想到推进感/积淀感"
这些属于任何两个东西都能套上的万能句式，不构成真实连接。

## 更接近"真连接"的正确示例
- 意象同构：A 里的"杯沿缺口、反复摩挲"这一焦虑小动作，恰好能承接 B 里"本地资料边界的反复校验"——两者都通过一个**可触摸的收缩动作**应对不确定。必须落在具体意象上。
- 结构共振：A 的"先展开细节铺陈 → 再点出真相"的叙事推进，与 B 的"先碎片 → 后结晶"的认知推进，存在**可指认的步骤对应**。
- 主题对立：A 主张"技术应完全本地化、拒绝联网"，B 主张"只有联网才能突破边界"，在**同一个命题上**形成对峙。

## 输出 JSON 格式（严格遵守）
{
  "bridgeType": "structure_resonance",
  "reason": "50-150 字的连接说明：指出 A 的哪个具体元素与 B 的哪个具体元素如何对应；若拒绝则简述判定无关的原因",
  "llmScore": 0.85
}

## 关键约束
1. bridgeType 只能是 imagery_isomorphism / structure_resonance / theme_opposition 三者之一；**判定无实质连接时返回 "no_link"**
2. reason 必须具体到"哪个元素↔哪个元素"，禁止任何抽象套话
3. llmScore 表示你判断的把握，**不是"连接写得顺不顺"**；把握不足、无法自圆其说时应返回 no_link 并给低分
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
