// Assimilate 消化路由（C 方案）
// 功能：挂载 /inspirations/:id/assimilate/* 系列端点
// 实现方式：express.Router + 控制器方法绑定

import express from 'express';
import * as ctrl from '../controllers/assimilateController.js';

const router = express.Router();

// 查询待消化内容数量（GET）
router.get('/inspirations/:id/assimilate/status', ctrl.status);

// 触发 AI 分析（POST）
router.post('/inspirations/:id/assimilate/analyze', ctrl.analyze);

// 用户确认/拒绝提议（POST，body 含 proposal + acceptedRevisions + acceptedMaterials）
router.post('/inspirations/:id/assimilate/confirm', ctrl.confirm);

export default router;
