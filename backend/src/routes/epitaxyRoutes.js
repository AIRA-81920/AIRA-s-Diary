// Epitaxy 路由
// 功能：挂载 /inspirations/:id/epitaxy/* 系列端点
// 实现方式：express.Router + 控制器方法绑定

import express from 'express';
import * as ctrl from '../controllers/epitaxyController.js';

const router = express.Router();

// 生成方向提案（POST，body 含 crystal）
router.post('/inspirations/:id/epitaxy/propose', ctrl.propose);

// 获取所有提案（GET）
router.get('/inspirations/:id/epitaxy/proposals', ctrl.getProposals);

// 深挖某方向（POST，body 含 proposalId）
router.post('/inspirations/:id/epitaxy/excavate', ctrl.excavate);

// 获取某方向的深挖结果（GET）
router.get('/inspirations/:id/epitaxy/excavation/:proposalId', ctrl.getExcavation);

// 保存提炼词块（POST，body 含 chunks 数组）
router.post('/inspirations/:id/epitaxy/distill', ctrl.distill);

// 获取所有词块（GET）
router.get('/inspirations/:id/epitaxy/chunks', ctrl.getChunks);

// 词块转新灵感（POST，body 含 chunkIds 数组）
router.post('/inspirations/:id/epitaxy/chunk-to-inspiration', ctrl.chunkToInspiration);

export default router;
