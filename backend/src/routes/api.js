// API 路由 — 挂载所有后端 REST 端点
// 路由顺序：静态路由（/health、/search）必须在 /:id 之前，避免被参数路由吞掉

import express from 'express';
import * as controller from '../controllers/inspirationController.js';
import * as archiveController from '../controllers/archiveController.js';
// v11 多模态扩展：上传 inspiration 源文件依赖 addendumController 导出的 multer 实例与控制器方法
//   - uploadFiles：multer 实例（非控制器方法），storage 指向 uploads/neoidea/
//   - uploadInspirationFiles：控制器方法，返回文件元数据数组
import * as addendumCtrl from '../controllers/addendumController.js';
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
// v12 快照机制：DELETE 改为软删除（灵感进入快照区，30 天内可恢复）
router.delete('/inspirations/:id', controller.remove);

// ========== v12 快照（软删除/回收站）端点 ==========
// 功能：列表 / 恢复 / 物理删除，供设置面板"快照管理"区块使用
// 路由前缀 /snapshots 不与 /inspirations/:id 冲突（独立资源路径）
router.get('/snapshots', controller.listSnapshots);
router.post('/snapshots/:id/restore', controller.restoreSnapshot);
router.delete('/snapshots/:id', controller.purgeSnapshot);

// 灵感文件存储：初始化、面板状态
router.post('/inspirations/:id/storage/init', controller.initStorage);
router.post('/inspirations/:id/panel-state', controller.savePanelState);
router.get('/inspirations/:id/panel-state', controller.getPanelState);

// 档案馆聚合接口（K3-d 新增，§9.2 契约）
// 功能：Detail 唯一数据源，合并三阶段产物 + 徽章口径
router.get('/inspirations/:id/archive', archiveController.getArchive);

// v8 新增：移动灵感到文件夹
router.patch('/inspirations/:id/move', controller.moveToFolder);

// v11 多模态扩展：新建灵感源文件上传
// 功能：POST /inspirations/:id/files，multipart/form-data 字段名 files（多文件，最多 10 个）
// 实现：uploadFiles 是 multer 实例（导出自 addendumController，storage 指向 uploads/neoidea/），
//       uploadInspirationFiles 是控制器方法（同样导出自 addendumController，返回文件元数据数组）
// 顺序：参数路径 /inspirations/:id/files 不与静态路径 /inspirations/search、/inspirations/reorder 冲突
router.post('/inspirations/:id/files', addendumCtrl.uploadFiles.array('files', 10), addendumCtrl.uploadInspirationFiles);

// v11 多模态扩展：手动触发 DISTILL 任务（后台回填 title + content）
// 功能：POST /inspirations/:id/distill，校验灵感存在 → 入队 DISTILL → 返回 {queued: true}
// 实现：triggerDistill 是 inspirationController 的控制器方法
router.post('/inspirations/:id/distill', controller.triggerDistill);

// v11 多模态扩展：读取灵感源文件原文内容
// 功能：GET /inspirations/:id/files/:filename，校验 filename 属于该灵感后返回文本内容
// 用途：Detail 面板的"展开原文"浮窗展示
router.get('/inspirations/:id/files/:filename', controller.getFileContent);

export default router;
