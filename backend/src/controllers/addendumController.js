// 追加条目控制器（v7 新增）
// 功能：处理追加主帖 / 评论 / 已保存 AI 回答 / 图片上传 的 HTTP 请求
// 实现方式：每个方法 try/catch，成功返回 { success:true, data }，失败返回 { success:false, error }
// 参考：crystallizeController.js 的写法
//
// 路由设计：
//   POST   /inspirations/:id/addenda                          createAddendum
//   GET    /inspirations/:id/addenda                          listAddenda
//   PUT    /addenda/:addendumId                               updateAddendum
//   DELETE /addenda/:addendumId                               deleteAddendum
//   POST   /inspirations/:id/addenda/:addendumId/comments     createComment
//   PUT    /comments/:commentId                               updateComment
//   DELETE /comments/:commentId                               deleteComment
//   POST   /inspirations/:id/addenda/:addendumId/replies      saveReply
//   DELETE /replies/:replyId                                  deleteReply
//   POST   /replies/:replyId/mark-converted                   markConverted (v10)
//   GET    /addenda/saved-replies                             listAllSavedReplies
//   POST   /addenda/upload-image                              uploadImage

import * as addendumService from '../services/addendumService.js';
import FingerprintService from '../services/fingerprintService.js';
import { TaskQueue, TASK_KINDS } from '../services/taskQueue.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';

// ===== multer 图片上传配置 =====
// 功能：处理追加主帖附带的图片上传，限制大小与扩展名，文件名用 UUID 防路径穿越
// 实现：dest 指向项目根目录下 uploads/addenda/，filename 用 uuid + 原始扩展名
const uploadsDir = path.resolve(process.cwd(), 'uploads', 'addenda');
// 启动时确保上传目录存在（recursive 保证幂等）
fs.mkdirSync(uploadsDir, { recursive: true });

// 文件大小上限：10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;
// 允许的图片 MIME 白名单
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const storage = multer.diskStorage({
  // 存储目录：uploads/addenda/
  destination: (req, file, cb) => cb(null, uploadsDir),
  // 文件名：UUID + 原始扩展名，杜绝路径穿越与命名冲突
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // 限制扩展名为白名单内的常见图片格式
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? ext : '.png';
    cb(null, `${uuidv4()}${safeExt}`);
  }
});

// 文件过滤器：拒绝非白名单 MIME
function fileFilter(req, file, cb) {
  if (ALLOWED_MIME.has(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  }
}

// 导出 upload 实例供 routes.js 使用（multer.single('image')）
export const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE }
});

/**
 * 创建追加主帖
 * 功能：POST /inspirations/:id/addenda，body:{content, links, images}
 * 实现方式：调用 addendumService.createAddendum 写入 DB → 触发指纹失效（内容变更）
 */
export async function createAddendum(req, res) {
  try {
    const { id } = req.params;
    const { content, links, images } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, error: 'content is required' });
    }
    const result = addendumService.createAddendum(id, { content, links, images });
    // 内容变化后标记指纹 stale，并入队 FINGERPRINT 任务触发后台重算
    // taskQueue 串行：FINGERPRINT → 自动 enqueue INCREMENTAL_SCAN，与 epitaxyController.distill 保持一致
    await FingerprintService.markStale(id);
    TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, id);
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[AddendumController] createAddendum failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 更新追加主帖
 * 功能：PUT /addenda/:addendumId，body:{content, links, images}
 * 实现方式：先查 addendum 获取 inspiration_id → 调 service 更新 → markStale
 */
export async function updateAddendum(req, res) {
  try {
    const { addendumId } = req.params;
    const { content, links, images } = req.body;
    // 反查 inspiration_id 用于 markStale
    const existing = addendumService.getAddendumById(addendumId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Addendum not found' });
    }
    const result = addendumService.updateAddendum(addendumId, { content, links, images });
    // 反查 inspiration_id 用于 markStale + enqueue（与 epitaxyController.distill 一致）
    await FingerprintService.markStale(existing.inspiration_id);
    TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, existing.inspiration_id);
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[AddendumController] updateAddendum failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 删除追加主帖
 * 功能：DELETE /addenda/:addendumId
 * 实现方式：先查 inspiration_id → 调 service 删除（级联由 FK 处理）→ markStale
 */
export async function deleteAddendum(req, res) {
  try {
    const { addendumId } = req.params;
    const existing = addendumService.getAddendumById(addendumId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Addendum not found' });
    }
    const result = addendumService.deleteAddendum(addendumId);
    // 删除触发指纹重算（追加内容是指纹第五源，删除后需重算）
    await FingerprintService.markStale(existing.inspiration_id);
    TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, existing.inspiration_id);
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[AddendumController] deleteAddendum failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 列出某灵感的所有追加主帖
 * 功能：GET /inspirations/:id/addenda
 * 实现方式：调 service.listAddenda 返回嵌套结构数组
 */
export async function listAddenda(req, res) {
  try {
    const { id } = req.params;
    const data = addendumService.listAddenda(id);
    res.json({ success: true, data });
  } catch (e) {
    console.error('[AddendumController] listAddenda failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 创建评论
 * 功能：POST /inspirations/:id/addenda/:addendumId/comments，body:{content, context?}
 * 实现方式：调 service.createComment，不调 markStale（评论不影响指纹）
 *   - v9：新增 context 字段（可空），用于评论折叠展示
 */
export async function createComment(req, res) {
  try {
    const { addendumId } = req.params;
    const { content, context } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, error: 'content is required' });
    }
    // context 可能为 null/undefined，直接透传给 service
    const result = addendumService.createComment(addendumId, content, context);
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[AddendumController] createComment failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 更新评论
 * 功能：PUT /comments/:commentId，body:{content, context?}
 * 实现方式：调 service.updateComment；v9 支持同时更新 context（可选）
 */
export async function updateComment(req, res) {
  try {
    const { commentId } = req.params;
    const { content, context } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, error: 'content is required' });
    }
    // context 为 undefined 表示不更新该字段；显式传 null 表示清空
    const result = addendumService.updateComment(commentId, content, context);
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[AddendumController] updateComment failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 删除评论
 * 功能：DELETE /comments/:commentId
 */
export async function deleteComment(req, res) {
  try {
    const { commentId } = req.params;
    const result = addendumService.deleteComment(commentId);
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[AddendumController] deleteComment failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 保存 AI 回答
 * 功能：POST /inspirations/:id/addenda/:addendumId/replies，body:{question, answer, core?, context?}
 * 实现方式：从路径 :id 取 inspiration_id，调 service.saveReply，不调 markStale
 *   - v9：新增 core / context 分层字段，由前端从 AI 回复的 [CORE] 标签解析后传入
 *   - answer 保留完整原文（含标签），core/context 为解析后的结构化字段
 */
export async function saveReply(req, res) {
  try {
    const { id, addendumId } = req.params;
    const { question, answer, core, context } = req.body;
    if (!question || !answer) {
      return res.status(400).json({ success: false, error: 'question and answer are required' });
    }
    // core / context 可为 null/undefined，直接透传给 service
    const result = addendumService.saveReply(addendumId, id, { question, answer, core, context });
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[AddendumController] saveReply failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 删除已保存 AI 回答
 * 功能：DELETE /replies/:replyId
 */
export async function deleteReply(req, res) {
  try {
    const { replyId } = req.params;
    const result = addendumService.deleteReply(replyId);
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[AddendumController] deleteReply failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 标记已保存 AI 回答为"已转化为评论"（v10 新增）
 * 功能：POST /replies/:replyId/mark-converted
 *   触发场景：前端在 createComment 成功后调用，将源对话标记为已转化
 *   效果：该条回复从"接着想"面板移除；再次进入对话窗口时折叠到"已处理历史"
 * 实现方式：调 service.markReplyConverted 更新 converted=1
 */
export async function markConverted(req, res) {
  try {
    const { replyId } = req.params;
    const result = addendumService.markReplyConverted(replyId);
    if (!result.success) {
      return res.status(404).json({ success: false, error: 'Reply not found' });
    }
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[AddendumController] markConverted failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 列出全局所有已保存 AI 回答
 * 功能：GET /addenda/saved-replies
 * 实现方式：调 service.listAllSavedReplies 返回摘要数组
 */
export async function listAllSavedReplies(req, res) {
  try {
    const data = addendumService.listAllSavedReplies();
    res.json({ success: true, data });
  } catch (e) {
    console.error('[AddendumController] listAllSavedReplies failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 上传图片
 * 功能：POST /addenda/upload-image，multipart/form-data 字段名 image
 * 实现方式：multer.single('image') 处理上传，返回文件名供前端引用
 * 注意：实际路由层在 router.post(..., upload.single('image'), ctrl.uploadImage) 中绑定 multer
 */
export async function uploadImage(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    res.json({ success: true, data: { filename: req.file.filename } });
  } catch (e) {
    console.error('[AddendumController] uploadImage failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}
