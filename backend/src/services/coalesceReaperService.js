// CoalesceReaperService — 跨灵感对账扫描器（架构 §6.5 R4 对账扫描补算）
// 功能：后台周期性扫描全库灵感配对，为尚未生成 candidate 的灵感配对补算
//       embedding cosine 相似度，对 cosine >= 0.3 的配对入队 INCREMENTAL_SCAN
//       让 CoalesceScanService.incrementalUpdate 完成候选对写入（>= 0.5 持久化）
// 实现方式：
//   1. start()：读 app_meta.coalesce_last_reap_at，距今 >= 5 天则 5s 后执行一次；
//      距今 < 5 天则等待剩余毫秒后执行；首次执行后按 5 天周期 setInterval
//   2. reapOnce()：扫描全库灵感，O(n²) 配对计算 cosine，对未生成 candidate 且
//      cosine >= 0.3 的配对入队 INCREMENTAL_SCAN（对较新灵感入队）
//   3. stop()：清理 setTimeout + setInterval
//
// 关键约束：
//   - 灵感数 > 50 时仅对最近 30 天创建的灵感做配对扫描，避免 O(n²) 爆炸
//   - 配对规范化：a < b（字典序），与 coalesce_candidates 表的存储口径一致
//   - 入队目标：配对中较新的那个灵感 id（incrementalUpdate 会扫描它 vs 全库）
//   - 周期：REAPER_INTERVAL_DAYS（默认 5 天）
//   - EmbeddingService 未就绪时静默跳过，不阻塞启动

import { db, getMeta, setMeta } from '../database/db.js';
import EmbeddingService from './embeddingService.js';
import TaskQueue, { TASK_KINDS } from './taskQueue.js';
import { THRESHOLDS, REAPER_INTERVAL_DAYS } from '../config/constants.js';

// reaper 周期对应的毫秒数
const REAPER_INTERVAL_MS = REAPER_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
// 启动后延迟首次执行的毫秒数（避免启动峰值，等 embedding 模型预热）
const STARTUP_DELAY_MS = 5000;
// 灵感数超过此阈值时启用 30 天窗口过滤，避免 O(n²) 爆炸
const REAP_FULL_SCAN_LIMIT = 50;
// 30 天窗口对应的毫秒数
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 执行 SQL 查询并返回所有匹配行（对象数组）
 * 功能：参数化查询封装，供 reapOnce 读取灵感与候选对数据使用
 * 实现方式：prepare → bind → step 循环 → getAsObject → free
 * @param {string} sql - SQL 语句
 * @param {Array} params - 绑定参数
 * @returns {Array<object>}
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
 * 无向对规范化：返回 [a, b] 使得 a < b（字典序）
 * 功能：与 coalesceScanService.normalizePair 保持一致口径，杜绝双向重复
 * @param {string} idA - 灵感 A ID
 * @param {string} idB - 灵感 B ID
 * @returns {[string, string]} 规范化后的 [smaller, larger]
 */
function normalizePair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

/**
 * CoalesceReaperService 单例对象
 * 功能：后台对账扫描器，周期性补算尚未生成 candidate 的灵感配对
 */
export const CoalesceReaperService = {
  // setTimeout 返回的 id（首次延迟执行），供 stop 清理
  _timeoutId: null,
  // setInterval 返回的 id（周期执行），供 stop 清理
  _intervalId: null,

  /**
   * 启动 reaper 周期扫描
   * 功能：根据 app_meta.coalesce_last_reap_at 决定首次执行时机，之后按 5 天周期循环
   * 实现方式：
   *   1. 读 app_meta.coalesce_last_reap_at（时间戳字符串）
   *   2. 不存在或距今 >= 5 天 → setTimeout(reapOnce, 5000)（启动 5 秒后执行，避开启动峰值）
   *   3. 距今 < 5 天 → setTimeout(reapOnce, 剩余毫秒)
   *   4. 首次 reapOnce 执行完毕后，setInterval(reapOnce, 5 天) 周期触发
   *   5. 保存 timeout/interval id 供 stop 清理
   * @returns {void}
   */
  start() {
    const lastReapAt = getMeta('coalesce_last_reap_at');
    const now = Date.now();
    let delay;

    if (!lastReapAt) {
      // 首次启动：从未执行过 reaper，5 秒后执行
      delay = STARTUP_DELAY_MS;
      console.log('[CoalesceReaper] start: no previous reap record, will run in 5s');
    } else {
      const elapsed = now - Number(lastReapAt);
      if (elapsed >= REAPER_INTERVAL_MS) {
        // 距上次扫描 >= 5 天：5 秒后执行
        delay = STARTUP_DELAY_MS;
        console.log(`[CoalesceReaper] start: last reap was ${Math.round(elapsed / 1000 / 60 / 60 / 24)}d ago (>= ${REAPER_INTERVAL_DAYS}d), will run in 5s`);
      } else {
        // 距上次扫描 < 5 天：等待剩余时间后执行
        delay = REAPER_INTERVAL_MS - elapsed;
        console.log(`[CoalesceReaper] start: last reap was recent, will run in ${Math.round(delay / 1000 / 60)}min`);
      }
    }

    // 首次延迟执行 reapOnce，执行后启动周期 interval
    this._timeoutId = setTimeout(async () => {
      await this.reapOnce();
      // 首次执行完毕，启动周期 interval（5 天周期循环触发）
      this._intervalId = setInterval(() => {
        this.reapOnce().catch((err) => {
          console.error('[CoalesceReaper] interval reapOnce failed:', err.message);
        });
      }, REAPER_INTERVAL_MS);
      console.log(`[CoalesceReaper] periodic interval started (every ${REAPER_INTERVAL_DAYS} days)`);
    }, delay);
  },

  /**
   * 执行一次全库对账扫描
   * 功能：扫描全库灵感配对，对尚未生成 candidate 且 cosine >= 0.3 的配对入队 INCREMENTAL_SCAN
   * 实现方式：
   *   1. 健康门：EmbeddingService 未就绪则静默跳过
   *   2. 加载全库灵感（id + created_at），灵感数 > 50 则仅保留最近 30 天创建的
   *   3. 查询 coalesce_candidates 已有配对集合（normalizePair 规范化 key）
   *   4. 加载相关灵感的 embedding 向量
   *   5. O(n²) 配对：跳过已有 candidate 的配对，计算 cosine，>= 0.3 则对较新灵感入队
   *   6. 扫描完成后将当前时间戳写入 app_meta.coalesce_last_reap_at
   * @returns {Promise<void>}
   */
  async reapOnce() {
    console.log('[CoalesceReaper] reapOnce: starting full-library pair scan');

    // ===== 1. 健康门：EmbeddingService 必须就绪 =====
    if (!EmbeddingService.isReady()) {
      console.warn('[CoalesceReaper] reapOnce skipped: embedding model not ready');
      return;
    }

    // ===== 2. 加载全库灵感列表 =====
    // fix：WHERE deleted_at IS NULL — 已软删除（快照中）的灵感不参与对账配对
    let inspirations = queryAll(
      'SELECT id, created_at FROM inspirations WHERE deleted_at IS NULL ORDER BY created_at DESC'
    );

    if (inspirations.length < 2) {
      // 不足 2 个灵感，无需配对扫描，直接更新时间戳
      console.log('[CoalesceReaper] reapOnce: less than 2 inspirations, nothing to scan');
      setMeta('coalesce_last_reap_at', Date.now().toString());
      return;
    }

    // 灵感数 > 50 则仅对最近 30 天创建的灵感做配对扫描，避免 O(n²) 爆炸
    if (inspirations.length > REAP_FULL_SCAN_LIMIT) {
      const cutoff = Date.now() - THIRTY_DAYS_MS;
      const filtered = inspirations.filter((r) => {
        if (!r.created_at) return false;
        return new Date(r.created_at).getTime() >= cutoff;
      });
      console.log(
        `[CoalesceReaper] reapOnce: ${inspirations.length} inspirations > ${REAP_FULL_SCAN_LIMIT}, ` +
        `filtering to last 30 days: ${filtered.length} remaining`
      );
      inspirations = filtered;
    }

    if (inspirations.length < 2) {
      console.log('[CoalesceReaper] reapOnce: less than 2 inspirations after filter, nothing to scan');
      setMeta('coalesce_last_reap_at', Date.now().toString());
      return;
    }

    // ===== 3. 查询 coalesce_candidates 已有配对集合 =====
    // 功能：构建 "a|b" key 集合（normalizePair 规范化），用于 O(1) 跳过已算对
    const existingPairRows = queryAll(
      'SELECT inspiration_id_a, inspiration_id_b FROM coalesce_candidates'
    );
    const existingPairs = new Set();
    for (const row of existingPairRows) {
      // candidates 表中已按 a<b 规范化存储，直接拼 key
      existingPairs.add(`${row.inspiration_id_a}|${row.inspiration_id_b}`);
    }

    // ===== 4. 加载相关灵感的 embedding 向量 =====
    // 功能：构建 inspirationId → 三源向量对象映射，供加权 cosine 计算使用
    const embRows = queryAll(
      'SELECT inspiration_id, embedding, embedding_title, embedding_content FROM inspiration_embeddings WHERE embedding IS NOT NULL AND stale = 0'
    );
    const embMap = new Map();
    for (const row of embRows) {
      embMap.set(row.inspiration_id, EmbeddingService.vecsFromRow(row));
    }

    // ===== 5. O(n²) 配对扫描 =====
    // 对尚未生成 candidate 的配对计算加权相似度，>= 0.3 则对较新灵感入队 INCREMENTAL_SCAN
    let enqueuedCount = 0;
    let skippedNoEmbedding = 0;
    const now = Date.now();

    for (let i = 0; i < inspirations.length; i++) {
      const a = inspirations[i];
      const vecsA = embMap.get(a.id);
      if (!vecsA) {
        skippedNoEmbedding++;
        continue;
      }

      for (let j = i + 1; j < inspirations.length; j++) {
        const b = inspirations[j];
        // 规范化配对 key（a < b 字典序），与 candidates 表存储口径一致
        const [smallerId, largerId] = normalizePair(a.id, b.id);
        const pairKey = `${smallerId}|${largerId}`;

        // 已有 candidate 的配对跳过（增量去重）
        if (existingPairs.has(pairKey)) continue;

        const vecsB = embMap.get(b.id);
        if (!vecsB) continue;

        // 计算加权相似度（三源合成，与 scanService 口径一致）
        const score = EmbeddingService.weightedSimilarity(vecsA, vecsB).score;

        // cosine >= 0.3 的配对入队 INCREMENTAL_SCAN
        if (score >= THRESHOLDS.CANDIDATE) {
          // 对配对中较新的那个灵感 id 入队（incrementalUpdate 会扫描它 vs 全库）
          const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
          const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
          const newerId = timeA >= timeB ? a.id : b.id;

          TaskQueue.enqueue(TASK_KINDS.INCREMENTAL_SCAN, newerId);

          // 标记本轮已入队，防止同一配对重复入队
          existingPairs.add(pairKey);
          enqueuedCount++;
        }
      }
    }

    // ===== 6. 更新 app_meta.coalesce_last_reap_at =====
    setMeta('coalesce_last_reap_at', now.toString());

    console.log(
      `[CoalesceReaper] reapOnce done: enqueued ${enqueuedCount} incremental scans ` +
      `(${skippedNoEmbedding} inspirations skipped due to missing embedding)`
    );
  },

  /**
   * 停止 reaper 周期扫描
   * 功能：清理 setTimeout 和 setInterval，供进程退出（SIGINT/SIGTERM）时调用
   * 实现方式：clearTimeout + clearInterval，重置 id 为 null
   * @returns {void}
   */
  stop() {
    if (this._timeoutId) {
      clearTimeout(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    console.log('[CoalesceReaper] stopped');
  }
};

export default CoalesceReaperService;
