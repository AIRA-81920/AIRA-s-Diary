// Coalesce 控制器（K3 架构改造版）
// 功能：处理 Coalesce 相关 HTTP 请求，调用 CoalesceScanService
// 实现方式：每个方法 try/catch，按架构 §9 错误码映射 HTTP 状态码
//
// 架构文档 §9.3 Coalesce 接口契约：
//   POST   /api/inspirations/:id/coalesce/scan        → ScanResponse
//   GET    /api/coalesce/graph                         → GraphResponse
//   PATCH  /api/coalesce/bridges/:bridgeId             → BridgeRecord（body: { action: 'confirm'|'dismiss' }）
//   POST   /api/coalesce/bridges/:bridgeId/to-inspiration → { inspiration, sourceBridgeId }
//
// 错误码 → HTTP 映射（架构 §9.1）：
//   EMBEDDING_UNAVAILABLE        → 503
//   INSUFFICIENT_INSPIRATIONS    → 400
//   FINGERPRINT_STALE            → 503
//   LLM_TIMEOUT                  → 504
//   LLM_RATE_LIMITED             → 429
//   LLM_OUTPUT_INVALID           → 502
//   LLM_NOT_CONFIGURED           → 500
//   NOT_FOUND                    → 404
//   VALIDATION_FAILED            → 400
//   其他                          → 500

import { CoalesceScanService } from '../services/coalesceScanService.js';

// 错误码 → HTTP 状态码映射表
const ERROR_HTTP_STATUS = {
  EMBEDDING_UNAVAILABLE: 503,
  INSUFFICIENT_INSPIRATIONS: 400,
  FINGERPRINT_STALE: 503,
  LLM_TIMEOUT: 504,
  LLM_RATE_LIMITED: 429,
  LLM_OUTPUT_INVALID: 502,
  LLM_NOT_CONFIGURED: 500,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  DEEPEN_INVALID_INPUT: 400
};

/**
 * 统一错误响应
 * 功能：根据 err.code 映射 HTTP 状态码，返回标准错误 JSON
 * 实现方式：查表 ERROR_HTTP_STATUS，未知 code 默认 500
 * @param {object} res - Express response
 * @param {Error} err - 错误对象
 */
function sendError(res, err) {
  const status = ERROR_HTTP_STATUS[err.code] || 500;
  console.warn(`[CoalesceController] ${err.code || 'UNKNOWN'} → ${status}: ${err.message}`);
  res.status(status).json({
    success: false,
    error: err.message,
    code: err.code || 'INTERNAL_ERROR'
  });
}

/**
 * 显式扫描：触发为指定灵感发现跨灵感桥梁
 * 功能：调用 CoalesceScanService.scanFor，返回扫描结果
 * 端点：POST /api/inspirations/:id/coalesce/scan
 * @param {object} req - Express request（req.params.id 为灵感 ID）
 * @param {object} res - Express response
 */
export async function scan(req, res) {
  try {
    const { id } = req.params;
    if (!id) {
      const e = new Error('inspirationId is required');
      e.code = 'VALIDATION_FAILED';
      return sendError(res, e);
    }
    const result = await CoalesceScanService.scanFor(id);
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * 全量扫描（灵感网络左下角"扫描桥梁"按钮触发）
 * 功能：遍历全部灵感两两召回 + LLM 深挖，补齐所有缺失桥梁
 * 端点：POST /api/coalesce/scan-all
 * @param {object} req - Express request
 * @param {object} res - Express response
 */
export async function scanAll(req, res) {
  try {
    const result = await CoalesceScanService.scanAll();
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * 获取力导向图数据
 * 功能：返回 nodes + edges，dismissed 桥梁不下发
 * 端点：GET /api/coalesce/graph
 * @param {object} req - Express request
 * @param {object} res - Express response
 */
export async function getGraph(req, res) {
  try {
    const graph = await CoalesceScanService.getGraph();
    res.json({ success: true, data: graph });
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * 策展：确认或忽略桥梁
 * 功能：更新 coalesce_bridges.status，幂等
 * 端点：PATCH /api/coalesce/bridges/:bridgeId
 * @param {object} req - Express request（req.params.bridgeId, req.body.action）
 * @param {object} res - Express response
 */
export async function curateBridge(req, res) {
  try {
    const { bridgeId } = req.params;
    const { action } = req.body;
    if (!bridgeId) {
      const e = new Error('bridgeId is required');
      e.code = 'VALIDATION_FAILED';
      return sendError(res, e);
    }
    const bridge = await CoalesceScanService.curate(bridgeId, action);
    res.json({ success: true, data: bridge });
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * 桥梁转新灵感
 * 功能：以 bridge.reason 为新灵感 content 创建灵感，走后台语义化（不自动扫描，R10）
 * 端点：POST /api/coalesce/bridges/:bridgeId/to-inspiration
 * @param {object} req - Express request（req.params.bridgeId）
 * @param {object} res - Express response
 */
export async function bridgeToInspiration(req, res) {
  try {
    const { bridgeId } = req.params;
    if (!bridgeId) {
      const e = new Error('bridgeId is required');
      e.code = 'VALIDATION_FAILED';
      return sendError(res, e);
    }
    const result = await CoalesceScanService.bridgeToInspiration(bridgeId);
    res.status(201).json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
}

// ========== 向后兼容方法（旧前端可能仍在调用，将逐步废弃）==========

/**
 * 获取候选对（向后兼容，新前端应使用 scan 触发后直接查 graph）
 * 功能：返回 coalesce_candidates 表中 pending 候选对
 * 端点：GET /api/inspirations/:id/coalesce/candidates
 * @deprecated 新架构下候选对不再单独暴露，由 scan 直接产出 bridges
 */
export async function getCandidates(req, res) {
  try {
    const { id } = req.params;
    // 直接返回 coalesce_candidates 表中的候选对（不含 chunk 字段，ADR-5）
    const { db } = await import('../database/db.js');
    const stmt = db.prepare(
      `SELECT id, inspiration_id_a, inspiration_id_b, vector_score, status, created_at
       FROM coalesce_candidates
       WHERE inspiration_id_a = ? OR inspiration_id_b = ?
       ORDER BY vector_score DESC`
    );
    stmt.bind([id, id]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    res.json({ success: true, data: rows });
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * 获取已存桥梁（向后兼容，新前端应使用 graph）
 * 功能：返回指定灵感相关的所有桥梁
 * 端点：GET /api/inspirations/:id/coalesce/bridges
 * @deprecated 新架构下桥梁通过 graph 接口下发
 */
export async function getBridges(req, res) {
  try {
    const { id } = req.params;
    const { db } = await import('../database/db.js');
    const stmt = db.prepare(
      `SELECT id, inspiration_id, inspiration_b_id, bridge_type, reason, connection,
              vector_score, llm_score, status, saved_at
       FROM coalesce_bridges
       WHERE inspiration_id = ? OR inspiration_b_id = ?
       ORDER BY saved_at DESC`
    );
    stmt.bind([id, id]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    res.json({ success: true, data: rows });
  } catch (err) {
    sendError(res, err);
  }
}

// ========== 网络图待办徽章端点（pending-count / mark-seen）==========

/**
 * 获取 pending 桥梁数量与上次查看时间
 * 功能：返回 pending 状态桥梁数量（供前端显示未策展待办徽章）+ 上次查看网络图时间戳
 * 端点：GET /api/coalesce/pending-count
 * @param {object} req - Express request
 * @param {object} res - Express response
 */
export async function getPendingCount(req, res) {
  try {
    const result = await CoalesceScanService.getPendingCount();
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * 标记网络图已被用户查看
 * 功能：将当前时间戳写入 app_meta.coalesce_last_seen_at，供前端判断是否有新桥梁
 * 端点：POST /api/coalesce/mark-seen
 * @param {object} req - Express request
 * @param {object} res - Express response
 */
export async function markNetworkSeen(req, res) {
  try {
    const result = await CoalesceScanService.markNetworkSeen();
    res.json({ success: true, data: result });
  } catch (err) {
    sendError(res, err);
  }
}
