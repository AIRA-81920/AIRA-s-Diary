// 追加条目对话控制器（v7 新增）
// 功能：处理 /inspirations/:id/addenda/:addendumId/conversation 端点的 HTTP 请求
// 实现方式：
//   1. 从 db 读灵感 title + content
//   2. 从 db 读当前 addendum
//   3. 从 db 读该 addendum 下的 comments
//   4. 从 inspirationStorage 读最新 crystal（try/catch 降级为 null）
//   5. 组装 context，调用 ConversationAgent.ask()
//   6. 返回 { success: true, data: { answer, searchUsed } }
//
// 缺失数据降级处理：
//   - 无 crystal → context.crystal = null
//   - addendum 不存在 → 404
//   - 灵感不存在 → 404

import ConversationAgent from '../agents/conversationAgent.js';
import { db } from '../database/db.js';
import inspirationStorage from '../services/inspirationStorage.js';
import * as addendumService from '../services/addendumService.js';
import { CONVERSATION_FILE_INPUT_LIMIT } from '../config/constants.js';

// 单例：ConversationAgent 无状态，复用一个实例
const agent = new ConversationAgent();

/**
 * 执行 SQL 查询并返回第一行（对象），无结果返回 null
 * 功能：与项目内其他 service 一致的参数化查询封装
 * 实现方式：db.prepare → bind → step → getAsObject → free
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
 * 执行 SQL 查询并返回所有匹配行（对象数组）
 * @param {string} sql - SQL 语句
 * @param {Array} params - 绑定参数
 * @returns {Array<Object>}
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
 * 安全解析 JSON 字符串为数组
 * 功能：把 links_json / images_json 字段解析回数组，失败降级为空数组
 * @param {string} jsonStr
 * @returns {Array}
 */
function parseJsonArray(jsonStr) {
  if (!jsonStr || typeof jsonStr !== 'string') return [];
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

/**
 * 按累计字符数截断参考文件数组（对话注入用）
 * 功能：按 files 顺序累加 content.length，超过 limit 时停止添加后续文件，
 *       并在最后一个保留文件的 content 末尾追加 "\n\n【后续文件已截断】" 标注
 * 实现方式：
 *   1. 顺序遍历，加入前判断 累计长度 + 当前文件长度 是否超限
 *   2. 超限则停止添加，标记 truncated=true（后续文件全部丢弃）
 *   3. truncated 时给最后一个保留文件的 content 末尾追加截断标注
 *   4. 拷贝对象避免 mutate readAddendumFiles 返回的原始对象
 * 边界：若第一个文件就超限，kept 为空，不追加标注（files 返回空数组）
 * @param {Array<{filename: string, original_name?: string, size?: number, content: string}>} files
 * @param {number} limit - 累计字符上限（CONVERSATION_FILE_INPUT_LIMIT）
 * @returns {Array<{filename: string, original_name?: string, size?: number, content: string}>}
 */
function truncateFiles(files, limit) {
  if (!Array.isArray(files) || files.length === 0) return [];
  const kept = [];
  let total = 0;
  let truncated = false;
  for (const file of files) {
    const len = (file.content || '').length;
    // 加入前判断：累计 + 当前 > 上限 则停止
    if (total + len > limit) {
      truncated = true;
      break;
    }
    kept.push({ ...file });
    total += len;
  }
  // 截断时在最后一个保留文件的 content 末尾追加标注
  if (truncated && kept.length > 0) {
    const last = kept[kept.length - 1];
    last.content = (last.content || '') + '\n\n【后续文件已截断】';
  }
  return kept;
}

/**
 * 对话入口
 * 功能：POST /inspirations/:id/addenda/:addendumId/conversation
 *       body: { question, history? }
 * 实现方式：
 *   1. 从 DB 读取灵感 title/content、addendum、comments
 *   2. 从文件系统读取最新 crystal（降级 null）
 *   3. 组装 context 调用 ConversationAgent.ask
 *   4. 返回 { success: true, data: { answer, searchUsed } }
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function ask(req, res) {
  try {
    const { id, addendumId } = req.params;
    const { question, history } = req.body;

    if (!question) {
      return res.status(400).json({ success: false, error: 'question is required' });
    }

    // ===== 1. 从 DB 读灵感 title + content =====
    const inspiration = queryOne(
      'SELECT title, content FROM inspirations WHERE id = ?',
      [id]
    );
    if (!inspiration) {
      return res.status(404).json({ success: false, error: 'Inspiration not found' });
    }

    // ===== 2. 从 DB 读 addendum =====
    const addendumRow = queryOne(
      'SELECT id, inspiration_id, content, links_json, images_json, files_json, created_at, updated_at FROM inspiration_addenda WHERE id = ?',
      [addendumId]
    );
    if (!addendumRow) {
      return res.status(404).json({ success: false, error: 'Addendum not found' });
    }
    // 组装 addendum 上下文（links/images 解析回数组；files 默认空数组，下方按需填充）
    const addendum = {
      id: addendumRow.id,
      inspiration_id: addendumRow.inspiration_id,
      content: addendumRow.content,
      links: parseJsonArray(addendumRow.links_json),
      images: parseJsonArray(addendumRow.images_json),
      files: [],
      created_at: addendumRow.created_at,
      updated_at: addendumRow.updated_at,
    };

    // ===== 2.1 若 addendum 携带参考文件，读取内容并按累计字符截断注入 =====
    // 功能：files_json 非空时调 readAddendumFiles 取文件内容，按 CONVERSATION_FILE_INPUT_LIMIT 截断
    // 实现：readAddendumFiles 读 uploads/addenda/ 下文件 → truncateFiles 累计截断 → 注入 addendum.files
    if (addendumRow.files_json) {
      try {
        const fileContents = await addendumService.readAddendumFiles(addendumId);
        addendum.files = truncateFiles(fileContents, CONVERSATION_FILE_INPUT_LIMIT);
      } catch (err) {
        // 文件读取失败不阻塞对话，files 保持空数组
        console.warn(`[ConversationController] read addendum files failed for ${addendumId}: ${err.message}`);
      }
    }

    // ===== 3. 从 DB 读 addendum 下的 comments =====
    let comments = [];
    try {
      comments = queryAll(
        'SELECT id, content, created_at, updated_at FROM addendum_comments WHERE addendum_id = ? ORDER BY created_at ASC',
        [addendumId]
      );
    } catch (err) {
      // 评论读取失败降级为空数组，不阻塞对话
      console.warn(`[ConversationController] read comments failed for ${addendumId}: ${err.message}`);
    }

    // ===== 4. 从文件系统读最新 crystal（降级 null） =====
    let crystal = null;
    try {
      const latest = await inspirationStorage.getCrystallizeLatest(id);
      if (latest && (latest.crystal || latest.prd)) {
        crystal = latest.crystal || latest.prd;
      }
    } catch (err) {
      // crystal 读取失败不阻塞，context.crystal 保持 null
      console.warn(`[ConversationController] read crystal failed for ${id}: ${err.message}`);
    }

    // ===== 5. 组装 context，调用 agent.ask =====
    const context = {
      title: inspiration.title,
      content: inspiration.content,
      crystal,
      addendum,
      comments,
    };

    const result = await agent.ask({
      question,
      context,
      history: Array.isArray(history) ? history : [],
    });

    // ===== 6. 返回响应 =====
    res.json({ success: true, data: result });
  } catch (e) {
    console.error('[ConversationController] ask failed:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
}

/**
 * 流式对话入口（SSE）
 * 功能：POST /inspirations/:id/addenda/:addendumId/conversation/stream
 *       body: { question, history? }
 * 实现方式：
 *   1. 设置 SSE 响应头（Content-Type: text/event-stream + 禁用缓冲）
 *   2. 复用 ask() 的上下文组装逻辑（灵感/addendum/comments/crystal）
 *   3. 调用 agent.askStream，通过 onDelta 回调逐 chunk 写 SSE data 帧
 *   4. 每帧 data 为 JSON：{ type: 'delta', text } 或 { type: 'done', searchUsed } 或 { type: 'error', error }
 *   5. 客户端断开时停止写入（监听 res 'close' 事件）
 * 关键坑点：必须监听 res.on('close') 而非 req.on('close')
 *   - req 'close' 在请求体读取完成后就会触发（Express 4.x），会误判为客户端断开
 *   - res 'close' 只在响应连接真正关闭时触发，适合 SSE 断开检测
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function askStream(req, res) {
  // SSE 响应头：禁用 nginx/代理缓冲，保持长连接
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // 写入前刷新头部，确保客户端立刻收到响应头
  res.flushHeaders?.();

  // 客户端断开标记：连接关闭时置 true，避免继续写入
  // 必须用 res 'close' 而非 req 'close'（见上方 JSDoc 关键坑点说明）
  let clientClosed = false;
  const onClose = () => { clientClosed = true; };
  res.on('close', onClose);

  /**
   * 发送一帧 SSE 数据
   * 功能：把对象序列化为 JSON，按 SSE 协议写入 data: 行 + 空行分隔
   * @param {Object} payload - { type, ... }
   */
  const sendFrame = (payload) => {
    if (clientClosed) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const { id, addendumId } = req.params;
    const { question, history } = req.body;

    if (!question) {
      sendFrame({ type: 'error', error: 'question is required' });
      return;
    }

    // 复用 ask() 的上下文组装：灵感 / addendum / comments / crystal
    const inspiration = queryOne(
      'SELECT title, content FROM inspirations WHERE id = ?',
      [id]
    );
    if (!inspiration) {
      sendFrame({ type: 'error', error: 'Inspiration not found' });
      return;
    }

    const addendumRow = queryOne(
      'SELECT id, inspiration_id, content, links_json, images_json, files_json, created_at, updated_at FROM inspiration_addenda WHERE id = ?',
      [addendumId]
    );
    if (!addendumRow) {
      sendFrame({ type: 'error', error: 'Addendum not found' });
      return;
    }
    const addendum = {
      id: addendumRow.id,
      inspiration_id: addendumRow.inspiration_id,
      content: addendumRow.content,
      links: parseJsonArray(addendumRow.links_json),
      images: parseJsonArray(addendumRow.images_json),
      files: [],
      created_at: addendumRow.created_at,
      updated_at: addendumRow.updated_at,
    };

    // 若 addendum 携带参考文件，读取内容并按累计字符截断注入（与 ask() 逻辑一致）
    if (addendumRow.files_json) {
      try {
        const fileContents = await addendumService.readAddendumFiles(addendumId);
        addendum.files = truncateFiles(fileContents, CONVERSATION_FILE_INPUT_LIMIT);
      } catch (err) {
        // 文件读取失败不阻塞流式对话，files 保持空数组
        console.warn(`[ConversationController] read addendum files failed for ${addendumId}: ${err.message}`);
      }
    }

    let comments = [];
    try {
      comments = queryAll(
        'SELECT id, content, created_at, updated_at FROM addendum_comments WHERE addendum_id = ? ORDER BY created_at ASC',
        [addendumId]
      );
    } catch (err) {
      console.warn(`[ConversationController] read comments failed for ${addendumId}: ${err.message}`);
    }

    let crystal = null;
    try {
      const latest = await inspirationStorage.getCrystallizeLatest(id);
      if (latest && (latest.crystal || latest.prd)) {
        crystal = latest.crystal || latest.prd;
      }
    } catch (err) {
      console.warn(`[ConversationController] read crystal failed for ${id}: ${err.message}`);
    }

    const context = {
      title: inspiration.title,
      content: inspiration.content,
      crystal,
      addendum,
      comments,
    };

    // 调用 agent.askStream，每个 delta 立刻发一帧
    const result = await agent.askStream({
      question,
      context,
      history: Array.isArray(history) ? history : [],
      onDelta: (chunk) => sendFrame({ type: 'delta', text: chunk }),
    });

    // 流结束：发 done 帧携带 searchUsed 标志
    sendFrame({ type: 'done', searchUsed: result.searchUsed });
  } catch (e) {
    console.error('[ConversationController] askStream failed:', e.message);
    sendFrame({ type: 'error', error: e.message });
  } finally {
    // 清理连接监听 + 结束响应
    res.off('close', onClose);
    if (!clientClosed) {
      res.end();
    }
  }
}
