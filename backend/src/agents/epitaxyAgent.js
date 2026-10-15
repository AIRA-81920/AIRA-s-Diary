// EpitaxyAgent — 灵感外延 Agent
// 功能：基于结晶体生成方向提案 → 深挖笔记（含可点击词块）→ 用户选词提炼
// 实现方式：继承 BaseAgent，三阶段分别构建 prompt 调用 LLM
//
// 状态机：empty → proposing → proposing_done → excavating → excavating_done → distilled
//   - propose：基于 crystal 生成 3-5 张方向卡片
//   - excavate：用户选某方向后，生成 4-6 个研究笔记片段，每段含可点击词块
//   - distill：用户选词块后存入 knowledge_chunks 表（由 controller 处理存储，Agent 只负责生成）

import BaseAgent from './baseAgent.js';
import { AGENT_TYPES, getOpenAIClient, withRetry, withTimeout } from '../services/openai.js';
import { getTemperature } from '../config/modelConfig.js';
import { db, saveDb } from '../database/db.js';
import { v4 as uuidv4 } from 'uuid';
import { FRAGMENT_TEMPLATES, FRAGMENT_META, FRAGMENT_TYPE_VALUES } from '../config/constants.js';
import { searchWeb, formatSearchResults } from '../services/searchService.js';

// 词块类型枚举
export const CHUNK_KINDS = {
  REFERENCE: 'reference',  // 引用：人名/作品/事件
  TECHNIQUE: 'technique',  // 技法：方法/手法
  IMAGERY:   'imagery',    // 意象：感官画面
  CONCEPT:   'concept',    // 概念：抽象思想
  WARNING:   'warning',    // 陷阱：风险提示
  MATERIAL:  'material'    // 素材：可用资源
};

// ========== 联网考据相关常量（epitaxy 联网改造）==========

// 关闭 DeepSeek 思考模式的请求参数（与 ConversationAgent 保持一致）
// 背景：思考模式期间不输出 content，表现为"等几秒后一口气蹦出来"；联网多轮会进一步拉长等待
const NO_THINKING = { extra_body: { thinking: { type: 'disabled' } } };

// 单次 LLM 调用超时（毫秒）：与 BaseAgent 的 LLM_TIMEOUT_MS 保持一致
const LLM_TIMEOUT_MS = 120000;

// 搜索轮次上限：深挖一次最多允许 LLM 联网考据 3 轮
// 目的：成本与耗时可控——达到上限后强制进入"输出最终 JSON"的一轮
const MAX_SEARCH_ROUNDS = 3;

// 搜索**总次数**上限（实跑发现）：一轮响应可能并行返回多个 tool_calls，
// 仅靠轮次上限挡不住搜索次数失控（1 轮 × N 个 tool_calls），故再加一道总次数闸
const MAX_SEARCHES = 6;

// 联网考据的整体时间预算（毫秒）：耗尽后不再允许新的搜索轮，直接产出结果
const SEARCH_BUDGET_MS = 150000;

// search 工具声明：把联网能力以 function calling 形式交给 LLM，由它自己判断"要不要查、查什么"
// 与 ConversationAgent 的同名工具保持同构，仅把描述改为面向"考据"场景
const SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'search',
    description: '联网搜索以查证真实存在的具体事物。当你要写出具体的人名、作品名、流派名、技法名、真实案例、产品或需要确认某个领域的现状与数据时调用；纯粹的意象构造与概念推演不需要调用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索查询词，用中文或英文，简洁明确（一次只解决一个查证点）' }
      },
      required: ['query']
    }
  }
};

// 获取指定灵感类型的合法 fragment_type 列表
// 功能：按 inspiration_type 从 FRAGMENT_TEMPLATES 取对应 4 种 fragment_type；
//       未知类型回退到兜底"其他"
// 实现方式：FRAGMENT_TEMPLATES[inspirationType] || FRAGMENT_TEMPLATES['其他']
// K4 改造：新增 selectedDimensions / detectedCapsule 参数（初版暂不分叉，保留参数兼容性）
//          未来可按 selectedDimensions 中的特定维度选择不同的 fragment_type 集合
function getFragmentTypesFor(inspirationType, selectedDimensions = [], detectedCapsule = []) {
  // K4 TODO：按 selectedDimensions 分叉 fragment_type
  // 初版简化：仍按 inspirationType 返回，待 constants.js 中新增 FRAGMENT_TEMPLATES_BY_DIMENSION 后再实现
  return FRAGMENT_TEMPLATES[inspirationType] || FRAGMENT_TEMPLATES['其他'];
}

class EpitaxyAgent extends BaseAgent {
  constructor() {
    super('EpitaxyAgent', '方向提案 → 深挖笔记 → 选词提炼');
    this.type = AGENT_TYPES.EPITAXY;
    // 系统提示词：定义外延探究师的人设与原则
    // v2（联网考据）：人设从"凭记忆的博学助手"升级为"会去查证的探究者"。
    //   角色定位——epitaxy 在这套软件里是「考据者」：把用户的结晶体放进真实世界的知识网络，
    //   替她查证与补齐（真实的先例/作品/技法/素材/坑），而不是替她发明。
    //   因此凡是"具体存在的东西"必须先查、不许编；产出的词块是被提炼、沉淀、再长成新灵感的知识原子，
    //   真实性比华丽更重要。
    this.systemPrompt = `你是 AIRA 的外延探究师——一位**会去查证的**探究者，擅长从用户的灵感结晶出发，找到最有价值的延伸方向，并把它放进真实世界的知识网络里。

## 你的角色（重要）
外延探究不是替用户"发明"，而是替用户"查证与补齐"：找到真实存在的先例、真实的作品与技法、可用的素材、需要警惕的坑。
- 你拥有联网搜索能力（search 工具），凡是涉及**真实存在的具体事物**，先查再写
- 宁可说"我没有查到"，也绝不编造一个看起来像真的名字
- 你的产出（词块）会被用户提炼沉淀、再长成新灵感——所以**真实**比**华丽**更重要

## 核心原则
1. **基于灵感本身**：每个提案必须给出"为什么从这个灵感出发值得探究这个方向"
2. **具象而非抽象**：方向要具体到可操作的程度，不是"探索视觉化"而是"爵士的几何形态"
3. **多样性**：3-5 个方向应覆盖不同维度（延伸/反向/跨界/技术/文化）
4. **词块精准**：深挖笔记中的词块必须是值得用户提炼的概念，不是随便标
5. **词块 kind 准确**：reference=引用（人名/作品/事件），technique=技法，imagery=意象，concept=概念，warning=陷阱，material=素材

## 响应必须是 JSON，且严格遵守对应 stage 的输出格式`;
  }

  // 阶段 A：Propose — 生成方向卡片
  // 功能：基于灵感和结晶体，生成 3-5 个探究方向
  // 实现方式：构建 propose prompt → 调用 LLM → 解析 JSON → 写入 epitaxy_proposals 表
  // K4 改造：新增 detectedCapsule 参数，透传给 _buildProposePrompt 注入胶囊信息
  async propose(inspirationId, crystal, inspirationContent, inspirationType, detectedCapsule = []) {
    try {
      const prompt = this._buildProposePrompt(crystal, inspirationContent, inspirationType, detectedCapsule);
      const result = await this.generate(prompt, this.systemPrompt);
      const content = this._extractContent(result);
      const parsed = this._parseJSON(content);

      // 确保 proposals 是数组
      const proposals = Array.isArray(parsed.proposals) ? parsed.proposals : [];

      // K3-g 修复：生成新 proposals 前，先清除该灵感的旧 pending proposals
      // 功能：避免重复调用 propose 导致 pending 卡片无限累积（用户多次进抽屉场景）
      // 实现方式：DELETE WHERE status='pending'，保留 selected/distilled 历史（已深挖的不清除）
      try {
        db.run(
          'DELETE FROM epitaxy_proposals WHERE inspiration_id = ? AND status = ?',
          [inspirationId, 'pending']
        );
      } catch (delErr) {
        console.warn('[EpitaxyAgent] Failed to clear pending proposals:', delErr.message);
      }

      // 写入 epitaxy_proposals 表
      const savedProposals = [];
      for (const p of proposals) {
        const id = uuidv4();
        try {
          db.run(
            'INSERT INTO epitaxy_proposals (id, inspiration_id, direction, reasoning, expected_yield, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [id, inspirationId, p.direction || '', p.reasoning || '', p.expected_yield || '', 'pending', new Date().toISOString()]
          );
          savedProposals.push({ id, ...p, status: 'pending' });
        } catch (dbErr) {
          console.warn('[EpitaxyAgent] Failed to insert proposal:', dbErr.message);
        }
      }
      saveDb();

      // 保存到文件存储
      try {
        await this.saveResult(inspirationId, 'epitaxy/proposals', { proposals: savedProposals });
      } catch (saveErr) {
        console.warn('[EpitaxyAgent] Failed to save proposals to storage:', saveErr.message);
      }

      return { success: true, data: { proposals: savedProposals } };
    } catch (e) {
      this.log(`propose failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // 阶段 B：Excavate — 深挖某方向
  // 功能：根据选中的方向，生成 4-6 个研究笔记片段，每段含可点击词块
  // 实现方式：构建 excavate prompt → 调用 LLM → 解析 JSON → 写入 epitaxy_fragments 表
  // K3-g：inspirationType 决定 fragment_type 取值集合（架构 §10.5）
  async excavate(inspirationId, proposalId, proposal, crystal, inspirationContent, inspirationType) {
    try {
      const prompt = this._buildExcavatePrompt(proposal, crystal, inspirationContent, inspirationType);
      // v2（联网考据）：改为「function calling 多轮」生成——LLM 可自主调用 search 工具查证后再落笔。
      // 返回 { content, searches }；searches 记录本次实际执行的搜索，用于落盘留痕与前端提示。
      const { content, searches } = await this._generateWithSearch(prompt, this.systemPrompt);
      const parsed = this._parseJSON(content);

      // 确保 fragments 是数组
      const fragments = Array.isArray(parsed.fragments) ? parsed.fragments : [];

      // K3-g：取本灵感类型对应的合法 fragment_type 集合（4 种）
      const allowedTypes = new Set(getFragmentTypesFor(inspirationType));

      // 写入 epitaxy_fragments 表
      const savedFragments = [];
      for (const f of fragments) {
        const id = uuidv4();
        // K3-g：fragment_type 校验——若 LLM 输出不在允许集合内，回退到第一项（避免 schema 漂移）
        const fragType = allowedTypes.has(f.type) ? f.type : [...allowedTypes][0];
        // 给每个 chunk 的 id 加上 fragment_id 前缀，避免跨 fragment 的 c1/c2 冲突
        // 功能：确保 chunk id 在整个灵感内全局唯一
        // 实现方式：用 fragment 的 uuid 截取前 8 位作为前缀 + 原 chunk id
        const uniqueChunks = (f.chunks || []).map((c, cIdx) => ({
          ...c,
          id: c.id ? `${id.slice(0, 8)}_${c.id}` : `${id.slice(0, 8)}_c${cIdx + 1}`
        }));
        const chunksJson = JSON.stringify(uniqueChunks);
        try {
          db.run(
            'INSERT INTO epitaxy_fragments (id, inspiration_id, proposal_id, fragment_type, title, full_text, chunks_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [id, inspirationId, proposalId, fragType, f.title || '', f.full_text || '', chunksJson, new Date().toISOString()]
          );
          // fix：id 必须放在 ...f 之后，否则 LLM 输出的原始 id（如 "f1"）会覆盖 UUID
          // 前端拿到的 fragment.id 必须是 UUID，否则 knowledge_chunks.fragment_id 存的是 "f1"，
          // archiveService 查询 WHERE fragment_id IN (UUID列表) 匹配不到，导致已提炼词块不显示
          savedFragments.push({ ...f, id, type: fragType, chunks: uniqueChunks, proposal_id: proposalId });
        } catch (dbErr) {
          console.warn('[EpitaxyAgent] Failed to insert fragment:', dbErr.message);
        }
      }
      saveDb();

      // 更新 proposal 状态为 selected
      try {
        db.run('UPDATE epitaxy_proposals SET status = ? WHERE id = ?', ['selected', proposalId]);
        saveDb();
      } catch (dbErr) {
        console.warn('[EpitaxyAgent] Failed to update proposal status:', dbErr.message);
      }

      // 保存到文件存储
      // v2：把本次联网考据的搜索痕（query + 命中来源）一并落盘；无搜索时不写该键
      try {
        await this.saveResult(inspirationId, 'epitaxy/excavations', {
          proposal_id: proposalId,
          proposal_direction: proposal?.direction,
          fragments: savedFragments,
          ...(searches.length > 0 ? { searches } : {})
        });
      } catch (saveErr) {
        console.warn('[EpitaxyAgent] Failed to save excavation to storage:', saveErr.message);
      }

      return { success: true, data: { fragments: savedFragments, searchUsed: searches.length > 0 } };
    } catch (e) {
      this.log(`excavate failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // 构建 Propose 阶段 prompt
  // 功能：基于结晶体和灵感内容，让 LLM 生成 3-5 个探究方向
  // K4 改造：新增 detectedCapsule 参数，注入胶囊信息（名称+标志性意象）作为方向生成的素材锚点
  _buildProposePrompt(crystal, inspirationContent, inspirationType, detectedCapsule = []) {
    // K4 新增：胶囊信息注入
    // 设计：若用户使用了设定胶囊，告知 LLM 胶囊名称与标志性意象，让方向生成利用这些意象作为素材
    let capsuleSection = '';
    if (detectedCapsule && detectedCapsule.length > 0) {
      const capsule = detectedCapsule[0];
      const imagery = capsule?.elements?.imagery;
      const imageryText = Array.isArray(imagery) ? imagery.join(', ') : (imagery || '');
      capsuleSection = `
## 设定胶囊信息
本灵感基于设定胶囊：${capsule.name || '未知胶囊'}
标志性意象：${imageryText || '无'}

方向生成时应利用这些意象作为素材锚点，但不要局限于胶囊已知内容，要延伸到胶囊之外的差异点。
`;
    }

    return `基于以下灵感和结晶体，生成 3-5 个最有价值的探究方向。

灵感原文：
${inspirationContent}

灵感类型：${inspirationType || '未知'}

结晶体：
${JSON.stringify(crystal, null, 2)}
${capsuleSection}
## 方向生成原则
1. 每个方向必须给"基于灵感本身的理由"——为什么从这个灵感出发值得探究
2. 方向要具体可操作，不是"探索视觉化"而是"爵士的几何形态"
3. 3-5 个方向应覆盖不同维度：
   - 延伸方向：灵感自然生长的方向
   - 反向方向：与灵感对立但能照亮盲区的方向
   - 跨界方向：借用其他领域的视角
   - 技术方向：实现层面的关键问题
   - 文化方向：历史/社会/美学溯源
4. 每个方向说明 expected_yield：探究后会得到什么

## 返回 JSON 格式（严格遵守）
{
  "proposals": [
    {
      "direction": "方向名称（短语）",
      "reasoning": "为什么从这个灵感出发值得探究这个方向",
      "expected_yield": "探究后会得到什么（如：可用的视觉语言/配色方案/形态参考）"
    }
  ]
}`;
  }

  // 构建 Excavate 阶段 prompt
  // 功能：基于选中的方向，生成 4-6 个研究笔记片段，每段含可点击词块
  // K3-g：按 inspiration_type 从 FRAGMENT_TEMPLATES 取 4 种 fragment_type，
  //       从 FRAGMENT_META 取每种 fragment_type 的 label 和 desc 动态构建 prompt
  // 实现方式：FRAGMENT_TEMPLATES + FRAGMENT_META 单一来源驱动（防枚举漂移，R9）
  _buildExcavatePrompt(proposal, crystal, inspirationContent, inspirationType) {
    // 取本灵感类型对应的 4 种 fragment_type
    const fragTypes = getFragmentTypesFor(inspirationType);
    // 构建片段类型说明：每种 fragment_type 的 key + 中文 label + 描述
    const fragTypeLines = fragTypes.map(t => {
      const meta = FRAGMENT_META[t] || { label: t, desc: '' };
      return `  - ${t}（${meta.label}）：${meta.desc}`;
    }).join('\n');

    // 构建合法 fragment_type 枚举（供 LLM 输出 type 字段使用）
    const fragTypeEnum = fragTypes.map(t => `"${t}"`).join(' | ');

    return `基于以下方向，生成 4-6 个研究笔记片段，每段含可点击词块。

灵感原文：
${inspirationContent}

灵感类型：${inspirationType || '未知'}

结晶体：
${JSON.stringify(crystal, null, 2)}

选中的探究方向：
${proposal?.direction || ''}
理由：${proposal?.reasoning || ''}
预期收获：${proposal?.expected_yield || ''}

## 片段生成原则
1. 生成 4-6 个片段，每个片段的 type 必须从下面给出的本灵感类型对应 4 种 fragment_type 中选择
2. 本灵感类型（${inspirationType || '未知'}）允许的 fragment_type：
${fragTypeLines}

3. 每段 full_text 是一段完整可读的笔记（50-150 字）
4. 在 full_text 中标记值得用户提炼的词块，用 chunks 数组给出
5. 词块的 text 必须是 full_text 中的原文片段
6. 词块 kind 必须准确：
   - reference：引用具体的人名/作品/事件
   - technique：具体的技法/方法/手法
   - imagery：感官画面/意象
   - concept：抽象概念/思想
   - warning：风险/陷阱/注意事项
   - material：可用的素材/资源
7. subkind 是 LLM 自由生成的细分标签（如"爵士钢琴家""钢琴技法"）

## 联网考据（你有 search 工具，用起来）
动笔之前先判断：这一点需要外部事实支撑吗？
- **必须先搜**：要写出具体的人名、作品名、流派名、技法名、真实案例、产品或事件，或某个领域的现状与数据时——先搜索确认它真实存在、名字准确
- **不必搜**：纯粹的概念推演、意象构造、对用户灵感本身的解读
搜索词要简洁（中文或英文），一次解决一个明确的查证点；一批笔记通常搜索 1-3 次即可，不要反复搜同一件事。

## 真实性铁律（违反即失败）
1. reference 类词块指向的人名/作品/事件，必须是你搜索见过、或确凿无疑的公共知识。**拿不准的不要写**。
2. 查不到时，宁可不提这个名字，也不要编造；如果这个"尚待确认的参照"本身有价值，可以把它写成 warning 类型的片段或词块，说明这里存在一个待确认的参照。
3. 词块 text 必须仍是 full_text 中的原文片段（这条老规矩不变）。

## 引入外部素材与来源
- 允许把搜到的真实材料写进笔记正文，让笔记"有据可依"，而不是空泛地泛谈。
- 凡是**基于搜索结果**写成的词块，在它身上补一个 source 字段：{"title": "来源标题", "url": "来源链接"}；纯凭公共常识写成的不必补。

## 返回 JSON 格式（严格遵守）
{
  "fragments": [
    {
      "id": "f1",
      "type": ${fragTypeEnum},
      "title": "片段标题",
      "full_text": "完整的笔记正文...",
      "chunks": [
        {"id": "c1", "text": "词块原文", "kind": "reference", "subkind": "细分标签", "source": {"title": "来源标题", "url": "https://..."}},
        {"id": "c2", "text": "词块原文", "kind": "technique", "subkind": "细分标签"}
      ]
    }
  ]
}`;
  }

  // 联网考据生成（v2 新增）
  // 功能：把 search 工具交给 LLM，由它自主决定"是否要联网查证、查什么"；
  //       执行搜索后把结果回喂，直到它不再调用工具（或达到轮次/时间上限），返回最终文本
  // 实现方式（对齐 ConversationAgent 的 function calling 模式）：
  //   1. 组装 messages（system + user prompt），声明 SEARCH_TOOL
  //   2. 循环调用：带 tools 调 LLM → 若返回 tool_calls 则逐个执行 searchWeb → 回喂 tool 消息 → 继续
  //   3. 达到 MAX_SEARCH_ROUNDS 轮或超出 SEARCH_BUDGET_MS 后，改为**不带 tools** 调用，强制收口输出最终 JSON
  //   4. 降级：模型不支持 tools（首轮即报错）时回退到普通单轮 generate —— 等同改造前的无联网行为
  // @param {string} prompt - 用户提示词（excavate prompt）
  // @param {string} systemPrompt - 系统提示词
  // @returns {Promise<{content: string, searches: Array<{query:string, results:Array<{title:string,url:string}>}>}>}
  async _generateWithSearch(prompt, systemPrompt) {
    const { client, model } = getOpenAIClient(this.type);
    if (!client) throw new Error('OpenAI API key not configured');
    const temperature = getTemperature(this.type);
    const messages = [
      { role: 'system', content: systemPrompt || this.systemPrompt },
      { role: 'user', content: prompt }
    ];
    // 落痕：本次实际执行的每次搜索（query + 命中来源的标题/链接）
    const searches = [];
    // 已执行的搜索次数：受 MAX_SEARCHES 约束（一轮可能返回多个 tool_calls）
    let searchCount = 0;
    const startedAt = Date.now();

    // 单次调用封装：withRetry 处理限流，withTimeout 防止请求无限挂起（与 BaseAgent 一致）
    const callLLM = (useTools) => {
      const req = { model, messages, temperature, ...NO_THINKING };
      if (useTools) req.tools = [SEARCH_TOOL];
      return withTimeout(withRetry(() => client.chat.completions.create(req)), LLM_TIMEOUT_MS);
    };

    // 最多 MAX_SEARCH_ROUNDS 轮"允许搜索"，之后必须收口
    for (let round = 0; round <= MAX_SEARCH_ROUNDS; round++) {
      // 是否仍允许调用工具：未到轮次上限，且未超出整体时间预算
      const withinBudget = Date.now() - startedAt < SEARCH_BUDGET_MS;
      const allowTools = round < MAX_SEARCH_ROUNDS && withinBudget;

      let response;
      try {
        response = await callLLM(allowTools);
      } catch (err) {
        // 首轮带 tools 就失败（模型/服务商不支持 function calling）→ 降级为普通单轮生成
        if (round === 0 && allowTools) {
          this.log(`tools not supported, fallback to plain generate: ${err.message}`);
          const fallback = await this.generate(prompt, systemPrompt);
          return { content: this._extractContent(fallback), searches };
        }
        throw err;
      }

      const choice = response.choices[0];
      const toolCalls = choice?.message?.tool_calls;

      // 不再允许搜索、或 LLM 没调用工具 → 这一轮的内容就是最终结果
      if (!allowTools || !toolCalls || toolCalls.length === 0) {
        return { content: choice?.message?.content || '', searches };
      }

      // LLM 要求查证：把 assistant 的 tool_calls 消息追加进对话，执行搜索并回喂结果
      // v3（提速）：同一轮的多个 tool_calls 之间互不依赖，**并发**发起搜索
      //   —— 串行时 6 次搜索会白白累加等待（实测占掉 30 秒里的大头）
      messages.push(choice.message);

      // 先按顺序分配配额，保证 MAX_SEARCHES 的取舍与串行语义一致（超出配额的查询不执行）
      const planned = toolCalls.map((toolCall) => {
        const isSearch = toolCall.function?.name === 'search';
        let query = '';
        if (isSearch) {
          try {
            query = JSON.parse(toolCall.function.arguments || '{}').query || '';
          } catch {
            // 参数解析失败则跳过本次搜索（不中断整体流程）
          }
        }
        const allowed = !!query && searchCount < MAX_SEARCHES;
        if (allowed) searchCount += 1;
        return { toolCall, query, allowed };
      });

      // 再并发执行（searchWeb 自带 10s 超时与静默降级，失败返回空数组、不会抛出）
      const executed = await Promise.all(planned.map(async (p) => {
        if (!p.allowed) return { ...p, results: [] };
        this.log(`Searching web: "${p.query}"`);
        const results = await searchWeb(p.query);
        return { ...p, results };
      }));

      // 按原顺序回喂，保持对话可读性与落痕顺序稳定
      for (const e of executed) {
        if (e.allowed) {
          // 只留标题与链接（不含 snippet），避免落盘文件与响应体膨胀
          searches.push({ query: e.query, results: e.results.map((r) => ({ title: r.title, url: r.url })) });
        }
        messages.push({
          role: 'tool',
          tool_call_id: e.toolCall.id,
          content: e.results.length > 0
            ? `搜索结果：\n\n${formatSearchResults(e.results)}`
            : (e.query && !e.allowed
                ? '本次搜索次数已达上限，请基于已有信息立即输出最终 JSON。'
                : '搜索未返回结果。请基于你确凿掌握的公共知识作答；凡无法确认的具体名字，一律不要写。')
        });
      }
    }

    // 理论上不可达（每轮都会 return）；兜底再调一次强制收口
    const finalResponse = await callLLM(false);
    return { content: finalResponse.choices[0]?.message?.content || '', searches };
  }

  // 兼容 BaseAgent.run 接口（供 agentHub.dispatch 调用）
  // 功能：根据 context.stage 决定调用 propose 还是 excavate
  // K3-g：excavate 时透传 inspirationType 给 _buildExcavatePrompt
  // K4 改造：propose 时透传 detectedCapsule 给 _buildProposePrompt（注入胶囊信息）
  async run(context) {
    const { stage, inspirationId, crystal, inspirationContent, inspirationType, proposalId, proposal, detectedCapsule } = context;
    if (stage === 'propose' || !stage) {
      return this.propose(inspirationId, crystal, inspirationContent, inspirationType, detectedCapsule || []);
    }
    if (stage === 'excavate') {
      return this.excavate(inspirationId, proposalId, proposal, crystal, inspirationContent, inspirationType);
    }
    return { success: false, error: `Unknown epitaxy stage: ${stage}` };
  }
}

// 静态便捷方法
// K4 改造：propose 静态方法新增 detectedCapsule 参数，透传给实例方法
EpitaxyAgent.propose = function(inspirationId, crystal, inspirationContent, inspirationType, detectedCapsule = []) {
  return new EpitaxyAgent().propose(inspirationId, crystal, inspirationContent, inspirationType, detectedCapsule);
};
EpitaxyAgent.excavate = function(inspirationId, proposalId, proposal, crystal, inspirationContent, inspirationType) {
  return new EpitaxyAgent().excavate(inspirationId, proposalId, proposal, crystal, inspirationContent, inspirationType);
};

export default EpitaxyAgent;
