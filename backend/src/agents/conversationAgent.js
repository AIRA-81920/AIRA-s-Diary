// ConversationAgent — 追加条目对话 Agent（v7 新增）
// 功能：基于灵感上下文（原文 + crystal + 当前追加主帖 + 评论 + 对话历史）回答用户提问
//       支持真正的联网搜索（Serper API），由 LLM 自主判断是否需要搜索
// 实现方式：继承 BaseAgent，重写 ask 方法使用 OpenAI function calling
//   1. 组装 prompt：system 提示（研究助手人设）+ 上下文注入段 + 用户问题
//   2. 调用 LLM 并声明 search 工具：LLM 自主决定是否调用
//   3. 若 LLM 返回 tool_calls：执行 Serper 搜索 → 把结果回喂 LLM → 生成最终回答
//   4. 若 LLM 直接回答：返回 answer，searchUsed=false
//   5. 返回 { answer, searchUsed } 反映本轮是否真正触发了搜索
//
// 设计原则：
//   - 紧扣用户追加思考方向，不发散
//   - 联网搜索由 LLM 自主判断，用户不主动触发
//   - 回答要可被保存为"待消化的中间态"（与 saved_ai_replies 表配合）
//   - 诚实表达：不确定的内容要明确说明，搜索结果要标注来源

import BaseAgent from './baseAgent.js';
import { AGENT_TYPES, getOpenAIClient } from '../services/openai.js';
import { getTemperature } from '../config/modelConfig.js';
import { searchWeb, formatSearchResults } from '../services/searchService.js';

// 关闭 DeepSeek 思考模式的请求参数
// 背景：deepseek-v4-pro 默认开启思考模式（thinking.type=enabled），思考期间不输出 content，
//   思考完成后才一次性输出最终回答，导致前端"等几秒后一口气蹦出来"的假流式现象；
//   对话场景需要真流式逐字输出，故关闭思考。仅本 Agent 使用，其他 Agent（Crystallize/Epitaxy/Coalesce）不受影响。
// 实现：extra_body 确保 provider-specific 参数透传到 DeepSeek 后端（SDK v4 可能过滤顶层未知字段）
const NO_THINKING = {
  extra_body: {
    thinking: { type: 'disabled' }
  }
};

class ConversationAgent extends BaseAgent {
  constructor() {
    super('ConversationAgent', '基于灵感上下文回答用户追问，支持联网搜索');
    this.type = AGENT_TYPES.CONVERSATION;
    // 系统提示词：定义 AIRA 研究助手的人设与边界
    // v9：新增"输出标记"段——要求 AI 用 [CORE]...[/CORE] 标签包裹本轮最核心的 1-3 句话
    //   标签内容选取标准：直接回应本轮用户提问/观点的论断（与用户发言紧密相扣）
    //   前端会从流末文本中解析标签，提取 core（核心）与 context（阐释），实现分层折叠展示
    //   注意：标签对用户不可见（前端渲染时过滤），但 AI 自身需保证标签内语句语义完整
    this.systemPrompt = `你是 AIRA 系统的研究伙伴，基于用户的灵感上下文回应她的思考。

## 核心原则
1. **紧扣上下文**：回应基于灵感原文、结晶体、追加思考与已有评论，不要发散到无关领域
2. **不要复述用户已知的内容**：灵感原文、结晶结构、之前写过的评论——这些用户比你熟悉。只在你看到的、用户可能忽略的地方用力
3. **联网搜索**：当涉及最新信息（研究进展、产品现状、时事动态）时调用 search 工具；纯概念探讨不搜索
4. **诚实表达**：不确定的内容明确说"我不确定"，不要编造事实；引用搜索结果时标注来源

## 回复结构
- 第一段直接说出你看到的最核心的洞察，不要铺垫、不要复述用户的话，不要先说"这很有意思"
- 后续段落按需展开，把你觉得最值得说的放在前面
- 如果发现用户忽略了一个关键角度，用一个问题收尾；如果用户已经推动了自己的思考，不需要硬加追问

## 输出格式
纯文本，可使用 Markdown 的自然分段和加粗。引用搜索来源时在论述后标注 [来源N]，末尾列出参考链接。

## 输出标记（必须遵守）
每条回复中，用 [CORE]...[/CORE] 包裹最核心的 1-3 句话。标记内容选取标准：
- 这是**直接回应本轮用户提问或观点**的句子，是整个回复的逻辑锚点
- 与用户本轮发言紧密相扣——不是引言、铺垫、背景说明，也不是搜索引用
- 通常是你最想保留的那一两句论断；如果没有合适的句子（如纯闲聊），可以不标记
一条回复**最多出现一个** [CORE] 块。若整个回复就是一句话且已足够直接，可以不标记。
标签对用户不可见（前端会过滤），但你要保证标签内句子语义完整、可独立成句。`;
  }
  /**
   * 回答用户提问（支持联网搜索）
   * 功能：基于灵感上下文与对话历史，调用 LLM 生成回答；LLM 可自主触发 Serper 搜索
   * 实现方式：
   *   1. 构建 messages 数组（system + 上下文 + 历史 + 当前问题）
   *   2. 声明 search 工具，调用 LLM
   *   3. 若 LLM 返回 tool_calls：执行搜索 → 回喂结果 → 二次调用 LLM
   *   4. 返回 { answer, searchUsed }
   * @param {{question: string, context: Object, history?: Array}} input
   * @returns {Promise<{answer: string, searchUsed: boolean}>}
   */
  async ask({ question, context, history = [] }) {
    if (!question) {
      return { answer: '', searchUsed: false };
    }

    const { client, model } = getOpenAIClient(this.type);
    if (!client) throw new Error('OpenAI API key not configured for conversation agent');

    const temperature = getTemperature(this.type);
    const systemPrompt = this.systemPrompt;
    // 构建完整 messages 数组
    const contextPrompt = this._buildContextPrompt(context);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: contextPrompt },
      // 对话历史（已发生的问答对）
      ...history.map((h) => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content || ''
      })),
      // 当前用户问题
      { role: 'user', content: question }
    ];

    // 定义 search 工具：让 LLM 自主判断是否调用
    const tools = [
      {
        type: 'function',
        function: {
          name: 'search',
          description: '联网搜索最新信息。当问题涉及实时数据、研究进展、产品现状、时事动态或具体事实查证时调用。纯概念探讨或对已有上下文的解读则不需要调用。',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: '搜索查询词，用中文或英文，简洁明确'
              }
            },
            required: ['query']
          }
        }
      }
    ];

    let searchUsed = false;

    // 第一轮调用：LLM 决定是否需要搜索
    // 降级策略：若模型不支持 function calling（API 报错），回退到无 tools 调用
    let firstResponse;
    try {
      firstResponse = await client.chat.completions.create({
        model,
        messages,
        temperature,
        tools,
        ...NO_THINKING
      });
    } catch (toolsErr) {
      // tools 不被支持时（如某些模型/服务商），降级为普通对话
      console.warn(`[ConversationAgent] Tools not supported, fallback to plain chat: ${toolsErr.message}`);
      const fallbackResp = await client.chat.completions.create({ model, messages, temperature, ...NO_THINKING });
      const fallbackAnswer = fallbackResp.choices[0]?.message?.content || '';
      return { answer: fallbackAnswer, searchUsed: false };
    }

    const firstChoice = firstResponse.choices[0];
    const toolCalls = firstChoice?.message?.tool_calls;

    // 若 LLM 没有调用工具，直接返回回答
    if (!toolCalls || toolCalls.length === 0) {
      const answer = firstChoice?.message?.content || '';
      return { answer, searchUsed: false };
    }

    // LLM 触发了搜索：执行所有 tool_calls（可能多次搜索）
    // 把 assistant 的 tool_calls 消息追加到对话
    messages.push(firstChoice.message);

    for (const toolCall of toolCalls) {
      if (toolCall.function.name === 'search') {
        // 解析 LLM 传来的查询词
        let searchQuery = '';
        try {
          const args = JSON.parse(toolCall.function.arguments);
          searchQuery = args.query || '';
        } catch {
          // JSON 解析失败时跳过该次搜索
          console.warn('[ConversationAgent] Failed to parse search args:', toolCall.function.arguments);
        }

        // 执行 Serper 搜索
        let searchResults = [];
        if (searchQuery) {
          this.log(`Searching web: "${searchQuery}"`);
          searchResults = await searchWeb(searchQuery);
          searchUsed = true; // 标记本轮真正触发了搜索
        }

        // 把搜索结果作为 tool 角色消息回喂给 LLM
        const formattedResults = formatSearchResults(searchResults);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: searchResults.length > 0
            ? `搜索结果：\n\n${formattedResults}`
            : '搜索未返回结果，请基于已有上下文回答。'
        });
      }
    }

    // 第二轮调用：LLM 基于搜索结果生成最终回答
    const secondResponse = await client.chat.completions.create({
      model,
      messages,
      temperature,
      ...NO_THINKING
    });

    const answer = secondResponse.choices[0]?.message?.content || '';
    return { answer, searchUsed };
  }

  /**
   * 流式回答用户提问（支持联网搜索 + 真流式输出）
   * 功能：与 ask() 逻辑一致，但两轮 LLM 调用都使用 stream:true，
   *       通过 onDelta 回调实时传出 delta.content，前端逐字渲染
   * 实现方式：
   *   1. 第一轮（判断是否搜索）使用 stream:true + tools：
   *      - 累积 delta.content → 实时 onDelta 传出（无搜索时这就是最终回答）
   *      - 累积 delta.tool_calls → 流末拼接为完整 tool_calls 数组
   *   2. 若流末无 tool_calls：第一轮已把 answer 全部流式传出，直接返回
   *   3. 若有 tool_calls：执行搜索 → 第二轮 stream:true，继续 onDelta 传出最终回答
   *   4. tools 不支持时降级为普通 stream 对话
   * @param {{question: string, context: Object, history?: Array, onDelta?: (chunk: string) => void}} input
   * @returns {Promise<{answer: string, searchUsed: boolean}>}
   */
  async askStream({ question, context, history = [], onDelta }) {
    if (!question) {
      return { answer: '', searchUsed: false };
    }

    const { client, model } = getOpenAIClient(this.type);
    if (!client) throw new Error('OpenAI API key not configured for conversation agent');

    const temperature = getTemperature(this.type);
    const systemPrompt = this.systemPrompt;
    const contextPrompt = this._buildContextPrompt(context);
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'system', content: contextPrompt },
      ...history.map((h) => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content || ''
      })),
      { role: 'user', content: question }
    ];

    const tools = [
      {
        type: 'function',
        function: {
          name: 'search',
          description: '联网搜索最新信息。当问题涉及实时数据、研究进展、产品现状、时事动态或具体事实查证时调用。纯概念探讨或对已有上下文的解读则不需要调用。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '搜索查询词，用中文或英文，简洁明确' }
            },
            required: ['query']
          }
        }
      }
    ];

    let searchUsed = false;

    // 第一轮：stream:true + tools 同时启用
    // delta.content 实时传出；delta.tool_calls 逐块累积，流末拼接判断是否搜索
    let firstContent = '';
    /** @type {Map<number, {id?:string, function:{name:string, arguments:string}}>} */
    const toolCallAcc = new Map();

    let firstStream;
    try {
      firstStream = await client.chat.completions.create({
        model,
        messages,
        temperature,
        tools,
        stream: true,
        ...NO_THINKING
      });
    } catch (toolsErr) {
      // 降级：tools 不被支持时，改用普通 stream 对话，直接通过 onDelta 传出
      console.warn(`[ConversationAgent] Tools not supported, fallback to plain stream chat: ${toolsErr.message}`);
      const stream = await client.chat.completions.create({ model, messages, temperature, stream: true, ...NO_THINKING });
      let answer = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        // 防御性过滤：跳过纯 reasoning_content（DeepSeek 思考模式未正确关闭时的兜底）
        // 仅在有 content 且无 reasoning_content 时输出
        const hasReasoning = !!(delta.reasoning_content);
        if (hasReasoning) continue;
        const text = delta.content || '';
        if (text) {
          answer += text;
          if (onDelta) onDelta(text);
        }
      }
      return { answer, searchUsed: false };
    }

    // 遍历第一轮流：累积 content 与 tool_calls
    // 防御性过滤：跳过含 reasoning_content 的 chunk（DeepSeek 思考模式兜底）
    for await (const chunk of firstStream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      const hasReasoning = !!(delta.reasoning_content);
      if (hasReasoning && !delta.content && !delta.tool_calls) continue;

      // 1. content delta：直接 onDelta 传出（无搜索场景下这就是最终回答）
      if (delta.content && !hasReasoning) {
        firstContent += delta.content;
        if (onDelta) onDelta(delta.content);
      }

      // 2. tool_calls delta：按 index 累积（id 只在首块出现，name/arguments 逐块拼接）
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallAcc.has(idx)) {
            toolCallAcc.set(idx, { function: { name: '', arguments: '' } });
          }
          const acc = toolCallAcc.get(idx);
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.function.name += tc.function.name;
          if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
        }
      }
    }

    // 拼接完整 tool_calls 数组（过滤掉无 id 且无 name 的空累积）
    const firstToolCalls = Array.from(toolCallAcc.values())
      .filter((tc) => tc.id || tc.function.name);

    // 情况 A：LLM 没调用工具，第一轮已通过流式输出完整 answer
    if (firstToolCalls.length === 0) {
      return { answer: firstContent, searchUsed: false };
    }

    // 情况 B：LLM 触发了搜索，把第一轮的 assistant 消息（含 content + tool_calls）追加到 messages
    // 注意：content 为空时传 null（OpenAI 规范要求 tool_calls 场景 content 可为 null）
    messages.push({
      role: 'assistant',
      content: firstContent || null,
      tool_calls: firstToolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments }
      }))
    });

    for (const toolCall of firstToolCalls) {
      if (toolCall.function.name === 'search') {
        let searchQuery = '';
        try {
          const args = JSON.parse(toolCall.function.arguments);
          searchQuery = args.query || '';
        } catch {
          console.warn('[ConversationAgent] Failed to parse search args:', toolCall.function.arguments);
        }

        let searchResults = [];
        if (searchQuery) {
          this.log(`Searching web: "${searchQuery}"`);
          searchResults = await searchWeb(searchQuery);
          searchUsed = true;
        }

        const formattedResults = formatSearchResults(searchResults);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: searchResults.length > 0
            ? `搜索结果：\n\n${formattedResults}`
            : '搜索未返回结果，请基于已有上下文回答。'
        });
      }
    }

    // 第二轮：stream:true 真流式生成最终回答
    const secondStream = await client.chat.completions.create({
      model,
      messages,
      temperature,
      stream: true,
      ...NO_THINKING
    });

    // answer 包含第一轮已输出的 content（部分模型会先说话再调用工具）
    let answer = firstContent;
    for await (const chunk of secondStream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      const hasReasoning = !!(delta.reasoning_content);
      if (hasReasoning) continue;
      const text = delta.content || '';
      if (text) {
        answer += text;
        if (onDelta) onDelta(text);
      }
    }

    return { answer, searchUsed };
  }

  /**
   * 构建上下文 prompt（不含用户问题，作为单独 system 消息注入）
   * 功能：将上下文（标题/原文/crystal/追加条目/评论/对话历史）拼接为结构化文本
   * 实现方式：模板拼接 + 分块标注，缺失的上下文字段静默跳过
   * @private
   * @param {{title?:string, content?:string, crystal?:Object|null, addendum?:Object|null, comments?:Array}} context
   * @returns {string}
   */
  _buildContextPrompt(context = {}) {
    const sections = [];

    // 1. 灵感标题与原文
    if (context.title) {
      sections.push(`【灵感标题】\n${context.title}`);
    }
    if (context.content) {
      sections.push(`【灵感原文】\n${context.content}`);
    }

    // 2. 结晶体（crystal，JSON 字符串化，缺失时跳过）
    if (context.crystal) {
      try {
        const crystalStr = typeof context.crystal === 'string'
          ? context.crystal
          : JSON.stringify(context.crystal, null, 2);
        sections.push(`【结晶体】\n${crystalStr}`);
      } catch {
        // 序列化失败时跳过，不阻塞 prompt 构建
      }
    }

    // 3. 当前追加主帖
    if (context.addendum && context.addendum.content) {
      const addendumLines = [`【当前追加条目】`];
      addendumLines.push(context.addendum.content);
      // 附带的链接与图片信息（仅文件名/URL，不内嵌二进制）
      if (Array.isArray(context.addendum.links) && context.addendum.links.length > 0) {
        addendumLines.push(`附带链接：\n${context.addendum.links.join('\n')}`);
      }
      if (Array.isArray(context.addendum.images) && context.addendum.images.length > 0) {
        addendumLines.push(`附带图片：${context.addendum.images.join(', ')}`);
      }
      sections.push(addendumLines.join('\n'));
    }

    // 4. 已有评论
    if (Array.isArray(context.comments) && context.comments.length > 0) {
      const commentsText = context.comments
        .map((c, i) => `[评论${i + 1}] ${c.content || ''}`)
        .join('\n');
      sections.push(`【已有评论】\n${commentsText}`);
    }

    return sections.length > 0
      ? `以下是用户的灵感上下文，请基于此回答问题：\n\n${sections.join('\n\n')}`
      : '';
  }
}

export default ConversationAgent;
