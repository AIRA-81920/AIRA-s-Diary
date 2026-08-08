// CoalesceScanService — 跨灵感桥梁扫描服务（K3 架构改造版）
// 功能：基于 embedding 向量做 cosine 召回 + LLM 深挖，发现跨灵感桥梁
// 实现方式：
//   1. scanFor(inspirationId)：ensureFingerprint 前置 → 加载全库向量 → O(n) cosine
//      → ≥0.3 候选池；≥0.5 写 coalesce_candidates；≥0.7 调 LLM 深挖写 coalesce_bridges
//   2. incrementalUpdate(inspirationId)：后台增量扫描（新灵感 vs 全库）
//   3. getGraph()：力导向图全量数据（nodes + edges，dismissed 不下发）
//   4. curate(bridgeId, action)：策展（confirm/dismiss）
//   5. bridgeToInspiration(bridgeId)：桥梁转新灵感（content=reason，走 §6.1 管线）
//
// 架构文档 §10.2 接口契约：
//   interface CoalesceScanService {
//     scanFor(inspirationId: string): Promise<ScanResponse>;
//     incrementalUpdate(inspirationId: string): Promise<void>;
//     getGraph(): Promise<GraphResponse>;
//     curate(bridgeId: string, action: 'confirm' | 'dismiss'): Promise<BridgeRecord>;
//     bridgeToInspiration(bridgeId: string): Promise<{ inspiration: Inspiration }>;
//   }
//
// 关键约束（架构 §6.3 + §9.3 + §13）：
//   - 阈值分层：candidate=0.3 / persist=0.5 / llm=0.7 / duplicate=0.9（constants.THRESHOLDS）
//   - 无向对规范化：A < B（字典序），杜绝双向重复行
//   - 增量扫描：已算对跳过（查 coalesce_bridges 是否已有同 (a,b) 行）
//   - top N ≤ 5 截断（LLM_LIMITS.SCAN_TOP_N）
//   - PairSide 原文截断 ≤500 字（LLM_LIMITS.PAIR_CONTENT_EXCERPT）
//   - LLM 超时 45s（LLM_LIMITS.SCAN_TIMEOUT_MS）
//   - dismissed 边不下发 graph（L7）

import { db, saveDb, getMeta, setMeta } from '../database/db.js';
import { v4 as uuidv4 } from 'uuid';
import EmbeddingService from './embeddingService.js';
import FingerprintService from './fingerprintService.js';
import CoalesceAgent from '../agents/coalesceAgent.js';
import {
  THRESHOLDS,
  BRIDGE_TYPES,
  BRIDGE_STATUS,
  LLM_LIMITS,
  FORCE_GRAPH_LIMITS,
  COALESCE_QUALIFY
} from '../config/constants.js';

/**
 * 执行 SQL 查询并返回所有匹配行（对象数组）
 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * 执行 SQL 查询并返回第一行（对象），无结果返回 null
 */
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

/**
 * 无向对规范化：返回 [a, b] 使得 a < b（字典序）
 * 功能：杜绝双向重复行（同一对灵感只存一条桥梁）
 * @param {string} idA - 灵感 A ID
 * @param {string} idB - 灵感 B ID
 * @returns {[string, string]} 规范化后的 [smaller, larger]
 */
function normalizePair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

/**
 * 从 inspiration_embeddings 行组装三源向量对象（委托 EmbeddingService）
 * 功能：把指纹/标题/正文三个 BLOB 反序列化为 Float32Array，缺失源为 null
 * 实现方式：直接调用 EmbeddingService.vecsFromRow，保证多源口径全库一致
 * @param {object} row - SELECT inspiration_id, embedding, embedding_title, embedding_content 的行
 * @returns {{ fingerprint: Float32Array|null, title: Float32Array|null, content: Float32Array|null }}
 */
function vecsFromRow(row) {
  return EmbeddingService.vecsFromRow(row);
}

/**
 * CoalesceScanService 单例对象
 */
export const CoalesceScanService = {
  /**
   * 显式扫描：为指定灵感发现跨灵感桥梁
   * 功能：ensureFingerprint → 加载全库向量 → O(n) cosine → 阈值分层 → LLM 深挖 → 写库
   * 实现方式：
   *   1. 前置 ensureFingerprint（stale/缺失则同步重算，L6）
   *   2. 校验 EmbeddingService.isReady（未就绪返回 EMBEDDING_UNAVAILABLE）
   *   3. 校验可比对灵感数 ≥ 2（否则 INSUFFICIENT_INSPIRATIONS）
   *   4. 加载全库 inspiration_embeddings（stale=0 且 embedding 非空）
   *   5. O(n) cosine：当前灵感 vs 其余全部
   *   6. ≥0.3 入候选池；≥0.5 写 coalesce_candidates（增量：已有对跳过）
   *   7. ≥0.7 的对（top N≤5）调 CoalesceAgent.deepen（LLM 深挖）
   *   8. UPSERT coalesce_bridges（无向对规范化 a<b；vector_score + llm_score 双写）
   *   9. 返回 ScanResponse
   * @param {string} inspirationId - 当前灵感 ID
   * @returns {Promise<object>} ScanResponse
   * @throws {Error} EMBEDDING_UNAVAILABLE / INSUFFICIENT_INSPIRATIONS / FINGERPRINT_STALE / LLM_*
   */
  async scanFor(inspirationId) {
    // ===== 1. 前置 ensureFingerprint（L6：scan 前置同步重算）=====
    try {
      await FingerprintService.ensureFresh(inspirationId);
    } catch (err) {
      console.error(`[CoalesceScanService] ensureFingerprint failed for ${inspirationId}:`, err.message);
      const e = new Error(`Fingerprint stale: ${err.message}`);
      e.code = 'FINGERPRINT_STALE';
      throw e;
    }

    // ===== 2. 健康门：EmbeddingService 必须就绪 =====
    if (!EmbeddingService.isReady()) {
      const e = new Error('Embedding model not ready');
      e.code = 'EMBEDDING_UNAVAILABLE';
      throw e;
    }

    // ===== 3. 校验可比对灵感数 ≥ 2 =====
    const allEmbeddings = queryAll(
      'SELECT inspiration_id, embedding, embedding_title, embedding_content, model_name, stale FROM inspiration_embeddings WHERE embedding IS NOT NULL AND stale = 0'
    );
    if (allEmbeddings.length < 2) {
      const e = new Error('Insufficient inspirations with embeddings (need ≥ 2)');
      e.code = 'INSUFFICIENT_INSPIRATIONS';
      throw e;
    }

    // 当前灵感的向量必须存在
    const currentRow = allEmbeddings.find(r => r.inspiration_id === inspirationId);
    if (!currentRow) {
      const e = new Error(`No fresh embedding for inspiration ${inspirationId}`);
      e.code = 'FINGERPRINT_STALE';
      throw e;
    }
    // 组装三源向量对象（指纹/标题/正文，缺失源为 null，由加权合成自动分摊）
    const currentVecs = vecsFromRow(currentRow);

    // ===== 4. O(n) cosine 召回（三源加权合成）=====
    const others = allEmbeddings.filter(r => r.inspiration_id !== inspirationId);
    const scored = [];
    for (const row of others) {
      const score = EmbeddingService.weightedSimilarity(currentVecs, vecsFromRow(row)).score;
      if (score >= THRESHOLDS.CANDIDATE) {
        scored.push({ inspirationId: row.inspiration_id, vectorScore: score });
      }
    }
    // 按 vectorScore 降序
    scored.sort((a, b) => b.vectorScore - a.vectorScore);

    // ===== 5. ≥0.5 写 coalesce_candidates（增量：已有对跳过）=====
    let candidateCount = 0;
    for (const s of scored) {
      if (s.vectorScore < THRESHOLDS.PERSIST) continue;
      const [aId, bId] = normalizePair(inspirationId, s.inspirationId);
      // 检查是否已有候选对（增量：已算对跳过）
      const existing = queryOne(
        'SELECT id FROM coalesce_candidates WHERE inspiration_id_a = ? AND inspiration_id_b = ?',
        [aId, bId]
      );
      if (existing) continue;
      // 写入新候选对
      const candId = uuidv4();
      db.run(
        `INSERT INTO coalesce_candidates (id, inspiration_id_a, inspiration_id_b, vector_score, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [candId, aId, bId, s.vectorScore, new Date().toISOString()]
      );
      candidateCount++;
    }

    // ===== 6. ≥THRESHOLDS.LLM 的对（top N≤5）调 LLM 深挖 =====
    const llmCandidates = scored
      .filter(s => s.vectorScore >= THRESHOLDS.LLM)
      .slice(0, LLM_LIMITS.SCAN_TOP_N);

    const newBridges = [];
    let reusedBridges = 0;

    for (const s of llmCandidates) {
      const [aId, bId] = normalizePair(inspirationId, s.inspirationId);

      // 检查是否已有桥梁（增量：已算对跳过 LLM）
      const existingBridge = queryOne(
        'SELECT id FROM coalesce_bridges WHERE inspiration_id = ? AND inspiration_b_id = ?',
        [aId, bId]
      );
      if (existingBridge) {
        reusedBridges++;
        continue;
      }

      // 构建 PairSide
      const pairSideA = await this._buildPairSide(aId);
      const pairSideB = await this._buildPairSide(bId);
      if (!pairSideA || !pairSideB) continue;

      // 调 CoalesceAgent.deepen（LLM 深挖）
      try {
        const result = await CoalesceAgent.deepen({
          a: pairSideA,
          b: pairSideB
        });

        // 双达标门槛（2026-08）：embedding 与 LLM 分数都达标才建桥
        //  - LLM 返回 no_link（判定无实质连接）→ 拒绝建桥
        //  - llmScore < LLM_MIN（LLM 把握不足）→ 拒绝建桥
        if (result.bridgeType === 'no_link' || result.llmScore < COALESCE_QUALIFY.LLM_MIN) {
          console.log(
            `[CoalesceScanService] pair (${aId}, ${bId}) rejected: ` +
            `bridgeType=${result.bridgeType}, vectorScore=${s.vectorScore.toFixed(3)}, llmScore=${result.llmScore?.toFixed?.(3) ?? result.llmScore}`
          );
          continue;
        }

        // UPSERT coalesce_bridges
        const bridgeId = uuidv4();
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO coalesce_bridges
            (id, candidate_id, inspiration_id, inspiration_b_id, bridge_type, connection, reason,
             vector_score, llm_score, status, saved_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            bridgeId,
            aId,
            bId,
            result.bridgeType,
            result.reason,        // connection 字段保留旧值（兼容）
            result.reason,        // reason 字段（新）
            s.vectorScore,
            result.llmScore,
            BRIDGE_STATUS.PENDING,
            now
          ]
        );
        newBridges.push(this._formatBridge({
          id: bridgeId,
          inspiration_id: aId,
          inspiration_b_id: bId,
          bridge_type: result.bridgeType,
          reason: result.reason,
          vector_score: s.vectorScore,
          llm_score: result.llmScore,
          status: BRIDGE_STATUS.PENDING,
          saved_at: now
        }));
      } catch (err) {
        console.warn(`[CoalesceScanService] LLM deepen failed for pair (${aId}, ${bId}):`, err.message);
        // 单对失败不阻塞其他对
      }
    }

    if (newBridges.length > 0 || candidateCount > 0) {
      saveDb();
    }

    return {
      scannedPairs: scored.length,
      candidateCount,
      newBridges,
      reusedBridges
    };
  },

  /**
   * 增量扫描：新灵感 vs 全库（后台任务调用）
   * 功能：新灵感录入后，与全库做 cosine，≥0.5 写 coalesce_candidates（不触发 LLM 深挖）
   * 实现方式：与 scanFor 类似但跳过 LLM 深挖（仅写候选对）
   * @param {string} inspirationId - 新灵感 ID
   * @returns {Promise<void>}
   */
  async incrementalUpdate(inspirationId) {
    if (!EmbeddingService.isReady()) {
      console.warn('[CoalesceScanService] incrementalUpdate skipped: embedding not ready');
      return;
    }

    // 确保指纹就绪
    try {
      await FingerprintService.ensureFresh(inspirationId);
    } catch (err) {
      console.warn(`[CoalesceScanService] incrementalUpdate: ensureFingerprint failed for ${inspirationId}:`, err.message);
      return;
    }

    // fix：当前灵感已软删除（快照中）时直接跳过，不为其增量配对
    const aliveCheck = queryOne(
      'SELECT id FROM inspirations WHERE id = ? AND deleted_at IS NULL',
      [inspirationId]
    );
    if (!aliveCheck) {
      console.warn(`[CoalesceScanService] incrementalUpdate: inspiration ${inspirationId} is soft-deleted, skip`);
      return;
    }

    const currentRow = queryOne(
      'SELECT embedding, embedding_title, embedding_content FROM inspiration_embeddings WHERE inspiration_id = ? AND embedding IS NOT NULL AND stale = 0',
      [inspirationId]
    );
    if (!currentRow) {
      console.warn(`[CoalesceScanService] incrementalUpdate: no fresh embedding for ${inspirationId}`);
      return;
    }
    const currentVecs = vecsFromRow(currentRow);

    // fix：JOIN inspirations 排除已软删除灵感，避免与快照中的灵感配对
    const others = queryAll(
      `SELECT e.inspiration_id, e.embedding, e.embedding_title, e.embedding_content
       FROM inspiration_embeddings e
       JOIN inspirations i ON e.inspiration_id = i.id
       WHERE e.inspiration_id != ? AND e.embedding IS NOT NULL AND e.stale = 0 AND i.deleted_at IS NULL`,
      [inspirationId]
    );

    let newCandidates = 0;
    for (const row of others) {
      const score = EmbeddingService.weightedSimilarity(currentVecs, vecsFromRow(row)).score;
      if (score < THRESHOLDS.PERSIST) continue;

      const [aId, bId] = normalizePair(inspirationId, row.inspiration_id);
      const existing = queryOne(
        'SELECT id FROM coalesce_candidates WHERE inspiration_id_a = ? AND inspiration_id_b = ?',
        [aId, bId]
      );
      if (existing) continue;

      const candId = uuidv4();
      db.run(
        `INSERT INTO coalesce_candidates (id, inspiration_id_a, inspiration_id_b, vector_score, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [candId, aId, bId, score, new Date().toISOString()]
      );
      newCandidates++;
    }

    if (newCandidates > 0) {
      saveDb();
      console.log(`[CoalesceScanService] incrementalUpdate: ${newCandidates} new candidates for ${inspirationId}`);
    }
  },

  /**
   * 全量扫描（灵感网络左下角"扫描桥梁"按钮触发）
   * 功能：遍历全部灵感，两两做向量召回 + LLM 深挖，补齐所有缺失桥梁
   * 实现方式：
   *   1. 健康门：EmbeddingService 就绪 + 可比对灵感 ≥ 2
   *   2. 加载全库 embeddings（stale=0），两两 cosine（无向对 a<b 去重）
   *   3. 已存在桥梁的对跳过（增量）；其余 ≥0.55 的对进候选池
   *   4. 候选池按 vectorScore 降序，top N≤10 调 LLM 深挖写 coalesce_bridges（pending）
   *   5. 返回汇总 { scannedPairs, newBridges, reusedBridges, candidateCount }
   * @returns {Promise<object>} 全量扫描汇总
   */
  async scanAll() {
    // 健康门
    if (!EmbeddingService.isReady()) {
      const e = new Error('Embedding model not ready');
      e.code = 'EMBEDDING_UNAVAILABLE';
      throw e;
    }
    // 加载全部有效 embedding（fix：JOIN inspirations 排除已软删除灵感，快照不参与全量扫描）
    const allEmbeddings = queryAll(
      `SELECT e.inspiration_id, e.embedding, e.embedding_title, e.embedding_content
       FROM inspiration_embeddings e
       JOIN inspirations i ON e.inspiration_id = i.id
       WHERE e.embedding IS NOT NULL AND e.stale = 0 AND i.deleted_at IS NULL`
    );
    if (allEmbeddings.length < 2) {
      const e = new Error('Insufficient inspirations with embeddings (need ≥ 2)');
      e.code = 'INSUFFICIENT_INSPIRATIONS';
      throw e;
    }

    // 两两 cosine（无向对 a<b，跳过已有桥梁的对；三源加权合成）
    const pairs = [];
    const seenPair = new Set();
    for (let i = 0; i < allEmbeddings.length; i++) {
      const vecsA = vecsFromRow(allEmbeddings[i]);
      for (let j = i + 1; j < allEmbeddings.length; j++) {
        const [aId, bId] = normalizePair(allEmbeddings[i].inspiration_id, allEmbeddings[j].inspiration_id);
        const pairKey = `${aId}|${bId}`;
        if (seenPair.has(pairKey)) continue;
        seenPair.add(pairKey);

        // 已存在桥梁的对跳过（增量）
        const existingBridge = queryOne(
          'SELECT id FROM coalesce_bridges WHERE inspiration_id = ? AND inspiration_b_id = ?',
          [aId, bId]
        );
        if (existingBridge) continue;

        const score = EmbeddingService.weightedSimilarity(vecsA, vecsFromRow(allEmbeddings[j])).score;
        if (score >= THRESHOLDS.LLM) {
          pairs.push({ aId, bId, vectorScore: score });
        }
      }
    }
    pairs.sort((a, b) => b.vectorScore - a.vectorScore);
    // LLM 深挖上限（全库一轮最多 10 次，避免请求爆炸）
    const llmPairs = pairs.slice(0, 10);

    // 写候选表（全库增量）
    let candidateCount = 0;
    for (const p of pairs) {
      const existing = queryOne(
        'SELECT id FROM coalesce_candidates WHERE inspiration_id_a = ? AND inspiration_id_b = ?',
        [p.aId, p.bId]
      );
      if (existing) continue;
      db.run(
        `INSERT INTO coalesce_candidates (id, inspiration_id_a, inspiration_id_b, vector_score, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
        [uuidv4(), p.aId, p.bId, p.vectorScore, new Date().toISOString()]
      );
      candidateCount++;
    }

    // LLM 深挖
    const newBridges = [];
    let reusedBridges = 0;
    for (const p of llmPairs) {
      const existingBridge = queryOne(
        'SELECT id FROM coalesce_bridges WHERE inspiration_id = ? AND inspiration_b_id = ?',
        [p.aId, p.bId]
      );
      if (existingBridge) { reusedBridges++; continue; }

      const pairSideA = await this._buildPairSide(p.aId);
      const pairSideB = await this._buildPairSide(p.bId);
      if (!pairSideA || !pairSideB) continue;

      try {
        const result = await CoalesceAgent.deepen({ a: pairSideA, b: pairSideB });

        // 双达标门槛（2026-08）：同 scanFor——LLM 拒绝(no_link)或把握不足(llmScore<LLM_MIN)则不建桥
        if (result.bridgeType === 'no_link' || result.llmScore < COALESCE_QUALIFY.LLM_MIN) {
          console.log(
            `[CoalesceScanService] scanAll pair (${p.aId}, ${p.bId}) rejected: ` +
            `bridgeType=${result.bridgeType}, llmScore=${result.llmScore?.toFixed?.(3) ?? result.llmScore}`
          );
          continue;
        }

        const bridgeId = uuidv4();
        const now = new Date().toISOString();
        db.run(
          `INSERT INTO coalesce_bridges
            (id, candidate_id, inspiration_id, inspiration_b_id, bridge_type, connection, reason,
             vector_score, llm_score, status, saved_at)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [bridgeId, p.aId, p.bId, result.bridgeType, result.reason, result.reason,
           p.vectorScore, result.llmScore, BRIDGE_STATUS.PENDING, now]
        );
        newBridges.push(this._formatBridge({
          id: bridgeId,
          inspiration_id: p.aId,
          inspiration_b_id: p.bId,
          bridge_type: result.bridgeType,
          reason: result.reason,
          vector_score: p.vectorScore,
          llm_score: result.llmScore,
          status: BRIDGE_STATUS.PENDING,
          saved_at: now
        }));
      } catch (err) {
        console.warn(`[CoalesceScanService] scanAll LLM deepen failed for pair (${p.aId}, ${p.bId}):`, err.message);
      }
    }

    if (newBridges.length > 0 || candidateCount > 0) saveDb();
    console.log(`[CoalesceScanService] scanAll: ${pairs.length} pairs scored, ${candidateCount} candidates, ${newBridges.length} new bridges`);
    return {
      scannedPairs: pairs.length,
      candidateCount,
      newBridges,
      reusedBridges
    };
  },

  /**
   * 获取力导向图全量数据
   * 功能：返回 nodes + edges，dismissed 一律不下发（L7）
   * 实现方式：
   *   1. 查 coalesce_bridges（status != dismissed）构建 edges + 有桥节点计数
   *   2. 节点返回**所有灵感**（含孤立节点），hasBridges/bridgeCount 字段让前端区分
   *   3. 节点数超过 MAX_NODES 时按 bridgeCount 降序截断（有桥节点优先保留）
   *   4. 边字段含五要素：bridgeType / vectorScore / llmScore / status
   * @returns {Promise<object>} GraphResponse
   */
  async getGraph() {
    // 桥查询：JOIN 两端灵感表，任一端已软删除（deleted_at 非空）的桥一律不下发
    // 实现：与下方节点过滤配套，防止 d3-force 出现"边引用不存在节点"的崩溃（fix 快照遗漏）
    const bridgeRows = queryAll(
      `SELECT b.id, b.inspiration_id, b.inspiration_b_id, b.bridge_type, b.reason,
              b.vector_score, b.llm_score, b.status, b.saved_at
       FROM coalesce_bridges b
       JOIN inspirations ia ON b.inspiration_id = ia.id
       JOIN inspirations ib ON b.inspiration_b_id = ib.id
       WHERE b.status != ? AND ia.deleted_at IS NULL AND ib.deleted_at IS NULL
       ORDER BY b.saved_at DESC`,
      [BRIDGE_STATUS.DISMISSED]
    );

    // 构建节点计数（只统计有桥的节点）
    const nodeBridgeCount = new Map();
    const connectedNodeIds = new Set();
    const edges = [];
    for (const row of bridgeRows) {
      // 节点计数
      nodeBridgeCount.set(row.inspiration_id, (nodeBridgeCount.get(row.inspiration_id) || 0) + 1);
      nodeBridgeCount.set(row.inspiration_b_id, (nodeBridgeCount.get(row.inspiration_b_id) || 0) + 1);
      connectedNodeIds.add(row.inspiration_id);
      connectedNodeIds.add(row.inspiration_b_id);

      edges.push({
        id: row.id,
        source: row.inspiration_id,
        target: row.inspiration_b_id,
        bridgeType: row.bridge_type,
        reason: row.reason,
        vectorScore: row.vector_score,
        llmScore: row.llm_score,
        status: row.status
      });
    }

    // 节点数超过 MAX_NODES 时按 bridgeCount 降序截断有桥节点
    let nodeIds = Array.from(nodeBridgeCount.keys());
    if (nodeIds.length > FORCE_GRAPH_LIMITS.MAX_NODES) {
      nodeIds.sort((a, b) => nodeBridgeCount.get(b) - nodeBridgeCount.get(a));
      nodeIds = nodeIds.slice(0, FORCE_GRAPH_LIMITS.MAX_NODES);
      // 过滤边：仅保留两端节点都在截断列表中的边
      const nodeIdSet = new Set(nodeIds);
      edges = edges.filter(e => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));
    }

    // 加载所有灵感（含孤立节点），节点字段加 hasBridges 标识
    // fix：过滤已软删除灵感（deleted_at IS NULL），快照中的灵感不出现在网络图
    const allInspirationRows = queryAll(
      `SELECT id, title, inspiration_type FROM inspirations
       WHERE deleted_at IS NULL`
    );
    const nodes = allInspirationRows.map((row) => ({
      id: row.id,
      title: row.title,
      inspirationType: row.inspiration_type,
      bridgeCount: nodeBridgeCount.get(row.id) || 0,
      hasBridges: connectedNodeIds.has(row.id)
    }));

    // 查询 pending 状态桥梁数量（供前端显示未策展待办徽章）
    // 功能：统计 coalesce_bridges 中 status='pending' 的行数，随 graph 一起下发
    // fix：同步排除已软删除灵感的桥，避免徽标计数包含快照中的灵感
    const pendingRow = queryOne(
      `SELECT COUNT(*) as cnt
       FROM coalesce_bridges b
       JOIN inspirations ia ON b.inspiration_id = ia.id
       JOIN inspirations ib ON b.inspiration_b_id = ib.id
       WHERE b.status = ? AND ia.deleted_at IS NULL AND ib.deleted_at IS NULL`,
      [BRIDGE_STATUS.PENDING]
    );
    const pendingCount = pendingRow ? pendingRow.cnt : 0;

    return { nodes, edges, pendingCount };
  },

  /**
   * 获取 pending 桥梁数量与上次查看时间
   * 功能：返回 pending 状态桥梁数量 + 用户上次查看网络图的时间戳（供前端徽章对比）
   * 实现方式：
   *   1. COUNT(*) 查询 coalesce_bridges 中 status='pending' 的行数
   *   2. 从 app_meta 读 coalesce_last_seen_at（可能为 null，表示从未查看过）
   * @returns {Promise<{ count: number, lastSeenAt: number|null }>}
   */
  async getPendingCount() {
    // 读取上次查看时间戳（字符串存储毫秒数，转 number 返回；不存在返回 null）
    const lastSeenAtStr = getMeta('coalesce_last_seen_at');
    const lastSeenAt = lastSeenAtStr ? Number(lastSeenAtStr) : null;

    // lastSeenAt 转成与 saved_at 一致的 ISO 字符串，用于"只统计新增"过滤
    // （saved_at 存 new Date().toISOString()，即 UTC ISO；两者可直接字符串比较）
    const lastSeenIso = lastSeenAt ? new Date(lastSeenAt).toISOString() : null;

    // 查询已上次看图后"新增"的 pending 桥梁数量：
    //   - 排除已软删除灵感的桥（保证徽标计数只含活跃灵感）
    //   - 仅统计 saved_at 晚于 lastSeenAt 的桥（用户看一次即消除，直到新桥出现）
    //   - lastSeenAt 为 null（从未看图）时不过滤，返回全部 pending 数量
    const row = queryOne(
      `SELECT COUNT(*) as cnt
       FROM coalesce_bridges b
       JOIN inspirations ia ON b.inspiration_id = ia.id
       JOIN inspirations ib ON b.inspiration_b_id = ib.id
       WHERE b.status = ?
         AND ia.deleted_at IS NULL AND ib.deleted_at IS NULL
         AND (? IS NULL OR b.saved_at > ?)`,
      [BRIDGE_STATUS.PENDING, lastSeenIso, lastSeenIso]
    );
    const count = row ? row.cnt : 0;

    return { count, lastSeenAt };
  },

  /**
   * 标记网络图已被用户查看
   * 功能：将当前时间戳写入 app_meta.coalesce_last_seen_at，供前端判断是否有新桥梁未看
   * 实现方式：setMeta 写入 Date.now()（setMeta 内部已 saveDb 落盘）
   * @returns {Promise<{ success: boolean }>}
   */
  async markNetworkSeen() {
    setMeta('coalesce_last_seen_at', Date.now());
    return { success: true };
  },

  /**
   * 策展：确认或忽略桥梁
   * 功能：更新 coalesce_bridges.status，幂等（重复 confirm 仍 200）
   * @param {string} bridgeId - 桥梁 ID
   * @param {'confirm'|'dismiss'} action - 策展动作
   * @returns {Promise<object>} BridgeRecord
   * @throws {Error} NOT_FOUND / VALIDATION_FAILED
   */
  async curate(bridgeId, action) {
    if (action !== 'confirm' && action !== 'dismiss') {
      const e = new Error(`Invalid action: ${action}`);
      e.code = 'VALIDATION_FAILED';
      throw e;
    }

    const row = queryOne('SELECT * FROM coalesce_bridges WHERE id = ?', [bridgeId]);
    if (!row) {
      const e = new Error(`Bridge not found: ${bridgeId}`);
      e.code = 'NOT_FOUND';
      throw e;
    }

    const newStatus = action === 'confirm' ? BRIDGE_STATUS.CONFIRMED : BRIDGE_STATUS.DISMISSED;
    // 幂等：已是目标状态直接返回
    if (row.status === newStatus) {
      return this._formatBridge(row);
    }

    db.run('UPDATE coalesce_bridges SET status = ? WHERE id = ?', [newStatus, bridgeId]);
    saveDb();

    const updated = queryOne('SELECT * FROM coalesce_bridges WHERE id = ?', [bridgeId]);
    return this._formatBridge(updated);
  },

  /**
   * 桥梁转新灵感
   * 功能：以 bridge.reason 为新灵感 content 创建灵感，走 §6.1 后台语义化（不自动扫描，R10）
   * @param {string} bridgeId - 桥梁 ID
   * @returns {Promise<{ inspiration: object, sourceBridgeId: string }>}
   * @throws {Error} NOT_FOUND
   */
  async bridgeToInspiration(bridgeId) {
    const row = queryOne('SELECT * FROM coalesce_bridges WHERE id = ?', [bridgeId]);
    if (!row) {
      const e = new Error(`Bridge not found: ${bridgeId}`);
      e.code = 'NOT_FOUND';
      throw e;
    }

    // 动态 import 避免循环依赖
    const { Inspiration } = await import('../models/Inspiration.js');
    const inspirationStorage = (await import('./inspirationStorage.js')).default;
    const TaskQueue = (await import('./taskQueue.js')).default;
    const { TASK_KINDS } = await import('./taskQueue.js');

    // 新灵感 content = bridge.reason（架构 §9.3）
    const reason = row.reason || row.connection || '';
    const title = reason.slice(0, 30) + (reason.length > 30 ? '...' : '');
    const newInspiration = Inspiration.create({
      title: title || '桥梁灵感',
      content: reason,
      source_type: 'coalesce_bridge',
      source_url: null
    });

    // 初始化文件存储
    await inspirationStorage.initStorage(newInspiration.id, {
      title: newInspiration.title,
      source_type: newInspiration.source_type,
    });

    // 入队后台语义化（fingerprint + embedding），不自动扫描（R10）
    TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, newInspiration.id);

    return { inspiration: newInspiration, sourceBridgeId: bridgeId };
  },

  // ========== 私有方法 ==========

  /**
   * 构建 PairSide（LLM 深挖输入）
   * 功能：组装灵感的 fingerprint + 原文摘要（≤500 字）
   * @private
   * @param {string} inspirationId
   * @returns {Promise<object|null>} PairSide
   */
  async _buildPairSide(inspirationId) {
    const inspiration = queryOne(
      'SELECT id, title, content FROM inspirations WHERE id = ?',
      [inspirationId]
    );
    if (!inspiration) return null;

    const fingerprint = FingerprintService.getFingerprint(inspirationId);
    const contentExcerpt = (inspiration.content || '').slice(0, LLM_LIMITS.PAIR_CONTENT_EXCERPT);

    return {
      inspirationId,
      title: inspiration.title || '',
      fingerprint: fingerprint || '',
      contentExcerpt
    };
  },

  /**
   * 格式化 BridgeRecord（DB 行 → API 出参）
   * 功能：统一字段命名（camelCase），符合 §10.1 BridgeRecord 契约
   * @private
   * @param {object} row - DB 行
   * @returns {object} BridgeRecord
   */
  _formatBridge(row) {
    return {
      id: row.id,
      inspirationAId: row.inspiration_id,
      inspirationBId: row.inspiration_b_id,
      bridgeType: row.bridge_type,
      reason: row.reason || row.connection || '',
      vectorScore: row.vector_score,
      llmScore: row.llm_score,
      status: row.status,
      createdAt: row.saved_at
    };
  }
};

export default CoalesceScanService;
