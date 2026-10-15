// ExplainAgent — 提问支路 · AI 阐释（新增）
// 功能：用户在结晶追问屏答题前，可以就"这道题到底在问什么 / 某个选项是什么意思"向 AI 问一句话，AI 只做解释。
//       本条支路是旁路：不推进主线、不落盘、不写任何表；响应不含 stage / concept_map / crystal 等主线字段。
// 实现方式：继承 BaseAgent，explainStream 组装 messages（system 人设 + 上下文注入段 + 支路对话历史），
//   以 stream:true 调用 LLM，逐 delta.content 通过 onDelta 回调传出，实现真逐字流式。
// 设计原则：
//   - 解释者而非提问者：不推进流程、不评价用户、不反问、不催促作答
//   - 只回应用户真正问的那一点（用户点名某个选项就重点讲该选项）
//   - 说人话、简洁（3-5 句）、纯文本；不输出 [CORE] 之类标签
//   - 不联网搜索、不用 tools / function calling，保持轻量

import BaseAgent from './baseAgent.js';
import { AGENT_TYPES, getOpenAIClient } from '../services/openai.js';
import { getTemperature } from '../config/modelConfig.js';

// 关闭 DeepSeek 思考模式的请求参数
// 背景：deepseek-v4-pro 默认开启思考模式（thinking.type=enabled），思考期间不输出 content，
//   思考完成后才一次性输出最终回答，导致前端"等几秒后一口气蹦出来"的假流式现象；
//   本条支路要求真逐字流式输出，故关闭思考。仅本 Agent 使用，其他 Agent（Crystallize/Epitaxy/Coalesce/Conversation）不受影响。
// 实现：extra_body 确保 provider-specific 参数透传到 DeepSeek 后端（SDK v4 可能过滤顶层未知字段）
const NO_THINKING = {
  extra_body: {
    thinking: { type: 'disabled' }
  }
};

class ExplainAgent extends BaseAgent {
  constructor() {
    super('ExplainAgent', '回答用户对当前追问题目的疑问（解释者，不是提问者）');
    this.type = AGENT_TYPES.EXPLAIN;
    // 系统提示词：定义 AI 阐释者的人设与边界
    // 要点：只解释眼前这道题本身、只回应用户真正问的那一点、不推进流程、不评价/不反问/不催促、说人话、简洁纯文本
    this.systemPrompt = `你是 AIRA 系统的题目讲解助手。用户正在回答一道追问题目，答题前她可能没弄懂题意、或没弄懂某个选项，于是向你提问。

## 你唯一的任务
解释眼前这道追问题目本身——题干在问什么、某个选项是什么意思。你不是提问者，也不是评审者。

## 回复原则
1. **只回应用户真正问的那一点**：用户问什么你就答什么，不要顺带展开整道题或整份灵感。
2. **点名选项就重点讲该选项**：用户如果点名了某个选项（如"选项B"），就重点解释那个选项。题干下方会给出选项A/B/C/D → 选项文本 的对应关系，按此对照。
3. **不推进流程、不评价用户、不反问用户、不催用户作答**：不要问"你选哪个？"，不要评价她的想法，也不要推动她继续答题。
4. **说人话**：不要使用没有解释过的抽象黑话；如果必须用到某个抽象词，先用大白话把它说清楚；必要时举一个具体的小例子帮助理解。
5. **简洁**：整体控制在 3-5 句，把话说到位即可，不要长篇大论。
6. **纯文本**：可以使用 Markdown 分段，但不要输出 \`[CORE]\` 之类的标记或标签。
7. **超出范围就直说**：如果用户问的内容超出了这道题、这份灵感的范围，直接告诉她这不在本题范围内。`;
  }

  /**
   * 流式解释用户对当前追问题目的疑问
   * 功能：组装 messages 调用 LLM（stream:true），逐 delta.content 通过 onDelta 传出
   * 实现方式：
   *   1. 取 client/model（无 client 抛错）
   *   2. messages = [ system 人设, （上下文注入段，非空才加）, ...thread 映射为 assistant/user ]
   *   3. 调 chat.completions.create({ stream:true, ...NO_THINKING })，遍历 chunk 累积 answer
   *   4. 防御性过滤含 reasoning_content 的 delta
   * @param {{question?: Object, context?: Object, thread?: Array, onDelta?: (chunk: string) => void}} input
   * @returns {Promise<{answer: string}>}
   */
  async explainStream({ question, context = {}, thread = [], onDelta }) {
    const { client, model } = getOpenAIClient(this.type);
    if (!client) throw new Error('OpenAI API key not configured for explain agent');

    const temperature = getTemperature(this.type);

    // 组装 messages：人设 system + 上下文注入段（为空则省略）+ 支路对话历史
    const messages = [{ role: 'system', content: this.systemPrompt }];
    const contextPrompt = this._buildContextPrompt(question, context);
    if (contextPrompt) messages.push({ role: 'system', content: contextPrompt });
    for (const h of thread) {
      messages.push({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content || ''
      });
    }

    // 真流式调用：stream:true + 关闭 DeepSeek 思考模式
    const stream = await client.chat.completions.create({
      model,
      messages,
      temperature,
      stream: true,
      ...NO_THINKING
    });

    let answer = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      // 防御性过滤：跳过含 reasoning_content 的 delta（DeepSeek 思考模式未正确关闭时的兜底）
      if (delta.reasoning_content) continue;
      const text = delta.content || '';
      if (text) {
        answer += text;
        onDelta?.(text);
      }
    }

    return { answer };
  }

  /**
   * 构建上下文 prompt（不含用户问题，作为单独 system 消息注入）
   * 功能：把题目与灵感背景拼成一段"以下是背景，请基于此解释用户对这道题的疑问"
   * 实现方式：分块模板拼接，缺失字段静默跳过
   * @private
   * @param {{text?:string, options?:Array, multi?:boolean, max_select?:number|null,
   *          targetConcept?:string, targetConceptName?:string, targetConceptEvidence?:string}} question
   * @param {{inspirationTitle?:string, inspirationContent?:string, inspirationType?:string,
   *          crystalType?:string, conceptMapSummary?:Array, answeredRecord?:Array}} context
   * @returns {string}
   */
  _buildContextPrompt(question = {}, context = {}) {
    const sections = [];

    // 1. 灵感标题 / 原文
    if (context.inspirationTitle) {
      sections.push(`【灵感标题】\n${context.inspirationTitle}`);
    }
    if (context.inspirationContent) {
      sections.push(`【灵感原文】\n${context.inspirationContent}`);
    }

    // 2. 灵感类型 + 结晶形态
    const typeParts = [];
    if (context.inspirationType) typeParts.push(context.inspirationType);
    if (context.crystalType) typeParts.push(`结晶形态：${context.crystalType}`);
    if (typeParts.length > 0) {
      sections.push(`【灵感类型】\n${typeParts.join('、')}`);
    }

    // 3. 本题题干
    if (question && question.text) {
      sections.push(`【本题题干】\n${question.text}`);
    }

    // 4. 本题选项：必须列出"选项A=第1项文本、选项B=第2项文本…"的对应关系
    if (question && Array.isArray(question.options) && question.options.length > 0) {
      const optionLines = question.options
        .map((opt, i) => `选项${String.fromCharCode(65 + i)}=${opt}`)
        .join('、');
      let optionsBlock = `【本题选项】\n${optionLines}`;
      // 多选题标注上限
      if (question.multi) {
        const maxSelect = question.max_select;
        optionsBlock += `\n（多选，最多 ${maxSelect != null ? maxSelect : '不限'} 项）`;
      }
      sections.push(optionsBlock);
    }

    // 5. 本题归属概念（有才写）
    if (question && (question.targetConceptName || question.targetConceptEvidence)) {
      const conceptLines = [];
      if (question.targetConceptName) conceptLines.push(`概念：${question.targetConceptName}`);
      if (question.targetConceptEvidence) conceptLines.push(`支撑原话：${question.targetConceptEvidence}`);
      sections.push(`【本题归属概念】\n${conceptLines.join('\n')}`);
    }

    // 6. 概念地图进度（id + name + status 列表）
    if (Array.isArray(context.conceptMapSummary) && context.conceptMapSummary.length > 0) {
      const mapText = context.conceptMapSummary
        .map((c) => `- [${c.id}] ${c.name}（${c.status}）`)
        .join('\n');
      sections.push(`【概念地图进度】\n${mapText}`);
    }

    // 7. 主线已答记录（只读背景）
    if (Array.isArray(context.answeredRecord) && context.answeredRecord.length > 0) {
      const recordText = context.answeredRecord
        .map((r) => `问：${r.question}\n答：${r.answer}`)
        .join('\n');
      sections.push(`【主线已答记录（只读背景，不要据此提问）】\n${recordText}`);
    }

    return sections.length > 0
      ? `以下是背景，请基于此解释用户对这道题的疑问：\n\n${sections.join('\n\n')}`
      : '';
  }
}

export default ExplainAgent;