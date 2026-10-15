// 提问支路（AI 阐释）路由
// 功能：挂载 POST /explain 端点（不带 :id）
// 实现方式：express.Router + 控制器方法绑定
//
// 说明：这是一条旁路——只解释当前追问题目本身，不推进主线、不落盘、不写任何表。
//       完整路径为 /api/explain（在 server.js 中以 /api 前缀挂载）。

import express from 'express';
import * as ctrl from '../controllers/explainController.js';

const router = express.Router();

// 流式阐释用户对当前追问题目的疑问（POST，SSE；body 含 question/context/thread）
router.post('/explain', ctrl.explainStream);

export default router;