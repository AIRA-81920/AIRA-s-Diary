// Coalesce 路由（K3 架构改造版）
// 功能：挂载 Coalesce 相关端点，遵循架构 §9.3 接口契约
// 实现方式：express.Router + 控制器方法绑定
//
// 路由清单（架构 §9.3）：
//   POST   /inspirations/:id/coalesce/scan              — 显式扫描（触发 LLM 深挖）
//   GET    /coalesce/graph                                — 力导向图全量数据
//   PATCH  /coalesce/bridges/:bridgeId                   — 策展（confirm/dismiss）
//   POST   /coalesce/bridges/:bridgeId/to-inspiration    — 桥梁转新灵感
//
// 向后兼容（旧前端过渡期保留）：
//   GET    /inspirations/:id/coalesce/candidates         — 候选对列表
//   GET    /inspirations/:id/coalesce/bridges            — 灵感相关桥梁列表

import express from 'express';
import * as ctrl from '../controllers/coalesceController.js';

const router = express.Router();

// ========== 新架构核心端点（§9.3）==========

// 显式扫描：触发为指定灵感发现跨灵感桥梁（含 LLM 深挖）
// 端点：POST /api/inspirations/:id/coalesce/scan
router.post('/inspirations/:id/coalesce/scan', ctrl.scan);

// 力导向图全量数据：返回 nodes + edges（dismissed 不下发）
// 端点：GET /api/coalesce/graph
router.get('/coalesce/graph', ctrl.getGraph);

// 策展：确认或忽略桥梁（幂等）
// 端点：PATCH /api/coalesce/bridges/:bridgeId
// body: { action: 'confirm' | 'dismiss' }
router.patch('/coalesce/bridges/:bridgeId', ctrl.curateBridge);

// 桥梁转新灵感：以 bridge.reason 为内容创建新灵感
// 端点：POST /api/coalesce/bridges/:bridgeId/to-inspiration
router.post('/coalesce/bridges/:bridgeId/to-inspiration', ctrl.bridgeToInspiration);

// ========== 向后兼容端点（过渡期保留，新前端不应使用）==========

// 候选对列表（旧前端使用，新前端直接 scan + graph）
router.get('/inspirations/:id/coalesce/candidates', ctrl.getCandidates);

// 灵感相关桥梁列表（旧前端使用，新前端使用 graph）
router.get('/inspirations/:id/coalesce/bridges', ctrl.getBridges);

export default router;
