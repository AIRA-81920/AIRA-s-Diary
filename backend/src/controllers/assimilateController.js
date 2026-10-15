// Assimilate 消化控制器（C 方案）
// 功能：处理消化相关 HTTP 请求——触发分析、用户确认/拒绝、查询状态
// 实现方式：每个方法 try/catch，成功返回 { success:true, data }，失败返回错误 JSON
//
// 端点：
//   GET  /inspirations/:id/assimilate/status — 查询待消化内容数量
//   POST /inspirations/:id/assimilate/analyze — 触发 AI 分析，返回消化提议
//   POST /inspirations/:id/assimilate/confirm — 用户确认/拒绝提议，落盘新版本 crystal

import AssimilateAgent from '../agents/assimilateAgent.js';
import { all, get, db, saveDb } from '../database/db.js';
import { saveAssimilation } from '../services/inspirationStorage.js';
import { assertUuid } from '../utils/security.js';

// Agent 单例（复用，避免每次请求 new）
const agent = new AssimilateAgent();

// 查询待消化内容状态
// 功能：返回三张表中 digested_at IS NULL 的记录数
export async function status(req, res) {
  try {
    const { id } = req.params;
    assertUuid(id, 'inspiration id');
    const addenda = get(
      'SELECT COUNT(*) as count FROM inspiration_addenda WHERE inspiration_id = ? AND digested_at IS NULL',
      [id]
    );
    const chunks = get(
      'SELECT COUNT(*) as count FROM knowledge_chunks WHERE inspiration_id = ? AND digested_at IS NULL',
      [id]
    );
    const replies = get(
      'SELECT COUNT(*) as count FROM saved_ai_replies WHERE inspiration_id = ? AND digested_at IS NULL',
      [id]
    );
    const total = (addenda?.count || 0) + (chunks?.count || 0) + (replies?.count || 0);
    res.json({ success: true, data: { total, addenda: addenda?.count || 0, chunks: chunks?.count || 0, replies: replies?.count || 0 } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.expose ? e.message : '服务器内部错误' });
  }
}

// 触发 AI 分析
// 功能：收集未消化新内容 → AssimilateAgent.analyze → 返回结构化提议
export async function analyze(req, res) {
  try {
    const { id } = req.params;
    assertUuid(id, 'inspiration id');
    const result = await agent.analyze(id);
    if (!result.success) {
      return res.status(400).json(result);
    }
    res.json(result);
  } catch (e) {
    console.error('[AssimilateController] analyze error:', e.message);
    res.status(500).json({ success: false, error: e.expose ? e.message : 'AI 分析失败，请重试' });
  }
}

// 用户确认/拒绝提议
// 功能：根据用户选择，应用改写 + 挂载证据 → 写新版本 crystal 文件 + 标记已消化内容
// body: { acceptedRevisions: [0,2], acceptedMaterials: [0,1], rejectedAll: false }
export async function confirm(req, res) {
  try {
    const { id } = req.params;
    assertUuid(id, 'inspiration id');
    const { proposal, acceptedRevisions = [], acceptedMaterials = [] } = req.body;

    if (!proposal || !proposal.crystal) {
      return res.status(400).json({ success: false, error: '缺少分析提议数据' });
    }

    // 1. 应用用户接受的改写：把 acceptedRevisions 对应的 new_value 合并进 crystal
    const crystal = JSON.parse(JSON.stringify(proposal.crystal)); // 深拷贝旧 crystal
    const assimilatedFields = [];
    const allSourceIds = [];

    for (const idx of acceptedRevisions) {
      const rev = proposal.revisions[idx];
      if (!rev || !rev.field) continue;
      crystal[rev.field] = rev.new_value;
      assimilatedFields.push(rev.field);
      if (rev.source_ids) allSourceIds.push(...rev.source_ids);
    }

    // 2. 构建 evidence 列表：用户接受的材料挂到 evidence 下
    const evidence = [];
    for (const idx of acceptedMaterials) {
      const mat = proposal.materials[idx];
      if (!mat) continue;
      evidence.push({
        content: mat.content,
        source_type: mat.source_type,
        source_id: mat.source_id,
        target_field: mat.target_field,
        note: mat.note,
      });
      allSourceIds.push(mat.source_id);
    }

    // 3. 即使全部拒绝，也标记所有内容已消化（digested_at 写入即可防止重复消化）
    // 收集 proposal 涉及的所有内容 ID（revisions + materials + no_change）
    const allIds = new Set(allSourceIds);
    if (proposal.no_change) {
      for (const nid of proposal.no_change) allIds.add(nid);
    }
    // 补充：如果用户拒绝了某些提议，那些来源内容也要标记已消化
    for (const rev of proposal.revisions || []) {
      if (rev.source_ids) {
        for (const sid of rev.source_ids) allIds.add(sid);
      }
    }
    for (const mat of proposal.materials || []) {
      if (mat.source_id) allIds.add(mat.source_id);
    }

    // 4. 写新版本 crystal 文件（仅在用户接受了至少一条改写或材料时才写）
    let fileResult = null;
    if (acceptedRevisions.length > 0 || acceptedMaterials.length > 0) {
      fileResult = await saveAssimilation(id, {
        crystal,
        evidence,
        assimilatedFrom: Array.from(allIds),
        assimilatedFields,
      });
    }

    // 5. 标记所有涉及的来源内容为已消化（无论接受或拒绝，都算处理过了）
    const now = new Date().toISOString();
    for (const contentId of allIds) {
      // 三张表各试一次（db.run 执行 UPDATE，不影响其他表）
      try { db.run(`UPDATE inspiration_addenda SET digested_at = ? WHERE id = ?`, [now, contentId]); } catch {}
      try { db.run(`UPDATE knowledge_chunks SET digested_at = ? WHERE id = ?`, [now, contentId]); } catch {}
      try { db.run(`UPDATE saved_ai_replies SET digested_at = ? WHERE id = ?`, [now, contentId]); } catch {}
    }
    await saveDb();

    res.json({
      success: true,
      data: {
        file: fileResult?.file || null,
        assimilatedFields,
        evidenceCount: evidence.length,
        digestedCount: allIds.size,
      },
    });
  } catch (e) {
    console.error('[AssimilateController] confirm error:', e.message);
    res.status(500).json({ success: false, error: e.expose ? e.message : '确认消化失败' });
  }
}

export default { status, analyze, confirm };
