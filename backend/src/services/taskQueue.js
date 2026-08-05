// TaskQueue — 进程内串行后台任务队列（K3 架构改造版）
// 功能：所有 fire-and-forget 后台任务（指纹生成、embedding 计算、chunk embedding、增量扫描、
//       视觉识图、文件提炼）统一经此队列串行执行，避免并发推理抢占与重复计算。
// 实现方式：
//   1. 串行 FIFO：单链队列 + 单 worker 循环（Node 单线程事件循环 + EmbeddingService 推理是 CPU 密集）
//   2. 单飞去重：同 (kind, inspirationId) 在途任务合并，payload 取最后者（防重入）
//   3. 统一 try/catch：失败仅记日志 + 按 kind 标记 stale，永不向请求线程冒泡
//   4. TaskKind 枚举：'fingerprint' | 'embed' | 'chunk_embed' | 'incremental_scan' | 'vision' | 'distill'
//
// 架构文档 §10.3 接口契约：
//   type TaskKind = 'fingerprint' | 'embed' | 'chunk_embed' | 'incremental_scan' | 'vision' | 'distill';
//   interface TaskQueue {
//     enqueue(kind: TaskKind, inspirationId: string, payload?: object): void;
//     // 语义：串行 FIFO；同 (kind, inspirationId) 在途任务去重合并；
//     //       统一 try/catch → 失败记日志并按 kind 标记 stale；永不向请求线程冒泡
//   }
//
// 关键约束（架构 §6.5 + §6.6）：
//   - Node 单线程事件循环；embedding 为 CPU 密集推理，全部经 taskQueue 串行执行
//   - 后台任务异常：taskQueue 统一 catch，记日志 + 实体标 stale，不冒泡至请求线程
//   - fire-and-forget：主流程不等待，stale 标记落库，启动对账扫描补算（R4）
//   - VISION/DISTILL 任务的 LLM 调用失败由 visionService/distillService 内部 withRetry 兜底，
//     taskQueue 仅处理最终抛出的异常（标记失败状态）

import { db, saveDb } from '../database/db.js';
import FingerprintService from './fingerprintService.js';
import EmbeddingService from './embeddingService.js';
// v11 多模态扩展：视觉识图与文件提炼服务
// 无循环依赖（visionService/distillService 均不 import taskQueue），可静态导入
import VisionService from './visionService.js';
import distillService, { computeDistillMode } from './distillService.js';

// 任务类型枚举（架构 §10.3 + v11 多模态扩展）
export const TASK_KINDS = {
  FINGERPRINT: 'fingerprint',           // 生成/更新指纹（含 embedding 重算）
  EMBED: 'embed',                        // 仅重新计算 inspiration embedding（基于已有 fingerprint）
  CHUNK_EMBED: 'chunk_embed',            // 计算单个 chunk 的 embedding（distill 时调用）
  INCREMENTAL_SCAN: 'incremental_scan',  // 增量候选扫描（新灵感 vs 全库，K3-c 实现）
  VISION: 'vision',                      // 视觉识图：图片→中文客观描述，更新 addendum.images_json（v11）
  DISTILL: 'distill'                     // 文件提炼：多文件→title+content，回填 inspirations 表（v11）
};

/**
 * 执行 SQL 查询并返回第一行（对象），无结果返回 null
 * 功能：参数化查询封装，供 VISION/DISTILL 任务读取 addendum/inspiration 数据使用
 * 实现方式：prepare → bind → step → getAsObject → free（与 fingerprintService.queryOne 一致）
 * @param {string} sql - SQL 语句
 * @param {Array} params - 绑定参数
 * @returns {Object|null}
 */
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

// 任务队列状态（模块级变量）
const queue = [];           // 待执行任务数组（FIFO）
const inFlightKeys = new Set();  // 在途任务的 (kind|inspirationId) 键集合，用于去重
let processing = false;     // 是否正在处理任务（避免并发 worker）

/**
 * TaskQueue 单例对象
 * 设计原则：enqueue 同步返回（fire-and-forget），worker 异步串行处理
 */
export const TaskQueue = {
  /**
   * 入队任务（fire-and-forget）
   * 功能：将后台任务加入队列，立即返回不等待
   * 实现方式：
   *   1. 同 (kind, inspirationId) 在途任务：合并 payload（最后者覆盖）后跳过入队
   *   2. 不在途：加入队列末尾
   *   3. 触发 worker 循环（如未启动）
   * @param {string} kind - TASK_KINDS 中的某个值
   * @param {string} inspirationId - 灵感 ID
   * @param {object} [payload={}] - 任务载荷（如 chunk_embed 携带 chunkId + text）
   * @returns {void}
   */
  enqueue(kind, inspirationId, payload = {}) {
    if (!kind || !inspirationId) {
      console.warn('[TaskQueue] enqueue rejected: missing kind or inspirationId');
      return;
    }

    const key = `${kind}|${inspirationId}`;

    // 单飞去重：同 (kind, inspirationId) 在途任务合并 payload，不入队
    if (inFlightKeys.has(key)) {
      // 在队列中找到同 key 的待执行任务，合并 payload（最后者覆盖）
      const existingIdx = queue.findIndex(t => t.key === key);
      if (existingIdx >= 0) {
        queue[existingIdx].payload = { ...queue[existingIdx].payload, ...payload };
        console.log(`[TaskQueue] merged payload for in-flight task ${key}`);
      }
      return;
    }

    // 入队
    queue.push({ kind, inspirationId, payload, key, enqueuedAt: Date.now() });
    console.log(`[TaskQueue] enqueued ${kind} for ${inspirationId} (queue size: ${queue.length})`);

    // 触发 worker（非阻塞）
    this._scheduleProcess();
  },

  /**
   * 调度 worker 处理队列（防重入）
   * 功能：如果未在处理中，启动 worker 循环
   * 实现方式：processing 标志位 + setImmediate（避免栈溢出）
   * @private
   */
  _scheduleProcess() {
    if (processing) return;
    processing = true;
    // setImmediate 确保 enqueue 同步返回，worker 在下一 tick 启动
    setImmediate(() => this._processNext());
  },

  /**
   * 处理队列中的下一个任务
   * 功能：取出队首任务 → 标记在途 → 执行 → 清除在途 → 处理下一个
   * 实现方式：
   *   1. 队列为空：清 processing 标志，退出
   *   2. 取队首 → inFlightKeys.add(key)
   *   3. try { 执行任务 } catch { 统一错误处理 }
   *   4. finally { inFlightKeys.delete(key) }
   *   5. setImmediate 递归处理下一个（让出事件循环）
   * @private
   */
  async _processNext() {
    // 队列为空：清标志退出
    if (queue.length === 0) {
      processing = false;
      return;
    }

    // 取队首任务
    const task = queue.shift();
    task.startedAt = Date.now();
    const waitMs = task.startedAt - task.enqueuedAt;
    console.log(`[TaskQueue] processing ${task.kind} for ${task.inspirationId} (waited ${waitMs}ms)`);

    try {
      // 标记在途
      inFlightKeys.add(task.key);

      // 分发到对应 handler
      await this._dispatch(task);

      console.log(`[TaskQueue] ✅ ${task.kind} done for ${task.inspirationId} (${Date.now() - task.startedAt}ms)`);
    } catch (err) {
      // 统一错误处理：记日志 + 按 kind 标记 stale
      console.error(`[TaskQueue] ❌ ${task.kind} failed for ${task.inspirationId}:`, err.message);
      this._handleFailure(task, err);
    } finally {
      // 清除在途标记
      inFlightKeys.delete(task.key);
    }

    // 让出事件循环后处理下一个（避免长时间阻塞）
    setImmediate(() => this._processNext());
  },

  /**
   * 分发任务到对应 handler
   * 功能：根据 kind 调用对应 service
   * 实现方式：switch case，每个 kind 对应一个 handler
   * @private
   * @param {{ kind: string, inspirationId: string, payload: object }} task
   */
  async _dispatch(task) {
    const { kind, inspirationId, payload } = task;

    switch (kind) {
      case TASK_KINDS.FINGERPRINT:
        // 生成指纹 + 计算并写入 embedding
        return await this._handleFingerprint(inspirationId);

      case TASK_KINDS.EMBED:
        // 仅重新计算 embedding（基于已有 fingerprint）
        return await this._handleEmbed(inspirationId);

      case TASK_KINDS.CHUNK_EMBED:
        // 计算单个 chunk 的 embedding
        return await this._handleChunkEmbed(inspirationId, payload);

      case TASK_KINDS.INCREMENTAL_SCAN:
        // 增量候选扫描（K3-c 实现，本里程碑留 stub）
        return await this._handleIncrementalScan(inspirationId);

      case TASK_KINDS.VISION:
        // 视觉识图：图片→中文客观描述，更新 addendum.images_json 对应条目（v11）
        return await this._handleVision(payload);

      case TASK_KINDS.DISTILL:
        // 文件提炼：多文件→title+content，回填 inspirations 表 + 入队 FINGERPRINT（v11）
        return await this._handleDistill(inspirationId);

      default:
        console.warn(`[TaskQueue] unknown task kind: ${kind}`);
    }
  },

  /**
   * 处理 fingerprint 任务
   * 功能：生成指纹 → 用指纹计算 embedding → 写入 inspiration_embeddings.embedding 列 + stale=0
   * 实现方式：
   *   1. FingerprintService.generate 生成指纹（已落库 stale=1）
   *   2. EmbeddingService.embed(fingerprint) 得到 384 维向量
   *   3. UPDATE inspiration_embeddings SET embedding=?, model_name=?, stale=0, embedding_updated_at=?
   *   4. 成功后入队 INCREMENTAL_SCAN（新灵感 vs 全库候选对更新，架构 §6.1 流程一）
   * @private
   * @param {string} inspirationId
   */
  async _handleFingerprint(inspirationId) {
    // 1. 生成指纹（已落库 stale=1）
    const { fingerprint } = await FingerprintService.generate({ inspirationId });

    // 2. 计算 embedding
    const vec = await EmbeddingService.embed(fingerprint);

    // 3. 写入 embedding BLOB + stale=0
    const blob = EmbeddingService.toBlob(vec);
    const now = new Date().toISOString();
    db.run(
      `UPDATE inspiration_embeddings
       SET embedding = ?, model_name = ?, stale = 0, embedding_updated_at = ?
       WHERE inspiration_id = ?`,
      [blob, EmbeddingService.modelName, now, inspirationId]
    );
    saveDb();
    console.log(`[TaskQueue] embedding saved for ${inspirationId} (dim=${vec.length}, stale=0)`);

    // 4. 入队增量扫描（新灵感 vs 全库候选对更新，架构 §6.1 流程一）
    //    不阻塞当前任务完成；若 embedding 未 ready 则 incrementalUpdate 内部静默跳过
    this.enqueue(TASK_KINDS.INCREMENTAL_SCAN, inspirationId);
  },

  /**
   * 处理 embed 任务（仅重新计算 embedding，不重算指纹）
   * 功能：读已有 fingerprint → embed → 写 BLOB + stale=0
   * 实现方式：与 _handleFingerprint 类似但跳过 generate
   * @private
   * @param {string} inspirationId
   */
  async _handleEmbed(inspirationId) {
    const fingerprint = FingerprintService.getFingerprint(inspirationId);
    if (!fingerprint) {
      // 无指纹：升级为 fingerprint 任务
      console.log(`[TaskQueue] no fingerprint for ${inspirationId}, upgrading to fingerprint task`);
      return await this._handleFingerprint(inspirationId);
    }

    const vec = await EmbeddingService.embed(fingerprint);
    const blob = EmbeddingService.toBlob(vec);
    const now = new Date().toISOString();
    db.run(
      `UPDATE inspiration_embeddings
       SET embedding = ?, model_name = ?, stale = 0, embedding_updated_at = ?
       WHERE inspiration_id = ?`,
      [blob, EmbeddingService.modelName, now, inspirationId]
    );
    saveDb();
    console.log(`[TaskQueue] embedding refreshed for ${inspirationId} (dim=${vec.length})`);
  },

  /**
   * 处理 chunk_embed 任务（distill 时调用）
   * 功能：计算单个 chunk 的 embedding，写入 chunk_embeddings 表
   * 实现方式：
   *   1. 从 payload 取 chunkId + text
   *   2. EmbeddingService.embed(text) 得到向量
   *   3. INSERT OR REPLACE INTO chunk_embeddings
   * @private
   * @param {string} inspirationId - 灵感 ID（仅用于日志）
   * @param {{ chunkId?: string, text?: string }} payload
   */
  async _handleChunkEmbed(inspirationId, payload) {
    const { chunkId, text } = payload;
    if (!chunkId || !text) {
      console.warn(`[TaskQueue] chunk_embed missing chunkId or text for ${inspirationId}`);
      return;
    }

    const vec = await EmbeddingService.embed(text);
    const blob = EmbeddingService.toBlob(vec);
    const now = new Date().toISOString();
    db.run(
      `INSERT OR REPLACE INTO chunk_embeddings (chunk_id, embedding, model_name, updated_at)
       VALUES (?, ?, ?, ?)`,
      [chunkId, blob, EmbeddingService.modelName, now]
    );
    saveDb();
    console.log(`[TaskQueue] chunk embedding saved for ${chunkId} (dim=${vec.length})`);
  },

  /**
   * 处理 incremental_scan 任务（K3-c 实现）
   * 功能：新灵感 vs 全库 cosine，≥0.5 写 coalesce_candidates（不触发 LLM 深挖）
   * 实现方式：委托给 CoalesceScanService.incrementalUpdate（动态 import 避免循环依赖）
   *   - CoalesceScanService 内部处理 ensureFingerprint + cosine + 写候选对
   *   - 失败时由本队列统一 catch 记日志（不冒泡至请求线程）
   *   - 仅为新灵感 vs 全库的增量扫描，不重复扫描已有对（增量去重）
   * @private
   * @param {string} inspirationId
   */
  async _handleIncrementalScan(inspirationId) {
    // 动态 import 避免循环依赖（CoalesceScanService → taskQueue 用于 bridgeToInspiration）
    const { CoalesceScanService } = await import('./coalesceScanService.js');
    await CoalesceScanService.incrementalUpdate(inspirationId);
  },

  /**
   * 处理 vision 任务（v11 多模态扩展）
   * 功能：调用视觉模型对追加条目中的图片生成客观中文描述，
   *       将描述回写到 inspiration_addenda.images_json 中对应 filename 条目的 description 字段，
   *       并把该条目 status 从 'generating' 置为 'ready'（前端可据此显示"纳入正文"按钮）
   * 实现方式：
   *   1. 从 payload 取 addendumId + filename（缺失则告警返回）
   *   2. 调 VisionService.describeForAddendum 获取 description（LLM 调用由 service 内部 withRetry 兜底）
   *   3. 查 addendum 行 → 解析 images_json → 找到对应 filename 条目 → 更新 description + status='ready'
   *   4. UPDATE inspiration_addenda SET images_json=? + updated_at=? WHERE id=?
   *   5. addendum 不存在或 images_json 中找不到对应条目时静默跳过（仅 console.warn）
   * @private
   * @param {{ addendumId?: string, filename?: string }} payload - 追加条目 ID + 图片文件名
   */
  async _handleVision(payload) {
    const { addendumId, filename } = payload || {};
    if (!addendumId || !filename) {
      console.warn('[TaskQueue] vision missing addendumId or filename in payload');
      return;
    }

    // 1. 调视觉模型生成描述（LLM 失败由 visionService 内部 withRetry 兜底，仍失败则向上抛错）
    const { description } = await VisionService.describeForAddendum({ addendumId, filename });

    // 2. 读 addendum 行（addendum 不存在时静默跳过）
    const row = queryOne(
      'SELECT images_json FROM inspiration_addenda WHERE id = ?',
      [addendumId]
    );
    if (!row) {
      console.warn(`[TaskQueue] vision: addendum not found ${addendumId}, skip update`);
      return;
    }

    // 3. 解析 images_json → 找到对应 filename 条目 → 更新 description + status='ready'
    let images = [];
    try {
      images = row.images_json ? JSON.parse(row.images_json) : [];
    } catch (e) {
      console.warn(`[TaskQueue] vision: images_json parse failed for ${addendumId}: ${e.message}`);
      return;
    }
    const idx = images.findIndex(img => img && img.filename === filename);
    if (idx < 0) {
      // images_json 中找不到对应条目：可能已被用户删除，静默跳过
      console.warn(`[TaskQueue] vision: image entry not found in images_json: ${filename}`);
      return;
    }
    images[idx].description = description;
    images[idx].status = 'ready';

    // 4. 写回 images_json + 更新 updated_at
    const now = new Date().toISOString();
    db.run(
      'UPDATE inspiration_addenda SET images_json = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(images), now, addendumId]
    );
    saveDb();
    console.log(`[TaskQueue] vision done: addendum=${addendumId}, file=${filename}, descLen=${description.length}`);
  },

  /**
   * 处理 distill 任务（v11 多模态扩展 + v12 按需提炼）
   * 功能：调用 LLM 从灵感关联的多个文本文件按需提炼 title / content，回填到 inspirations 表，
   *       仅把 AI 生成的字段标记 title_ai_generated=1 / content_ai_generated=1（用户已有字段置 0），
   *       然后入队 FINGERPRINT 任务，基于新回填的内容重算指纹与 embedding
   * 实现方式：
   *   1. 调 distillService.distillForInspiration(inspirationId) 获取 { title, content, mode }
   *      （读 source_files_json + 当前 title/content → 计算提炼模式 → 读文件 → 合并 → LLM 按需提炼）
   *   2. 按 mode 设置 ai_generated 标记：
   *      - mode='both'：title_ai_generated=1, content_ai_generated=1
   *      - mode='title'：title_ai_generated=1, content_ai_generated=0（内容为用户已有）
   *      - mode='content'：title_ai_generated=0, content_ai_generated=1（标题为用户已有）
   *   3. UPDATE inspirations SET title=?, content=?, 对应 ai_generated 标记
   *   4. 入队 FINGERPRINT 任务（沿用现有 enqueue(TASK_KINDS.FINGERPRINT, inspirationId) 模式）
   *      —— FINGERPRINT 内部会重算指纹 + embedding + 入队 INCREMENTAL_SCAN
   * @private
   * @param {string} inspirationId - 灵感 ID
   */
  async _handleDistill(inspirationId) {
    // 1. 调 LLM 按需提炼 title + content（LLM 失败由 distillService 内部 withRetry 兜底，仍失败则向上抛错）
    const { title, content, mode } = await distillService.distillForInspiration(inspirationId);

    // 2. 按提炼模式计算 ai_generated 标记：仅 AI 生成的字段置 1（待确认），用户已有字段置 0
    const titleAI = (mode === 'both' || mode === 'title') ? 1 : 0;
    const contentAI = (mode === 'both' || mode === 'content') ? 1 : 0;

    // 3. 回填 inspirations 表 + 标记 AI 生成待确认（按字段）
    db.run(
      `UPDATE inspirations
       SET title = ?, content = ?, title_ai_generated = ?, content_ai_generated = ?
       WHERE id = ?`,
      [title, content, titleAI, contentAI, inspirationId]
    );
    saveDb();
    console.log(`[TaskQueue] distill done [mode=${mode}]: inspiration=${inspirationId}, title="${title}", contentLen=${content.length}`);

    // 4. 入队 FINGERPRINT 任务，基于新回填内容重算指纹 + embedding（沿用 _handleFingerprint 末尾 enqueue 模式）
    //    不阻塞当前任务完成；FINGERPRINT 内部会继续入队 INCREMENTAL_SCAN
    this.enqueue(TASK_KINDS.FINGERPRINT, inspirationId);
  },

  /**
   * 统一失败处理：按 kind 标记 stale / failed
   * 功能：根据任务类型决定如何标记失败
   * 实现方式：
   *   - fingerprint/embed：markStale（下次 ensureFresh 重算）
   *   - chunk_embed：仅记日志（chunk 级失败不阻塞灵感级）
   *   - incremental_scan：仅记日志（下次显式 scan 会重算）
   *   - vision：UPDATE images_json 对应条目 status='failed'（前端显示"重试识图"按钮）；
   *             addendum 不存在则静默跳过
   *   - distill：UPDATE inspirations SET title_ai_generated=2, content_ai_generated=2
   *             （2 = 提炼失败标记，前端显示"重试提炼"按钮；灵感行保留，不入队 FINGERPRINT）
   * @private
   * @param {{ kind: string, inspirationId: string, payload?: object }} task
   * @param {Error} err
   */
  _handleFailure(task, err) {
    const { kind, inspirationId, payload } = task;

    switch (kind) {
      case TASK_KINDS.FINGERPRINT:
      case TASK_KINDS.EMBED:
        // 灵感级失败：标记 stale，下次 ensureFresh 重算
        FingerprintService.markStale(inspirationId).catch(e => {
          console.error(`[TaskQueue] markStale also failed for ${inspirationId}:`, e.message);
        });
        break;

      case TASK_KINDS.CHUNK_EMBED:
        // chunk 级失败：仅记日志，不阻塞灵感级
        console.warn(`[TaskQueue] chunk_embed failed, chunk will be skipped in recall: ${err.message}`);
        break;

      case TASK_KINDS.INCREMENTAL_SCAN:
        // 增量扫描失败：仅记日志，下次显式 scan 会重算
        console.warn(`[TaskQueue] incremental_scan failed, will retry on next explicit scan: ${err.message}`);
        break;

      case TASK_KINDS.VISION: {
        // 视觉识图失败：把 images_json 中对应 filename 条目 status 置为 'failed'
        // 功能：前端据此显示"重试识图"按钮，用户可重新触发
        // 实现方式：查 addendum → 解析 images_json → 找到对应 filename → UPDATE status='failed' → 写回
        //           addendum 不存在或条目缺失时静默跳过（仅 console.warn）
        const { addendumId, filename } = payload || {};
        if (!addendumId || !filename) {
          console.warn(`[TaskQueue] vision failed and payload missing addendumId/filename: ${err.message}`);
          break;
        }
        try {
          const row = queryOne(
            'SELECT images_json FROM inspiration_addenda WHERE id = ?',
            [addendumId]
          );
          if (!row) {
            // addendum 已被删除：静默跳过
            console.warn(`[TaskQueue] vision failed but addendum not found ${addendumId}, skip marking`);
            break;
          }
          let images = [];
          try {
            images = row.images_json ? JSON.parse(row.images_json) : [];
          } catch (e) {
            console.warn(`[TaskQueue] vision failed and images_json parse error for ${addendumId}: ${e.message}`);
            break;
          }
          const idx = images.findIndex(img => img && img.filename === filename);
          if (idx < 0) {
            // images_json 中找不到对应条目：可能已被用户删除，静默跳过
            console.warn(`[TaskQueue] vision failed but image entry not found: ${filename}`);
            break;
          }
          images[idx].status = 'failed';
          const now = new Date().toISOString();
          db.run(
            'UPDATE inspiration_addenda SET images_json = ?, updated_at = ? WHERE id = ?',
            [JSON.stringify(images), now, addendumId]
          );
          saveDb();
          console.warn(`[TaskQueue] vision marked failed: addendum=${addendumId}, file=${filename}, err=${err.message}`);
        } catch (markErr) {
          // 标记失败本身失败：仅记日志，不阻塞队列后续任务
          console.error(`[TaskQueue] vision markFailed also failed for ${addendumId}/${filename}:`, markErr.message);
        }
        break;
      }

      case TASK_KINDS.DISTILL: {
        // 文件提炼失败：仅标记"需要生成但失败"的字段 =2（v12 按需提炼）
        // 功能：前端检测到 ai_generated=2 时显示"重试提炼"按钮，用户可重新触发 triggerDistill
        // 实现方式：
        //   1. 读当前 title/content → computeDistillMode 计算哪些字段需要生成
        //   2. 只把需要生成的字段置 2（用户已有字段保持原值，不误标失败）
        //   —— 不入队 FINGERPRINT（避免基于失败的内容重算指纹）
        //   —— 灵感行保留（用户可手动编辑，或重试提炼）
        // 语义约定：0=用户手写/已接受，1=AI生成待确认，2=AI提炼失败，3=AI提炼中（v12）
        try {
          // 读当前 title/content 计算提炼模式（行不存在时兜底为全失败标记）
          const row = queryOne('SELECT title, content FROM inspirations WHERE id = ?', [inspirationId]);
          let needTitle = true;
          let needContent = true;
          if (row) {
            const mode = computeDistillMode(row.title, row.content);
            needTitle = (mode === 'both' || mode === 'title');
            needContent = (mode === 'both' || mode === 'content');
          }
          // 组装 UPDATE：只标记需要生成但失败的字段
          const sets = [];
          const params = [];
          if (needTitle) sets.push('title_ai_generated = 2');
          if (needContent) sets.push('content_ai_generated = 2');
          if (sets.length > 0) {
            params.push(inspirationId);
            db.run(`UPDATE inspirations SET ${sets.join(', ')} WHERE id = ?`, params);
            saveDb();
          }
          console.warn(`[TaskQueue] distill marked failed: inspiration=${inspirationId}, fields=[${sets.join(',')}], err=${err.message}`);
        } catch (markErr) {
          console.error(`[TaskQueue] distill markFailed also failed for ${inspirationId}:`, markErr.message);
        }
        break;
      }

      default:
        console.warn(`[TaskQueue] unknown task kind on failure: ${kind}`);
    }
  },

  /**
   * 获取队列状态（供健康检查使用）
   * 功能：返回当前队列长度与在途任务数
   * 实现方式：读模块级变量
   * @returns {{ queueLength: number, inFlightCount: number, isProcessing: boolean }}
   */
  getStatus() {
    return {
      queueLength: queue.length,
      inFlightCount: inFlightKeys.size,
      isProcessing: processing
    };
  },

  /**
   * 等待队列清空（供测试或关闭时使用）
   * 功能：阻塞直到队列所有任务处理完毕
   * 实现方式：轮询 getStatus，每 100ms 检查一次
   * @param {number} timeoutMs - 超时时间，默认 30s
   * @returns {Promise<boolean>} 是否在超时前清空
   */
  async drain(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (queue.length === 0 && !processing) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }
};

export default TaskQueue;
