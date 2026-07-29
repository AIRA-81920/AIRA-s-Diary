// API 路由 — 挂载所有后端 REST 端点
// 路由顺序：静态路由（/health、/search）必须在 /:id 之前，避免被参数路由吞掉

import express from 'express';
import * as controller from '../controllers/inspirationController.js';
import * as archiveController from '../controllers/archiveController.js';
import { db, CURRENT_VERSION } from '../database/db.js';
import { EmbeddingService } from '../services/embeddingService.js';

const router = express.Router();

// 健康检查端点（架构 §11 契约）
// 返回：{ db, embeddingModel: 'ready'|'failed', migrations: number, timestamp }
// 实现：
//   1. db 状态：尝试 SELECT 1，成功 'ok'，失败 'failed'
//   2. embeddingModel：EmbeddingService.isReady() → 'ready' | 'failed'
//   3. migrations：当前数据库迁移版本号（CURRENT_VERSION）
router.get('/health', (req, res) => {
  let dbStatus = 'ok';
  try {
    db.exec('SELECT 1');
  } catch {
    dbStatus = 'failed';
  }
  const embeddingStatus = EmbeddingService.isReady() ? 'ready' : 'failed';
  res.json({
    db: dbStatus,
    embeddingModel: embeddingStatus,
    migrations: CURRENT_VERSION,
    timestamp: new Date().toISOString()
  });
});

// 灵感搜索（必须在 /:id 之前定义，否则 "search" 会被当作 id 参数）
router.get('/inspirations/search', controller.search);

// v8 新增：灵感批量排序（必须在 /:id 之前）
router.put('/inspirations/reorder', controller.reorder);

// 灵感列表与创建
router.get('/inspirations', controller.list);
router.post('/inspirations', controller.create);

// 单个灵感：获取/更新/删除
router.get('/inspirations/:id', controller.get);
router.put('/inspirations/:id', controller.update);
router.delete('/inspirations/:id', controller.remove);

// 灵感文件存储：初始化、面板状态
router.post('/inspirations/:id/storage/init', controller.initStorage);
router.post('/inspirations/:id/panel-state', controller.savePanelState);
router.get('/inspirations/:id/panel-state', controller.getPanelState);

// 档案馆聚合接口（K3-d 新增，§9.2 契约）
// 功能：Detail 唯一数据源，合并三阶段产物 + 徽章口径
router.get('/inspirations/:id/archive', archiveController.getArchive);

// v8 新增：移动灵感到文件夹
router.patch('/inspirations/:id/move', controller.moveToFolder);

export default router;
