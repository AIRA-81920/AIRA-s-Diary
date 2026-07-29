// archiveService — 灵感档案馆聚合服务（K3-d 新建）
// 功能：将灵感的所有阶段产物（crystallize/epitaxy/coalesce）合并为单一 ArchiveResponse
// 实现方式：双源合并（DB 取状态/计数，文件取 crystal 内容，§8.1 L5 防口径漂移）
//
// 架构文档 §9.2 唯一契约：
//   GET /api/inspirations/:id/archive → ArchiveResponse
//   - inspiration: 灵感基础信息 + tags
//   - badges: { crystallize, epitaxy, coalesce } 三阶段状态徽章口径
//   - crystal: 结晶体（从文件快照合并，L5）
//   - epitaxy: { proposals: ProposalSummary[] }
//   - bridges: BridgeRecord[]（含 dismissed，前端置灰）
//   - fingerprintStale: boolean（驱动"扫描"按钮提示）
//
// 关键约束：
//   - 徽章口径全部由此处出（L4 防漂移）
//   - crystal 从文件系统读取（crystallize_results 表无 crystal_json 字段，L5）
//   - bridges 含 dismissed（前端置灰区分），不含已级联删除的
//   - fingerprintStale 来自 inspiration_embeddings.stale 字段

import { db } from '../database/db.js';
import inspirationStorage from '../services/inspirationStorage.js';
import { FingerprintService } from './fingerprintService.js';
import { CoalesceScanService } from './coalesceScanService.js';
import { FORCE_GRAPH_LIMITS } from '../config/constants.js';

export const ArchiveService = {
  /**
   * 获取灵感档案馆聚合数据
   * 功能：合并 DB 状态 + 文件快照，返回 ArchiveResponse
   * 实现方式：
   *   1. 查询 inspirations 表（含 tags）
   *   2. 查询 crystallize_results 表取状态 + 文件取 crystal 内容
   *   3. 查询 epitaxy_proposals 表取 proposals 摘要 + 统计 fragment/chunk 计数
   *   4. 查询 coalesce_bridges 表取所有桥梁（含 dismissed）
   *   5. 查询 inspiration_embeddings 表取 stale 状态
   *   6. 组装 badges（状态机映射）
   * @param {string} inspirationId
   * @returns {Promise<object|null>} ArchiveResponse 或 null（灵感不存在）
   */
  async getArchive(inspirationId) {
    // 1. 查询灵感基础信息（inspirations 表无 tags 列，tags 在 inspiration_tags 关联表）
    const inspRows = db.exec(
      `SELECT id, title, content, summary, source_type, source_url,
              created_at, updated_at, inspiration_type, crystal_type
       FROM inspirations WHERE id = ?`,
      [inspirationId]
    );
    if (inspRows.length === 0 || inspRows[0].values.length === 0) {
      return null;
    }
    const inspRow = inspRows[0].values[0];

    // 查询 tags（多对多关联表）
    let tags = [];
    try {
      const tagRows = db.exec(
        `SELECT t.name FROM tags t
         INNER JOIN inspiration_tags it ON it.tag_id = t.id
         WHERE it.inspiration_id = ?
         ORDER BY t.name`,
        [inspirationId]
      );
      if (tagRows.length > 0 && tagRows[0].values.length > 0) {
        tags = tagRows[0].values.map(r => r[0]);
      }
    } catch { /* 静默 */ }

    const inspiration = {
      id: inspRow[0],
      title: inspRow[1],
      content: inspRow[2],
      summary: inspRow[3],
      sourceType: inspRow[4],
      sourceUrl: inspRow[5],
      createdAt: inspRow[6],
      updatedAt: inspRow[7],
      inspirationType: inspRow[8],
      crystalType: inspRow[9],
      tags
    };

    // 2. 查询 crystallize 状态 + 文件取 crystal 内容（L5 双源合并）
    const { crystal, crystallizeBadge } = await this._buildCrystallizeArchive(inspirationId, inspRow[9]);

    // 3. 查询 epitaxy proposals + fragment/chunk 计数
    const { epitaxy, epitaxyBadge } = await this._buildEpitaxyArchive(inspirationId);

    // 4. 查询 coalesce bridges + 组装徽章
    const { bridges, coalesceBadge } = this._buildCoalesceArchive(inspirationId);

    // 5. 查询 fingerprint stale 状态
    const fingerprintStale = this._getFingerprintStale(inspirationId);

    return {
      inspiration,
      badges: {
        crystallize: crystallizeBadge,
        epitaxy: epitaxyBadge,
        coalesce: coalesceBadge
      },
      crystal,
      epitaxy,
      bridges,
      fingerprintStale
    };
  },

  /**
   * 构建 Crystallize 档案段（双源合并，L5）
   * 功能：从 DB 取状态，从文件取 crystal 内容
   * 实现方式：
   *   - DB: SELECT crystal_type, saved_at FROM crystallize_results（表无 status/user_confirmed 列）
   *   - 文件: inspirationStorage.getCrystallizeLatest(inspirationId) 取 crystal + user_confirmed 标记
   *   - 状态映射：无记录→none；有记录但文件无 user_confirmed→in_progress；文件 user_confirmed=true→done
   * @private
   * @param {string} inspirationId
   * @param {string|null} fallbackCrystalType - inspirations 表的 crystal_type（兜底）
   * @returns {Promise<{ crystal: object|null, crystallizeBadge: object }>}
   */
  async _buildCrystallizeArchive(inspirationId, fallbackCrystalType) {
    const rows = db.exec(
      `SELECT crystal_type, saved_at FROM crystallize_results
       WHERE inspiration_id = ? ORDER BY saved_at DESC LIMIT 1`,
      [inspirationId]
    );

    if (rows.length === 0 || rows[0].values.length === 0) {
      return {
        crystal: null,
        crystallizeBadge: { state: 'none' }
      };
    }

    const [crystalType, _savedAt] = rows[0].values[0];

    // 从文件系统读取 crystal 内容（L5：表无 crystal_json 字段）
    // 复用 inspirationStorage.getCrystallizeLatest 读取最新快照
    // K4 改造：保留 selected_dimensions / detected_capsule / concept_orientation 新字段（供前端 Detail 渲染徽章）
    let crystal = null;
    try {
      const snapshot = await inspirationStorage.getCrystallizeLatest(inspirationId);
      if (snapshot && (snapshot.crystal || snapshot.prd)) {
        crystal = {
          crystalType: crystalType || snapshot.crystal_type || fallbackCrystalType,
          fields: snapshot.crystal || snapshot.prd,
          // K4 新增：保留新字段（前端 InspirationDetail 顶部徽章渲染依赖）
          selected_dimensions: snapshot.selected_dimensions || null,
          detected_capsule: snapshot.detected_capsule || null,
          concept_orientation: snapshot.concept_orientation || null
        };
      } else if (snapshot && snapshot.crystal_type) {
        // 兜底：仅有 crystal_type 无内容
        crystal = {
          crystalType: crystalType || snapshot.crystal_type || fallbackCrystalType,
          fields: {},
          // K4 新增：兜底也保留新字段（保证前端徽章逻辑一致性）
          selected_dimensions: snapshot.selected_dimensions || null,
          detected_capsule: snapshot.detected_capsule || null,
          concept_orientation: snapshot.concept_orientation || null
        };
      }
    } catch (e) {
      console.warn(`[ArchiveService] getCrystallizeLatest failed for ${inspirationId}:`, e.message);
    }

    // 状态映射（K3-g 修复）：
    //   - 无 crystallize_results 记录 → none
    //   - 有记录但文件无 crystal 内容 → in_progress
    //   - 有记录且文件有 crystal 内容 → done
    //   （M3 实际：用户点"保存"即写入文件，无显式 user_confirmed 标记；
    //    原逻辑误把 user_confirmed 当唯一判定，导致永远 in_progress）
    let state = 'in_progress';
    if (crystal && crystal.fields && Object.keys(crystal.fields).length > 0) {
      state = 'done';
    } else if (!crystal) {
      state = 'in_progress';
    }

    return {
      crystal,
      crystallizeBadge: { state }
    };
  },

  /**
   * 构建 Epitaxy 档案段（K3-g 改造：三层沉淀 + 渐进披露）
   * 功能：只返回用户已深挖/已提炼的方向卡片，每张卡片下挂 fragments，每个 fragment 下挂 chunks
   * 实现方式：
   *   - proposals: SELECT ... WHERE status IN ('selected','distilled')（过滤掉 pending 未浏览的）
   *   - fragments: 按 proposal_id 批量查询 epitaxy_fragments
   *   - chunks: 按 fragment_id 批量查询 knowledge_chunks
   *   - 状态映射：无 proposal→none；有 proposal 无 fragment→has_notes；有 fragment 无 chunk→excavated；有 chunk→distilled
   * 原则：Detail 是档案馆，只沉淀用户真正操作过的产物；未浏览的方向不进档案
   * @private
   * @param {string} inspirationId
   * @returns {Promise<{ epitaxy: object|null, epitaxyBadge: object }>}
   */
  async _buildEpitaxyArchive(inspirationId) {
    // 只查已深挖/已提炼的 proposal（status !== 'pending'）
    const propRows = db.exec(
      `SELECT id, direction, reasoning, expected_yield, status, created_at
       FROM epitaxy_proposals
       WHERE inspiration_id = ? AND status IN ('selected', 'distilled')
       ORDER BY created_at ASC`,
      [inspirationId]
    );

    if (propRows.length === 0 || propRows[0].values.length === 0) {
      return {
        epitaxy: { proposals: [] },
        epitaxyBadge: { state: 'none', fragmentCount: 0, chunkCount: 0 }
      };
    }

    const proposals = propRows[0].values.map(row => ({
      id: row[0],
      title: row[1],          // direction 字段映射为 title（前端统一用 title 展示）
      direction: row[1],
      reasoning: row[2],
      expectedYield: row[3],
      status: row[4],
      createdAt: row[5],
      fragments: []           // 占位，后续填充
    }));

    // 批量查询这些 proposal 下的所有 fragments
    const proposalIds = proposals.map(p => `'${p.id}'`).join(',');
    let fragmentsByProposal = {};
    try {
      const fragRows = db.exec(
        `SELECT id, proposal_id, fragment_type, title, full_text, chunks_json, created_at
         FROM epitaxy_fragments
         WHERE proposal_id IN (${proposalIds})
         ORDER BY created_at ASC`
      );
      if (fragRows.length > 0 && fragRows[0].values.length > 0) {
        fragRows[0].values.forEach(row => {
          const pid = row[1];
          if (!fragmentsByProposal[pid]) fragmentsByProposal[pid] = [];
          fragmentsByProposal[pid].push({
            id: row[0],
            proposalId: pid,
            fragmentType: row[2],
            title: row[3],
            fullText: row[4],
            chunksJson: row[5],   // 原始 LLM 词块 JSON（供参考）
            createdAt: row[6],
            chunks: []            // 占位，后续填充用户选定的 chunks
          });
        });
      }
    } catch (e) {
      console.warn('[ArchiveService] query fragments failed:', e.message);
    }

    // 批量查询所有 fragments 下的用户选定 chunks（knowledge_chunks）
    const allFragments = Object.values(fragmentsByProposal).flat();
    let chunksByFragment = {};
    if (allFragments.length > 0) {
      const fragmentIds = allFragments.map(f => `'${f.id}'`).join(',');
      try {
        const chunkRows = db.exec(
          `SELECT id, fragment_id, original_text, chunk_text, chunk_kind, chunk_subkind, user_note, selected_at
           FROM knowledge_chunks
           WHERE fragment_id IN (${fragmentIds})
           ORDER BY selected_at ASC`
        );
        if (chunkRows.length > 0 && chunkRows[0].values.length > 0) {
          chunkRows[0].values.forEach(row => {
            const fid = row[1];
            if (!chunksByFragment[fid]) chunksByFragment[fid] = [];
            chunksByFragment[fid].push({
              id: row[0],
              fragmentId: fid,
              originalText: row[2],
              chunkText: row[3],
              kind: row[4],
              subkind: row[5],
              userNote: row[6],
              selectedAt: row[7]
            });
          });
        }
      } catch (e) {
        console.warn('[ArchiveService] query chunks failed:', e.message);
      }
    }

    // 把 fragments 挂到对应 proposal，把 chunks 挂到对应 fragment
    let totalFragmentCount = 0;
    let totalChunkCount = 0;
    proposals.forEach(p => {
      p.fragments = fragmentsByProposal[p.id] || [];
      totalFragmentCount += p.fragments.length;
      p.fragments.forEach(f => {
        f.chunks = chunksByFragment[f.id] || [];
        totalChunkCount += f.chunks.length;
      });
    });

    // 状态映射：有 chunk→distilled；有 fragment 无 chunk→excavated；有 proposal 无 fragment→has_notes
    let state = 'has_notes';
    if (totalChunkCount > 0) {
      state = 'distilled';
    } else if (totalFragmentCount > 0) {
      state = 'excavated';
    }

    return {
      epitaxy: { proposals },
      epitaxyBadge: { state, fragmentCount: totalFragmentCount, chunkCount: totalChunkCount }
    };
  },

  /**
   * 构建 Coalesce 档案段
   * 功能：查询所有相关桥梁 + 组装徽章
   * 实现方式：
   *   - bridges: SELECT * FROM coalesce_bridges WHERE inspiration_id = ? OR inspiration_b_id = ?
   *   - 复用 CoalesceScanService._formatBridge 格式化
   *   - 状态映射：无桥梁→unscanned；有 pending 桥梁→has_bridges；全部 confirmed/dismissed→curated
   *   - bridgeCount: pending + confirmed（不含 dismissed，§9.2 契约）
   *   - confirmedCount: 仅 confirmed
   * @private
   * @param {string} inspirationId
   * @returns {{ bridges: Array, coalesceBadge: object }}
   */
  _buildCoalesceArchive(inspirationId) {
    const rows = db.exec(
      `SELECT id, inspiration_id, inspiration_b_id, bridge_type, reason, connection,
              vector_score, llm_score, status, saved_at
       FROM coalesce_bridges
       WHERE inspiration_id = ? OR inspiration_b_id = ?
       ORDER BY saved_at DESC`,
      [inspirationId, inspirationId]
    );

    if (rows.length === 0 || rows[0].values.length === 0) {
      return {
        bridges: [],
        coalesceBadge: { state: 'unscanned', bridgeCount: 0, confirmedCount: 0 }
      };
    }

    const allBridges = rows[0].values.map(row => ({
      id: row[0],
      inspirationAId: row[1],
      inspirationBId: row[2],
      bridgeType: row[3],
      reason: row[4] || row[5] || '',  // reason 优先，回退到旧 connection 列
      vectorScore: row[6],
      llmScore: row[7],
      status: row[8] || 'confirmed',
      createdAt: row[9]
    }));

    // 统计（§9.2：bridgeCount = pending + confirmed，不含 dismissed）
    const activeBridges = allBridges.filter(b => b.status !== 'dismissed');
    const confirmedBridges = allBridges.filter(b => b.status === 'confirmed');
    const pendingBridges = allBridges.filter(b => b.status === 'pending');

    // 状态映射：有 pending→has_bridges；无 pending 但有 confirmed→curated
    let state = 'unscanned';
    if (pendingBridges.length > 0) {
      state = 'has_bridges';
    } else if (confirmedBridges.length > 0) {
      state = 'curated';
    } else if (allBridges.length > 0) {
      // 全部 dismissed
      state = 'curated';
    }

    return {
      bridges: allBridges,
      coalesceBadge: {
        state,
        bridgeCount: activeBridges.length,
        confirmedCount: confirmedBridges.length
      }
    };
  },

  /**
   * 查询 fingerprint stale 状态
   * 功能：从 inspiration_embeddings 表读取 stale 字段
   * 实现方式：同步查询，不存在记录返回 true（需重算）
   * @private
   * @param {string} inspirationId
   * @returns {boolean}
   */
  _getFingerprintStale(inspirationId) {
    try {
      const rows = db.exec(
        `SELECT stale FROM inspiration_embeddings WHERE inspiration_id = ?`,
        [inspirationId]
      );
      if (rows.length === 0 || rows[0].values.length === 0) {
        return true;  // 无记录视为 stale
      }
      return rows[0].values[0][0] === 1;
    } catch {
      return true;
    }
  }
};

export default ArchiveService;
