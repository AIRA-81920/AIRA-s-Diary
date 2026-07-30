// 追加条目数据服务（v7 新增）
// 功能：封装 inspiration_addenda / addendum_comments / saved_ai_replies 三张表的 CRUD 操作
// 实现方式：
//   1. 使用 sql.js 的 db.prepare + bind 实现参数化查询（防 SQL 注入）
//   2. 写操作用 db.run()，读操作用 queryAll/queryOne 转换为对象数组
//   3. 可预期错误（如 JSON 解析失败、子表查询失败）静默降级返回 null/[]，业务错误 throw
//   4. 所有方法均为命名导出 + 末尾 export default 聚合，与 inspirationStorage.js 风格一致

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
 * 创建追加主帖
 * 功能：向 inspiration_addenda 表插入一条新记录
 * 实现方式：db.run 参数化插入，links/images 数组转 JSON 字符串存储
 * @param {string} inspirationId - 灵感 ID
 * @param {{content: string, links?: Array, images?: Array}} data - 主帖内容
 * @returns {{id: string}} 新建记录的 ID
 */
export function createAddendum(inspirationId, { content, links = [], images = [] }) {
  const id = uuidv4();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO inspiration_addenda (id, inspiration_id, content, links_json, images_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, inspirationId, content, JSON.stringify(links), JSON.stringify(images), now]
  );
  saveDb();
  return { id };
}

/**
 * 更新追加主帖
 * 功能：UPDATE content/links_json/images_json/updated_at
 * 实现方式：db.run 参数化更新，行不存在时静默返回 success:false
 * @param {string} addendumId - 追加主帖 ID
 * @param {{content?: string, links?: Array, images?: Array}} data - 待更新字段
 * @returns {{success: boolean}}
 */
export function updateAddendum(addendumId, { content, links, images }) {
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
 * 返回结构：{ id, inspiration_id, content, links:[], images:[], created_at, updated_at,
 *            comments:[{id,content,context,created_at,updated_at}],
 *            saved_replies:[{id,question,answer,core,context,saved_at}] }
 * @param {string} inspirationId - 灵感 ID
 * @returns {Array<Object>} 追加主帖数组（按 created_at 升序）
 */
export function listAddenda(inspirationId) {
  // 查询所有追加主帖（按创建时间升序，时间线日志的默认顺序）
  const addenda = queryAll(
    'SELECT id, inspiration_id, content, links_json, images_json, created_at, updated_at FROM inspiration_addenda WHERE inspiration_id = ? ORDER BY created_at ASC',
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
      savedReplies = queryAll(
        'SELECT id, question, answer, core, context, saved_at FROM saved_ai_replies WHERE addendum_id = ? ORDER BY saved_at ASC',
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
      images: parseJsonArray(row.images_json),
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
 * 实现方式：queryAll 参数化查询；v9 起新增 core/context 字段读取
 * @param {string} inspirationId - 灵感 ID
 * @returns {Array<Object>} 已保存回答数组
 */
export function listSavedRepliesByInspiration(inspirationId) {
  return queryAll(
    'SELECT id, addendum_id, inspiration_id, question, answer, core, context, saved_at FROM saved_ai_replies WHERE inspiration_id = ? ORDER BY saved_at DESC',
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
 * @returns {Array<Object>} 已保存回答摘要数组
 */
export function listAllSavedReplies() {
  // LEFT JOIN 保证：即使灵感或追加主帖被删除（理论上 FK 会级联，这里防御性处理），仍能返回记录
  // v9：新增 r.core / r.context 字段，前端列表预览优先用 core，无 core 时降级用 answer
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
     ORDER BY r.saved_at DESC`
  );
}

/**
 * 按追加主帖 ID 查询单条记录
 * 功能：供 controller 在删除/更新前反查 inspiration_id 之用
 * 实现方式：queryOne 参数化查询
 * @param {string} addendumId - 追加主帖 ID
 * @returns {Object|null}
 */
export function getAddendumById(addendumId) {
  return queryOne(
    'SELECT id, inspiration_id, content, links_json, images_json, created_at, updated_at FROM inspiration_addenda WHERE id = ?',
    [addendumId]
  );
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
};
