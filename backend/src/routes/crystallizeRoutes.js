// 结晶流程路由（M3-b 改造版）
// 功能：挂载 /inspirations/:id/crystallize/* 系列端点
// 实现方式：express.Router + 控制器方法绑定
//
// M3-b 变更：
//   - 新增 POST /sense 端点：感知灵感类型
//   - 新增 PUT /crystal 端点：更新结晶（按类型字段）
//   - 保留 PUT /prd 端点：向后兼容

import express from 'express';
import * as ctrl from '../controllers/crystallizeController.js';

const router = express.Router();

// 感知灵感类型（POST，body 可选 text；不传则从 inspiration 记录读取）
router.post('/inspirations/:id/crystallize/sense', ctrl.sense);

// 运行结晶流程（POST，body 含 stage/userInput/crystalDraft/conversationHistory/autoRun/inspirationType）
router.post('/inspirations/:id/crystallize/run', ctrl.run);

// 获取最新结晶结果（GET）
router.get('/inspirations/:id/crystallize/latest', ctrl.latest);

// 获取结晶历史（GET）
router.get('/inspirations/:id/crystallize/history', ctrl.history);

// 更新最新结晶记录的 crystal（PUT，body 含 crystal）
router.put('/inspirations/:id/crystallize/crystal', ctrl.updateCrystal);

// 更新最新结晶记录的 PRD（PUT，向后兼容旧路径）
router.put('/inspirations/:id/crystallize/prd', ctrl.updatePRD);

// 手动分流到指定 Agent（POST，body 含 targetAgent/crystal）
router.post('/inspirations/:id/crystallize/dispatch', ctrl.dispatch);

export default router;
