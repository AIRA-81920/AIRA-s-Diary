// AssimilateAgent 消化 Agent（C 方案）
// 功能：收集灵感的"新内容"（追加条目 + 外延词块 + 对话产物），
//   AI 判断每条内容的分量——材料性补充 → 挂到 crystal 对应概念下；
//   改写性发现 → 生成旧值→新值 diff 提议，交用户审阅确认。
// 实现：
//   - 继承 BaseAgent，复用 generate / _parseJSON / _extractContent
//   - 使用 CRYSTALLIZE 类型（需要较强推理 + 对定义的精准理解）
//   - 不直接修改 crystal 文件——只生成提议；用户确认后由 controller 调 saveAssimilation 落盘
import BaseAgent from './baseAgent.js';
import { AGENT_TYPES } from '../services/openai.js';
import { all } from '../database/db.js';
import { getCrystallizeLatest } from '../services/inspirationStorage.js';

class AssimilateAgent extends BaseAgent {
  constructor() {
    super('AssimilateAgent', '消化 Agent：把新内容消化回 crystal 核心定义');
    this.type = AGENT_TYPES.CRYSTALLIZE; // 复用结晶类型，需要较强推理
    this.systemPrompt = `你是 AIRA 的消化师。

## 你的角色
用户的灵感在结晶之后定义就定型了，但后续不断有新内容追加进来（追加笔记、外延词块、对话产物）。
你的任务是审视这些新内容，判断它们对核心定义的分量：

1. **材料性**（material）：是证据、案例、补充说明——不改定义，但能丰富定义的支撑。挂到 crystal 的对应字段下。
2. **改写性**（revision）：新内容足以改变定义本身——某个概念需要扩展、某个区分需要修正、某个特征需要新增。
3. **无需消化**（no_change）：泛泛的记录、与核心定义无关的闲聊——不值得消化，跳过。

## 输出格式
严格输出 JSON，不要任何额外文字：
{
  "revisions": [
    {
      "field": "crystal 中的字段名（如 definition / distinction / origin / signature_features / applicable_context / evolution）",
      "old_summary": "旧值的核心意思一句话概括",
      "new_value": "改写后的完整新值（字符串则直接写，数组则写完整数组）",
      "reason": "为什么要改——哪条新内容提供了什么信息让你认为定义需要进化",
      "source_ids": ["来源内容ID列表"]
    }
  ],
  "materials": [
    {
      "content": "材料的简短摘要（≤50字）",
      "source_type": "addendum|chunk|reply",
      "source_id": "来源ID",
      "target_field": "建议挂到 crystal 的哪个字段下",
      "note": "这条材料对定义的支撑点是什么"
    }
  ],
  "no_change": ["不值得消化的内容ID列表"]
}

## 判断原则
- **保守改写**：只有新内容确实提供了定义中缺失或需要修正的信息时才提议改写。模糊的、感想性的追加不构成改写理由。
- **不改的 > 改的**：大部分新内容应该是材料性的或无需消化的。如果所有条目都是改写性，说明你太激进了。
- **新值完整**：new_value 必须是改写后该字段的完整内容，不是片段补丁。
- **source_ids 准确**：每条提议必须标注来源，用户据此判断是否采信。
- **数组字段**：如果 field 是数组（如 signature_features），new_value 应是在旧数组基础上增删后的完整数组。`;
  }

  /**
   * 收集灵感的未消化新内容
   * 功能：查询 addenda / chunks / replies 中 digested_at IS NULL 的记录
   * @param {string} inspirationId - 灵感 ID
   * @returns {{addenda, chunks, replies, total}} 未消化内容列表
   */
  collectNewContent(inspirationId) {
    // 查询未消化的追加条目
    const addenda = all(
      `SELECT id, content, links_json, created_at FROM inspiration_addenda
       WHERE inspiration_id = ? AND digested_at IS NULL ORDER BY created_at ASC`,
      [inspirationId]
    );
    // 查询未消化的外延词块
    const chunks = all(
      `SELECT id, chunk_text, chunk_kind, chunk_subkind, user_note FROM knowledge_chunks
       WHERE inspiration_id = ? AND digested_at IS NULL ORDER BY selected_at ASC`,
      [inspirationId]
    );
    // 查询未消化的对话产物
    const replies = all(
      `SELECT id, question, answer, core FROM saved_ai_replies
       WHERE inspiration_id = ? AND digested_at IS NULL ORDER BY saved_at ASC`,
      [inspirationId]
    );
    return { addenda, chunks, replies, total: addenda.length + chunks.length + replies.length };
  }

  /**
   * 分析新内容并生成消化提议
   * 功能：收集新内容 + 当前 crystal → LLM 分析 → 返回结构化提议
   * @param {string} inspirationId - 灵感 ID
   * @returns {{success, data?, error?}} 提议结果
   */
  async analyze(inspirationId) {
    // 1. 读取最新 crystal
    const crystalData = await getCrystallizeLatest(inspirationId);
    if (!crystalData || !crystalData.crystal) {
      return { success: false, error: '该灵感尚未结晶，无核心定义可消化' };
    }
    const crystal = crystalData.crystal;

    // 2. 收集未消化新内容
    const { addenda, chunks, replies, total } = this.collectNewContent(inspirationId);
    if (total === 0) {
      return { success: false, error: '没有新的待消化内容' };
    }
    this.log(`Collected ${total} undigested items (${addenda.length} addenda, ${chunks.length} chunks, ${replies.length} replies)`);

    // 3. 构建 prompt
    const prompt = this._buildPrompt(crystal, addenda, chunks, replies);

    // 4. 调用 LLM
    this.log('Sending assimilation analysis to LLM...');
    const response = await this.generate(prompt, this.systemPrompt);
    const content = this._extractContent(response);
    const parsed = this._parseJSON(content);

    // 5. 校验返回结构
    if (parsed.error || (!parsed.revisions && !parsed.materials)) {
      this.log('LLM returned invalid structure, raw content length: ' + content.length);
      return { success: false, error: 'AI 分析结果解析失败，请重试' };
    }

    // 6. 补全 source_ids / source_id 的来源类型标记（防止 LLM 遗漏）
    const allIds = [
      ...addenda.map((a) => a.id),
      ...chunks.map((c) => c.id),
      ...replies.map((r) => r.id),
    ];
    const revisions = (parsed.revisions || []).map((r) => ({
      ...r,
      source_ids: (r.source_ids || []).filter((id) => allIds.includes(id)),
    }));
    const materials = (parsed.materials || []).map((m) => ({
      ...m,
      source_id: allIds.includes(m.source_id) ? m.source_id : null,
    })).filter((m) => m.source_id);
    const noChange = (parsed.no_change || []).filter((id) => allIds.includes(id));

    this.log(`Analysis complete: ${revisions.length} revisions, ${materials.length} materials, ${noChange.length} no_change`);

    return {
      success: true,
      data: {
        revisions,
        materials,
        no_change: noChange,
        crystal,        // 当前 crystal（前端展示旧值用）
        total_sources: total,
      },
    };
  }

  /**
   * 构建消化分析 prompt
   * 功能：把当前 crystal + 所有未消化新内容组装成 LLM 可读的 prompt
   * @param {object} crystal - 当前 crystal 对象
   * @param {Array} addenda - 未消化追加条目
   * @param {Array} chunks - 未消化词块
   * @param {Array} replies - 未消化对话产物
   * @returns {string} 完整 prompt
   */
  _buildPrompt(crystal, addenda, chunks, replies) {
    // crystal 各字段摘要
    const crystalStr = JSON.stringify(crystal, null, 2);

    // 追加条目
    const addendaStr = addenda.map((a) => {
      let links = '';
      try { const linksArr = JSON.parse(a.links_json || '[]'); if (linksArr.length) links = `\n  链接: ${linksArr.join(', ')}`; } catch {}
      return `[追加#${a.id}] (${a.created_at})\n  ${a.content}${links}`;
    }).join('\n\n');

    // 外延词块
    const chunksStr = chunks.map((c) => {
      const note = c.user_note ? ` 用户备注: ${c.user_note}` : '';
      return `[词块#${c.id}] (${c.chunk_kind}/${c.chunk_subkind || '无'})\n  ${c.chunk_text}${note}`;
    }).join('\n\n');

    // 对话产物
    const repliesStr = replies.map((r) => {
      const core = r.core ? `\n  核心观点: ${r.core}` : '';
      return `[对话#${r.id}]\n  问: ${r.question}\n  答: ${r.answer}${core}`;
    }).join('\n\n');

    return `## 当前核心定义（crystal）
${crystalStr}

## 待消化的新内容

### 追加笔记（${addenda.length} 条）
${addendaStr || '（无）'}

### 外延词块（${chunks.length} 条）
${chunksStr || '（无）'}

### 对话产物（${replies.length} 条）
${repliesStr || '（无）'}

## 任务
审视上述新内容，判断每条对核心定义的分量。
- 哪些是**材料性**的——是定义的证据/案例/补充，挂到 crystal 对应字段下即可
- 哪些是**改写性**的——提供了定义中缺失或需要修正的信息，提议改写定义的某个字段
- 哪些**无需消化**——与核心定义无关，跳过

按指定 JSON 格式输出，不要输出任何其他文字。`;
  }
}

export default AssimilateAgent;
