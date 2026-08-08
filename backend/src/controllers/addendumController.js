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
// v11：deleteAddendum 级联删除文件时需要查 files_json 字段
// 约束禁止修改 addendumService.js（任务 7 已完成），而 service.getAddendumById 的 SELECT 未包含 files_json 列
// 因此 controller 内直接 import db 做最小内联查询，仅查 files_json 一列
import { db } from '../database/db.js';

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

// ===== multer 文本文件上传配置（v11 多模态扩展） =====
// 功能：处理追加主帖 / 新建灵感附带的文本文件（.md/.txt）上传
// 实现：两套 storage 共用 fileFilter，dest 分别指向 uploads/addenda/ 与 uploads/neoidea/
//       文件名 UUID + 原扩展名，杜绝路径穿越与命名冲突

// 新建灵感文件存储目录：uploads/neoidea/
// 启动时确保目录存在（recursive 保证幂等，与 uploads/addenda 创建方式一致）
const neoideaUploadsDir = path.resolve(process.cwd(), 'uploads', 'neoidea');
fs.mkdirSync(neoideaUploadsDir, { recursive: true });

// 文本文件大小上限：500KB
const MAX_TEXT_FILE_SIZE = 500 * 1024;
// 允许的文本文件 MIME 白名单
// 注：部分系统 .md 会被识别为 application/octet-stream，需结合扩展名判断
const ALLOWED_TEXT_MIME = new Set([
  'text/markdown',
  'text/plain',
  'text/x-markdown',
  'application/octet-stream'
]);
// 允许的文本文件扩展名白名单（小写）
const ALLOWED_TEXT_EXT = ['.md', '.txt'];

/**
 * 文本文件过滤器
 * 功能：拒绝非白名单的文本文件，同时校验扩展名与 MIME
 * 实现：必须满足"扩展名为 .md/.txt"且"MIME 在白名单内"才放行
 *       —— 对 application/octet-stream 也要求扩展名为 .md/.txt，杜绝伪装上传
 * @param {Object} req - Express 请求对象
 * @param {Object} file - multer 文件对象
 * @param {Function} cb - 回调
 */
function textFileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const extOk = ALLOWED_TEXT_EXT.includes(ext);
  const mimeOk = ALLOWED_TEXT_MIME.has(file.mimetype);
  if (extOk && mimeOk) {
    cb(null, true);
  } else {
    cb(new Error(`Unsupported text file type: ${file.mimetype} (${ext})`));
  }
}

/**
 * 生成 UUID + 原扩展名的安全文件名
 * 功能：单文件 / 多文件 storage 共用的 filename 函数
 * 实现：扩展名白名单校验通过则用原扩展名，否则降级为 .txt
 * @param {string} originalname - 原始文件名
 * @returns {string} `${uuid}${safeExt}`
 */
function buildTextFilename(originalname) {
  const ext = path.extname(originalname).toLowerCase();
  const safeExt = ALLOWED_TEXT_EXT.includes(ext) ? ext : '.txt';
  return `${uuidv4()}${safeExt}`;
}

// 单文件 storage：存储到 uploads/addenda/（与图片共用目录，文件名 UUID 防冲突）
const storageFile = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, buildTextFilename(file.originalname))
});

// 多文件 storage：存储到 uploads/neoidea/（新建灵感的源文件目录，distill 任务从此读取）
const storageFiles = multer.diskStorage({
  destination: (req, file, cb) => cb(null, neoideaUploadsDir),
  filename: (req, file, cb) => cb(null, buildTextFilename(file.originalname))
});

// 导出 uploadFile 实例供 routes.js 使用（multer.single('file')）
export const uploadFile = multer({
  storage: storageFile,
  fileFilter: textFileFilter,
  limits: { fileSize: MAX_TEXT_FILE_SIZE }
});

// 导出 uploadFiles 实例供 routes.js 使用（multer.array('files', 10)，最多 10 个文件）
export const uploadFiles = multer({
  storage: storageFiles,
  fileFilter: textFileFilter,
  limits: { fileSize: MAX_TEXT_FILE_SIZE }
});

/**
 * 创建追加主帖
 * 功能：POST /inspirations/:id/addenda，body:{content, links, images, files}
 * 实现方式：调用 addendumService.createAddendum 写入 DB → 扫描 generating 图片入队 VISION → 触发指纹失效
 *   - v11：新增 images（对象数组）与 files（数组）字段
 *   - v11：单类型校验——图片与文本文件不可同时存在于同一追加条目
 *   - v11：images 中 status='generating' 的条目自动入队 VISION 任务（addendumId|filename 作为去重 key）
 */
export async function createAddendum(req, res) {
  try {
    const { id } = req.params;
    const { content, links, images, files } = req.body;
    // 内容校验：content / links / images / files 任一非空即可（v11 支持仅存图/仅附件的追加条目）
    // 实现方式：全部为空才 400，避免"只存图不填正文"被误拒
    const hasAnyField = !!((content || '').trim()) ||
      (Array.isArray(links) && links.length > 0) ||
      (Array.isArray(images) && images.length > 0) ||
      (Array.isArray(files) && files.length > 0);
    if (!hasAnyField) {
      return res.status(400).json({ success: false, error: '内容、链接、图片、文件至少填一项' });
    }
    // 单类型校验：images 与 files 同时非空 → 400（同一追加条目只允许一种附件类型）
    if (Array.isArray(images) && images.length > 0 && Array.isArray(files) && files.length > 0) {
      return res.status(400).json({ success: false, error: '图片与文本文件不可同时存在于同一追加条目' });
    }
    // 调 service 写入 DB，透传 images 与 files（service 内部转 JSON 字符串存储）
    const result = addendumService.createAddendum(id, { content, links, images, files });
    // 扫描 images 中 status='generating' 的条目，入队 VISION 任务
    // 第二参数 addendumId|filename 作为去重 key（粒度到单张图片，避免同 addendum 多图相互覆盖）
    if (Array.isArray(images)) {
      for (const img of images) {
        if (img && img.status === 'generating' && img.filename) {
          TaskQueue.enqueue(
            TASK_KINDS.VISION,
            `${result.id}|${img.filename}`,
            { addendumId: result.id, filename: img.filename }
          );
        }
      }
    }
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
 * 功能：PUT /addenda/:addendumId，body:{content, links, images, files}
 * 实现方式：先查 addendum 获取 inspiration_id → 单类型校验 → 调 service 更新 → 扫描 generating 入队 VISION → markStale
 *   - v11：新增 images（对象数组）与 files（数组）字段
 *   - v11：单类型校验——图片与文本文件不可同时存在于同一追加条目
 *   - v11：images 中 status='generating' 的条目自动入队 VISION 任务（addendumId|filename 作为去重 key）
 */
export async function updateAddendum(req, res) {
  try {
    const { addendumId } = req.params;
    const { content, links, images, files } = req.body;
    // 反查 inspiration_id 用于 markStale
    const existing = addendumService.getAddendumById(addendumId);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Addendum not found' });
    }
    // 单类型校验：images 与 files 同时非空 → 400（同一追加条目只允许一种附件类型）
    if (Array.isArray(images) && images.length > 0 && Array.isArray(files) && files.length > 0) {
      return res.status(400).json({ success: false, error: '图片与文本文件不可同时存在于同一追加条目' });
    }
    // 调 service 更新，透传 images 与 files（service 内部转 JSON 字符串存储）
    const result = addendumService.updateAddendum(addendumId, { content, links, images, files });
    // 扫描 images 中 status='generating' 的条目，入队 VISION 任务
    // 第二参数 addendumId|filename 作为去重 key（粒度到单张图片，避免同 addendum 多图相互覆盖）
    if (Array.isArray(images)) {
      for (const img of images) {
        if (img && img.status === 'generating' && img.filename) {
          TaskQueue.enqueue(
            TASK_KINDS.VISION,
            `${addendumId}|${img.filename}`,
            { addendumId, filename: img.filename }
          );
        }
      }
    }
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
 * 实现方式：先查 addendum（含 images_json + files_json）→ 调 service 删除（级联由 FK 处理）
 *           → 级联删除 uploads/addenda/ 下文件（images + files）→ markStale
 *   - v11：新增级联删除磁盘文件逻辑（images 对象数组 + files 对象数组）
 *   - 注意：addendumService.getAddendumById 的 SELECT 未包含 files_json 列
 *           约束禁止修改 service.js，故 controller 内联查询 files_json
 */
export async function deleteAddendum(req, res) {
  try {
    const { addendumId } = req.params;
    // 反查 addendum 行：取 inspiration_id + images_json + files_json
    // 用 db 内联查询以一并取得 files_json（service.getAddendumById 不返回该列）
    const row = (() => {
      const stmt = db.prepare(
        'SELECT id, inspiration_id, images_json, files_json FROM inspiration_addenda WHERE id = ?'
      );
      stmt.bind([addendumId]);
      const r = stmt.step() ? stmt.getAsObject() : null;
      stmt.free();
      return r;
    })();
    if (!row) {
      return res.status(404).json({ success: false, error: 'Addendum not found' });
    }
    // 收集要级联删除的文件名
    // images_json：用 addendumService.parseImageArray 解析（兼容旧字符串数组升级为对象数组）
    const imagesToDelete = addendumService.parseImageArray(row.images_json);
    // files_json：手动 JSON.parse（元素形如 {filename, original_name, size}）
    let filesToDelete = [];
    try {
      const parsed = row.files_json ? JSON.parse(row.files_json) : [];
      if (Array.isArray(parsed)) filesToDelete = parsed;
    } catch (err) {
      // JSON 解析失败不阻塞删除流程，降级为空数组（文件可能残留但不会阻塞业务）
      console.warn(`[AddendumController] parse files_json failed for ${addendumId}:`, err.message);
    }
    // 调 service 删除 DB 行（子表级联由 FK ON DELETE CASCADE 处理）
    const result = addendumService.deleteAddendum(addendumId);
    // 级联删除 uploads/addenda/ 下的图片与文本文件
    // 实现：逐个 fs.unlinkSync，try/catch 不阻塞，文件不存在跳过
    for (const img of imagesToDelete) {
      const filename = img?.filename;
      if (!filename) continue;
      try {
        fs.unlinkSync(path.join(uploadsDir, filename));
      } catch (err) {
        // 文件不存在或删除失败不阻塞，仅记 debug 日志
        console.debug(`[AddendumController] unlink image skipped: ${filename}:`, err.message);
      }
    }
    for (const f of filesToDelete) {
      const filename = f?.filename;
      if (!filename) continue;
      try {
        fs.unlinkSync(path.join(uploadsDir, filename));
      } catch (err) {
        // 文件不存在或删除失败不阻塞，仅记 debug 日志
        console.debug(`[AddendumController] unlink file skipped: ${filename}:`, err.message);
      }
    }
    // 删除触发指纹重算（追加内容是指纹第五源，删除后需重算）
    await FingerprintService.markStale(row.inspiration_id);
    TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, row.inspiration_id);
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

/**
 * 上传追加条目文本文件（v11 多模态扩展）
 * 功能：POST /addenda/upload-file，multipart/form-data 字段名 file
 * 实现方式：multer.single('file') 处理上传，返回文件名 + 原始名 + 大小 + url 供前端引用
 *   - 文件存储到 uploads/addenda/（与图片共用目录，文件名 UUID 防冲突）
 *   - 校验失败由 multer 在 fileFilter 阶段拒绝（前端展示错误）
 *   - 实际路由层在 router.post(..., uploadFile.single('file'), ctrl.uploadAddendumFile) 中绑定 multer
 */
export async function uploadAddendumFile(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }
    const { filename, originalname, size } = req.file;
    res.json({
      success: true,
      data: {
        filename,
        original_name: originalname,
        size,
        url: '/uploads/addenda/' + filename
      }
    });
  } catch (e) {
    console.error('[AddendumController] uploadAddendumFile failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 上传新建灵感的文本文件（v11 多模态扩展）
 * 功能：POST /inspirations/:id/files，multipart/form-data 字段名 files（多文件，最多 10 个）
 * 实现方式：multer.array('files', 10) 处理上传，返回文件元数据数组供前端引用
 *   - 文件存储到 uploads/neoidea/（新建灵感的源文件目录，distill 任务从此读取）
 *   - 校验失败由 multer 在 fileFilter 阶段拒绝（前端展示错误）
 *   - 实际路由层在 router.post(..., uploadFiles.array('files', 10), ctrl.uploadInspirationFiles) 中绑定 multer
 */
export async function uploadInspirationFiles(req, res) {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }
    // 映射 multer 文件数组为前端可用的元数据结构
    const data = req.files.map((f) => ({
      filename: f.filename,
      original_name: f.originalname,
      size: f.size,
      url: '/uploads/neoidea/' + f.filename
    }));
    res.json({ success: true, data });
  } catch (e) {
    console.error('[AddendumController] uploadInspirationFiles failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}
