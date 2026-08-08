// 追加条目数据服务（v7 新增）
// 功能：封装 inspiration_addenda / addendum_comments / saved_ai_replies 三张表的 CRUD 操作
// 实现方式：
//   1. 使用 sql.js 的 db.prepare + bind 实现参数化查询（防 SQL 注入）
//   2. 写操作用 db.run()，读操作用 queryAll/queryOne 转换为对象数组
//   3. 可预期错误（如 JSON 解析失败、子表查询失败）静默降级返回 null/[]，业务错误 throw
//   4. 所有方法均为命名导出 + 末尾 export default 聚合，与 inspirationStorage.js 风格一致

import fs from 'fs/promises';
import path from 'path';
import { db, saveDb } from '../database/db.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * 执行 SQL 查询并返回所有匹配行（对象数组）
 * 功能：与 fingerprintService.js 中 queryAll 一致，封装 prepare → bind → step 循环
 * 实现方式：db.prepare → stmt.bind → while(stmt.step()) stmt.getAsObject → stmt.free
 * @param {string} sql - SQL 语句
 * @param {Array} params - 绑定参数
 * @returns {Array<Object>} 行数组
 */
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

/**
 * 执行 SQL 查询并返回第一行（对象），无结果返回 null
 * @param {string} sql - SQL 语句
 * @param {Array} params - 绑定参数
 * @returns {Object|null}
 */
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

/**
 * 安全解析 JSON 字符串
 * 功能：把 links_json / images_json 字段解析回数组，失败时降级为空数组
 * 实现方式：JSON.parse + try/catch，非字符串或解析失败返回 []
 * @param {string} jsonStr - JSON 字符串
 * @returns {Array}
 */
function parseJsonArray(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return [];
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // JSON 解析失败不阻塞业务，降级为空数组
    console.warn(`[AddendumService] JSON parse failed: ${err.message}`);
    return [];
  }
}

/**
 * 解析 images_json 为 AddendumImage[] 对象数组（v11 新增）
 * 功能：兼容 v7-v10 旧字符串数组格式，统一升级为对象数组；对象数组原样返回；解析失败返回 []
 * 实现方式：
 *   1. JSON.parse 解析字符串；非字符串 / 解析失败 / 非数组都返回 []
 *   2. 遍历元素：string 视为旧格式（filename-only），升级为 {filename, description:'', status:'confirmed'}
 *      （旧图片早已落盘且无描述，按"已确认"语义处理）
 *   3. object 元素原样返回，由调用方保证字段符合 AddendumImage 形状
 * @typedef {Object} AddendumImage
 * @property {string} filename - 落盘文件名（UUID + 扩展名）
 * @property {string} description - 图片描述（可空字符串）
 * @property {string} status - 状态：'confirmed' | 'ready' | ...（业务自定义）
 * @param {string} jsonStr - images_json 字段值
 * @returns {AddendumImage[]} 图片对象数组
 */
export function parseImageArray(jsonStr) {
  // 非字符串或空值直接返回空数组
  if (!jsonStr || typeof jsonStr !== 'string') return [];
  let arr;
  try {
    arr = JSON.parse(jsonStr);
  } catch (err) {
    // 解析失败不阻塞业务，降级为空数组
    console.warn(`[AddendumService] images_json parse failed: ${err.message}`);
    return [];
  }
  if (!Array.isArray(arr)) return [];
  // 遍历元素：string 视为旧格式升级为对象，object 原样保留
  return arr.map((item) => {
    if (typeof item === 'string') {
      // 旧字符串数组：仅含 filename，升级为 v11 对象格式
      return { filename: item, description: '', status: 'confirmed' };
    }
    // 对象数组原样返回（调用方保证字段形状）
    return item;
  });
}

/**
 * 创建追加主帖
 * 功能：向 inspiration_addenda 表插入一条新记录
 * 实现方式：db.run 参数化插入，links/images/files 数组转 JSON 字符串存储
 *   - v11：新增 files 字段，写入 files_json（[{filename, original_name, size}]）
 *   - v11：images 升级为对象数组（[{filename, description, status}]），写入 images_json
 * @param {string} inspirationId - 灵感 ID
 * @param {{content: string, links?: Array, images?: Array, files?: Array}} data - 主帖内容
 * @returns {{id: string}} 新建记录的 ID
 */
export function createAddendum(inspirationId, { content, links = [], images = [], files = [] }) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO inspiration_addenda (id, inspiration_id, content, links_json, images_json, files_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, inspirationId, content, JSON.stringify(links), JSON.stringify(images), JSON.stringify(files), now]
  );
  saveDb();
  return { id };
}

/**
 * 更新追加主帖
 * 功能：UPDATE content/links_json/images_json/files_json/updated_at
 * 实现方式：db.run 参数化更新，行不存在时静默返回 success:false
 *   - v11：新增 files 字段写入 files_json（[{filename, original_name, size}]）
 *   - v11：images 升级为对象数组（[{filename, description, status}]），写入 images_json
 * @param {string} addendumId - 追加主帖 ID
 * @param {{content?: string, links?: Array, images?: Array, files?: Array}} data - 待更新字段
 * @returns {{success: boolean}}
 */
export function updateAddendum(addendumId, { content, links, images, files }) {
  // 先查询行是否存在，便于返回明确的成功/失败
  const existing = queryOne('SELECT id FROM inspiration_addenda WHERE id = ?', [addendumId]);
  if (!existing) {
    return { success: false };
  }
  const now = new Date().toISOString();
  // 动态构建 SET 子句：仅更新传入的字段
  const sets = [];
  const params = [];
  if (content !== undefined) {
    sets.push('content = ?');
    params.push(content);
  }
  if (links !== undefined) {
    sets.push('links_json = ?');
    params.push(JSON.stringify(links));
  }
  if (images !== undefined) {
    sets.push('images_json = ?');
    params.push(JSON.stringify(images));
  }
  if (files !== undefined) {
    sets.push('files_json = ?');
    params.push(JSON.stringify(files));
  }
  if (sets.length === 0) {
    // 无字段需要更新
    return { success: true };
  }
  sets.push('updated_at = ?');
  params.push(now);
  params.push(addendumId);
  db.run(`UPDATE inspiration_addenda SET ${sets.join(', ')} WHERE id = ?`, params);
  saveDb();
  return { success: true };
}

/**
 * 删除追加主帖
 * 功能：DELETE 主帖，子表（comments/saved_ai_replies）由 FK ON DELETE CASCADE 级联删除
 * 实现方式：db.run 参数化删除，行不存在时返回 success:false
 * @param {string} addendumId - 追加主帖 ID
 * @returns {{success: boolean}}
 */
export function deleteAddendum(addendumId) {
  const existing = queryOne('SELECT id FROM inspiration_addenda WHERE id = ?', [addendumId]);
  if (!existing) {
    return { success: false };
  }
  db.run('DELETE FROM inspiration_addenda WHERE id = ?', [addendumId]);
  saveDb();
  return { success: true };
}

/**
 * 列出某灵感下所有追加主帖（含评论与已保存 AI 回答的嵌套结构）
 * 功能：SELECT 所有追加主帖 → 对每条再查 comments 和 saved_replies → 组装嵌套结构
 * 实现方式：queryAll 主表 → 逐条 queryAll 子表 → JSON 字段解析回数组
 *   - v11：images 用 parseImageArray 解析（兼容旧字符串数组升级为对象数组）
 *   - v11：files_json 用 parseJsonArray 解析为 [{filename, original_name, size}]
 * 返回结构：{ id, inspiration_id, content, links:[], images:[], files:[], created_at, updated_at,
 *            comments:[{id,content,context,created_at,updated_at}],
 *            saved_replies:[{id,question,answer,core,context,saved_at}] }
 * @param {string} inspirationId - 灵感 ID
 * @returns {Array<Object>} 追加主帖数组（按 created_at 升序）
 */
export function listAddenda(inspirationId) {
  // 查询所有追加主帖（按创建时间升序，时间线日志的默认顺序）
  // v11：SELECT 增加 files_json 列
  const addenda = queryAll(
    'SELECT id, inspiration_id, content, links_json, images_json, files_json, created_at, updated_at FROM inspiration_addenda WHERE inspiration_id = ? ORDER BY created_at ASC',
    [inspirationId]
  );
  // 逐条查询子表并组装嵌套结构
  return addenda.map((row) => {
    let comments = [];
    let savedReplies = [];
    try {
      // v9：comments 表新增 context 列（可空），用于评论折叠展示
      comments = queryAll(
        'SELECT id, content, context, created_at, updated_at FROM addendum_comments WHERE addendum_id = ? ORDER BY created_at ASC',
        [row.id]
      );
    } catch (err) {
      // 子表查询失败不阻塞，降级为空数组
      console.warn(`[AddendumService] read comments failed for ${row.id}: ${err.message}`);
    }
    try {
      // v9：saved_replies 表新增 core / context 列（可空），用于 AI 回复分层展示
      // v10：新增 converted 字段，前端 openConversation 用它区分"未转化（展开）"与"已转化（折叠到历史）"
      savedReplies = queryAll(
        'SELECT id, question, answer, core, context, converted, saved_at FROM saved_ai_replies WHERE addendum_id = ? ORDER BY saved_at ASC',
        [row.id]
      );
    } catch (err) {
      console.warn(`[AddendumService] read saved_replies failed for ${row.id}: ${err.message}`);
    }
    return {
      id: row.id,
      inspiration_id: row.inspiration_id,
      content: row.content,
      links: parseJsonArray(row.links_json),
      // v11：images 升级为对象数组，旧字符串数组会被 parseImageArray 自动升级
      images: parseImageArray(row.images_json),
      // v11：files 为文本文件元数据数组 [{filename, original_name, size}]
      files: parseJsonArray(row.files_json),
      created_at: row.created_at,
      updated_at: row.updated_at,
      comments,
      saved_replies: savedReplies,
    };
  });
}

/**
 * 创建评论
 * 功能：向 addendum_comments 表插入一条新评论（可选携带 context 折叠内容）
 * 实现方式：db.run 参数化插入；context 缺省为 null（无折叠内容时）
 * @param {string} addendumId - 追加主帖 ID
 * @param {string} content - 评论核心文本
 * @param {string} [context] - 评论展开/阐释部分（可空，用于折叠展示）
 * @returns {{id: string}} 新建评论 ID
 */
export function createComment(addendumId, content, context = null) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO addendum_comments (id, addendum_id, content, context, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, addendumId, content, context, now]
  );
  saveDb();
  return { id };
}

/**
 * 更新评论
 * 功能：UPDATE content / context / updated_at
 * 实现方式：db.run 参数化更新，行不存在时返回 success:false；context 缺省时不更新该字段
 * @param {string} commentId - 评论 ID
 * @param {string} content - 新评论核心文本
 * @param {string} [context] - 新评论展开/阐释部分（undefined 表示不更新该字段）
 * @returns {{success: boolean}}
 */
export function updateComment(commentId, content, context) {
  const existing = queryOne('SELECT id FROM addendum_comments WHERE id = ?', [commentId]);
  if (!existing) {
    return { success: false };
  }
  const now = new Date().toISOString();
  // context 为 undefined 时不更新该字段（仅更新 content）；显式传入 null 时清空
  if (context === undefined) {
    db.run('UPDATE addendum_comments SET content = ?, updated_at = ? WHERE id = ?', [content, now, commentId]);
  } else {
    db.run('UPDATE addendum_comments SET content = ?, context = ?, updated_at = ? WHERE id = ?', [content, context, now, commentId]);
  }
  saveDb();
  return { success: true };
}

/**
 * 删除评论
 * 功能：DELETE 一条评论
 * 实现方式：db.run 参数化删除，行不存在时返回 success:false
 * @param {string} commentId - 评论 ID
 * @returns {{success: boolean}}
 */
export function deleteComment(commentId) {
  const existing = queryOne('SELECT id FROM addendum_comments WHERE id = ?', [commentId]);
  if (!existing) {
    return { success: false };
  }
  db.run('DELETE FROM addendum_comments WHERE id = ?', [commentId]);
  saveDb();
  return { success: true };
}

/**
 * 保存 AI 回答
 * 功能：向 saved_ai_replies 表插入一条用户主动保存的问答对（含 core/context 分层字段）
 * 实现方式：db.run 参数化插入，inspiration_id 冗余字段便于全局列表查询
 *   - core：AI 回复中 [CORE] 标签包裹的核心观点（可空，未标记时为 null）
 *   - context：AI 回复中标签外的阐释/展开部分（可空）
 *   - answer：保留含 [CORE] 标签的完整原文，便于编辑/重新解析
 * @param {string} addendumId - 追加主帖 ID
 * @param {string} inspirationId - 灵感 ID（冗余存储）
 * @param {{question: string, answer: string, core?: string, context?: string}} data - 问答对 + 分层字段
 * @returns {{id: string}} 新建记录 ID
 */
export function saveReply(addendumId, inspirationId, { question, answer, core = null, context = null }) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.run(
    'INSERT INTO saved_ai_replies (id, addendum_id, inspiration_id, question, answer, core, context, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, addendumId, inspirationId, question, answer, core, context, now]
  );
  saveDb();
  return { id };
}

/**
 * 删除已保存的 AI 回答
 * 功能：DELETE 一条 saved_ai_replies 记录
 * 实现方式：db.run 参数化删除，行不存在时返回 success:false
 * @param {string} replyId - 已保存回答 ID
 * @returns {{success: boolean}}
 */
export function deleteReply(replyId) {
  const existing = queryOne('SELECT id FROM saved_ai_replies WHERE id = ?', [replyId]);
  if (!existing) {
    return { success: false };
  }
  db.run('DELETE FROM saved_ai_replies WHERE id = ?', [replyId]);
  saveDb();
  return { success: true };
}

/**
 * 列出某灵感下所有已保存 AI 回答
 * 功能：SELECT * FROM saved_ai_replies WHERE inspiration_id = ?，按 saved_at 降序
 * 实现方式：queryAll 参数化查询；v9 起新增 core/context 字段读取；v10 起新增 converted 字段
 * @param {string} inspirationId - 灵感 ID
 * @returns {Array<Object>} 已保存回答数组
 */
export function listSavedRepliesByInspiration(inspirationId) {
  return queryAll(
    'SELECT id, addendum_id, inspiration_id, question, answer, core, context, converted, saved_at FROM saved_ai_replies WHERE inspiration_id = ? ORDER BY saved_at DESC',
    [inspirationId]
  );
}

/**
 * 列出全局所有已保存 AI 回答（用于"继续思考"全局视图）
 * 功能：JOIN inspiration_addenda 取 content 摘要 + JOIN inspirations 取 title
 *       + 子查询统计每条回答下的评论数
 * 返回结构：{ id, addendum_id, inspiration_id, inspiration_title, addendum_excerpt(≤200字),
 *            question, answer, core, context, saved_at, comment_count }
 * 实现方式：
 *   1. queryAll 主查询 LEFT JOIN 获取关联字段；v9 起读取 r.core / r.context
 *   2. 子查询 (SELECT COUNT(*) FROM addendum_comments WHERE addendum_id=...) 统计 comment_count
 *   3. excerpt 用 substr 截断到 200 字
 *   4. v10：WHERE r.converted = 0 过滤已转化为评论的项（"接着想"只显示待处理项）
 * @returns {Array<Object>} 已保存回答摘要数组
 */
export function listAllSavedReplies() {
  // LEFT JOIN 保证：即使灵感或追加主帖被删除（理论上 FK 会级联，这里防御性处理），仍能返回记录
  // v9：新增 r.core / r.context 字段，前端列表预览优先用 core，无 core 时降级用 answer
  // v10：WHERE r.converted = 0 — 已转化的对话从"接着想"面板移除
  // fix：过滤 i.deleted_at IS NULL — 已软删除（快照中）灵感的保存对话不出现在"继续思考"面板
  return queryAll(
    `SELECT
       r.id AS id,
       r.addendum_id AS addendum_id,
       r.inspiration_id AS inspiration_id,
       i.title AS inspiration_title,
       substr(a.content, 1, 200) AS addendum_excerpt,
       r.question AS question,
       r.answer AS answer,
       r.core AS core,
       r.context AS context,
       r.saved_at AS saved_at,
       (SELECT COUNT(*) FROM addendum_comments c WHERE c.addendum_id = r.addendum_id) AS comment_count
     FROM saved_ai_replies r
     LEFT JOIN inspiration_addenda a ON r.addendum_id = a.id
     LEFT JOIN inspirations i ON r.inspiration_id = i.id
     WHERE r.converted = 0 AND i.deleted_at IS NULL
     ORDER BY r.saved_at DESC`
  );
}

/**
 * 标记已保存的 AI 回答为"已转化为评论"
 * 功能：UPDATE saved_ai_replies SET converted=1 WHERE id=?
 *   触发时机：前端 createComment 成功后，若 store.commentSourceReplyId 有值，则调用本函数
 *   效果：该条回复从"接着想"面板移除；再次进入对话窗口时折叠到"已处理历史"
 * 实现方式：db.run 参数化更新，行不存在时返回 success:false
 * @param {string} replyId - saved_ai_replies 的主键 ID
 * @returns {{success: boolean}}
 */
export function markReplyConverted(replyId) {
  const existing = queryOne('SELECT id FROM saved_ai_replies WHERE id = ?', [replyId]);
  if (!existing) {
    return { success: false };
  }
  db.run('UPDATE saved_ai_replies SET converted = 1 WHERE id = ?', [replyId]);
  saveDb();
  return { success: true };
}

/**
 * 按追加主帖 ID 查询单条记录
 * 功能：供 controller 在删除/更新前反查 inspiration_id 之用
 * 实现方式：queryOne 参数化查询
 * @param {string} addendumId - 追加主帖 ID
 * @returns {Object|null}
 */
export function getAddendumById(addendumId) {
  // v11：SELECT 补充 files_json 列，供 controller 级联删除文件时使用
  return queryOne(
    'SELECT id, inspiration_id, content, links_json, images_json, files_json, created_at, updated_at FROM inspiration_addenda WHERE id = ?',
    [addendumId]
  );
}

/**
 * 读取追加条目携带的参考文件内容（对话注入用）
 * 功能：查 inspiration_addenda.files_json → 逐个读取 uploads/addenda/ 下的文件文本 → 返回带 content 的数组
 * 实现方式：
 *   1. queryOne 读 files_json 字段
 *   2. JSON.parse 解析为 files 数组（元素形如 {filename, original_name, size}）
 *   3. 逐个 fs.readFile 读取 uploads/addenda/{filename}（utf-8），单文件失败跳过并告警
 *   4. 返回 [{filename, original_name, size, content}]；addendum 不存在或 files_json 为空返回 []
 * 用途：conversationController 组装对话上下文时调用，把文件内容注入 context.addendum.files
 * @param {string} addendumId - 追加主帖 ID
 * @returns {Promise<Array<{filename: string, original_name?: string, size?: number, content: string}>>}
 */
export async function readAddendumFiles(addendumId) {
  if (!addendumId) return [];

  // 1. 查询 files_json 字段
  const row = queryOne(
    'SELECT files_json FROM inspiration_addenda WHERE id = ?',
    [addendumId]
  );
  if (!row || !row.files_json) return [];

  // 2. 解析 files_json 为数组
  let filesMeta;
  try {
    filesMeta = JSON.parse(row.files_json);
  } catch (err) {
    console.warn(`[AddendumService] files_json parse failed for ${addendumId}: ${err.message}`);
    return [];
  }
  if (!Array.isArray(filesMeta) || filesMeta.length === 0) return [];

  // 3. 逐个读取文件内容
  // 存储目录与 addendumController 的 multer dest 一致：uploads/addenda/
  const baseDir = path.resolve(process.cwd(), 'uploads', 'addenda');
  const results = [];
  for (const meta of filesMeta) {
    const filename = meta?.filename;
    if (!filename) {
      console.warn(`[AddendumService] skip file without filename:`, meta);
      continue;
    }
    const filePath = path.join(baseDir, filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      results.push({
        filename,
        original_name: meta.original_name || filename,
        size: typeof meta.size === 'number' ? meta.size : content.length,
        content,
      });
    } catch (err) {
      // 单文件读取失败不阻塞，跳过并告警（文件可能已被删除）
      console.warn(`[AddendumService] read file failed: ${filePath}: ${err.message}`);
    }
  }
  return results;
}

export default {
  createAddendum,
  updateAddendum,
  deleteAddendum,
  listAddenda,
  createComment,
  updateComment,
  deleteComment,
  saveReply,
  deleteReply,
  listSavedRepliesByInspiration,
  listAllSavedReplies,
  getAddendumById,
  parseImageArray,
  readAddendumFiles,
};
