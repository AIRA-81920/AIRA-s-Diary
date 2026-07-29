// EpitaxyAgent — 灵感外延 Agent
// 功能：基于结晶体生成方向提案 → 深挖笔记（含可点击词块）→ 用户选词提炼
// 实现方式：继承 BaseAgent，三阶段分别构建 prompt 调用 LLM
//
// 状态机：empty → proposing → proposing_done → excavating → excavating_done → distilled
//   - propose：基于 crystal 生成 3-5 张方向卡片
//   - excavate：用户选某方向后，生成 4-6 个研究笔记片段，每段含可点击词块
//   - distill：用户选词块后存入 knowledge_chunks 表（由 controller 处理存储，Agent 只负责生成）

import BaseAgent from './baseAgent.js';
import { AGENT_TYPES } from '../services/openai.js';
import { db, saveDb } from '../database/db.js';
import { v4 as uuidv4 } from 'uuid';
import { FRAGMENT_TEMPLATES, FRAGMENT_META, FRAGMENT_TYPE_VALUES } from '../config/constants.js';

// 词块类型枚举
export const CHUNK_KINDS = {
  REFERENCE: 'reference',  // 引用：人名/作品/事件
  TECHNIQUE: 'technique',  // 技法：方法/手法
  IMAGERY:   'imagery',    // 意象：感官画面
  CONCEPT:   'concept',    // 概念：抽象思想
  WARNING:   'warning',    // 陷阱：风险提示
  MATERIAL:  'material'    // 素材：可用资源
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
    this.systemPrompt = `你是 AIRA 的外延探究师，擅长从用户的灵感结晶出发，找到最有价值的延伸方向。

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
      const result = await this.generate(prompt, this.systemPrompt);
      const content = this._extractContent(result);
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
      try {
        await this.saveResult(inspirationId, 'epitaxy/excavations', {
          proposal_id: proposalId,
          proposal_direction: proposal?.direction,
          fragments: savedFragments
        });
      } catch (saveErr) {
        console.warn('[EpitaxyAgent] Failed to save excavation to storage:', saveErr.message);
      }

      return { success: true, data: { fragments: savedFragments } };
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

## 返回 JSON 格式（严格遵守）
{
  "fragments": [
    {
      "id": "f1",
      "type": ${fragTypeEnum},
      "title": "片段标题",
      "full_text": "完整的笔记正文...",
      "chunks": [
        {"id": "c1", "text": "词块原文", "kind": "reference", "subkind": "细分标签"},
        {"id": "c2", "text": "词块原文", "kind": "technique", "subkind": "细分标签"}
      ]
    }
  ]
}`;
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
