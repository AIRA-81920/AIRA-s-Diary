// 文件夹路由 — /api/folders/*
// 路由顺序：/reorder 必须在 /:id 之前，避免 "reorder" 被当作 id 参数

import express from 'express';
import * as controller from '../controllers/folderController.js';

const router = express.Router();

// 获取所有文件夹
router.get('/', controller.list);

// 创建文件夹
router.post('/', controller.create);

// 批量排序（必须在 /:id 之前）
router.put('/reorder', controller.reorder);

// 更新单个文件夹
router.put('/:id', controller.update);

// 删除文件夹
router.delete('/:id', controller.remove);

export default router;
