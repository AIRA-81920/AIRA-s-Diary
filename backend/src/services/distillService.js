// DistillService — 多文件按需提炼服务（v12 精细化改造）
// 功能：读取多个上传的文本文件，合并后调用 LLM 提炼灵感的 title 与 content；
//       支持"按需提炼"——根据灵感当前 title/content 是否为空，决定只生成缺失字段
// 实现方式：
//   1. computeDistillMode(title, content)：检测字段空状态 → 'both' | 'title' | 'content'
//   2. buildDistillPrompt(mode, ...)：按模式构建 3 套系统提示词
//      - both：AI 全量生成 title + content
//      - title：AI 只生成标题，content 原样保留（透传给 LLM 并要求原样返回）
//      - content：AI 只生成内容，title 原样保留
//   3. distill({ files, baseDir, existingTitle, existingContent })：读取文件 → 合并 → LLM → 解析 JSON → 返回 { title, content, mode }
//   4. distillForInspiration(inspirationId)：读 inspirations.source_files_json + 当前 title/content → 调 distill
//   5. withTimeout 30s + withRetry 1 次（带修正提示，参考 Coalesce 模式）
//   6. 失败抛错，由 taskQueue catch 处理，不冒泡至请求线程
//   7. 不直接写 DB（DB 更新由 taskQueue 处理）

import fs from 'fs/promises';
import path from 'path';
import { db } from '../database/db.js';
import { getOpenAIClient, withRetry, withTimeout, AGENT_TYPES } from './openai.js';
import { getTemperature } from '../config/modelConfig.js';

// 日志前缀
const LOG_PREFIX = '[DistillService]';

// LLM 调用超时与重试参数
const DISTILL_TIMEOUT_MS = 30000;  // 单次 LLM 调用 30s 超时
const DISTILL_MAX_RETRIES = 1;     // withRetry 自动重试 1 次（瞬时错误）

// 上传目录（新建灵感文件存放处）
// 功能：返回 uploads/neoidea 的绝对路径，供 distillForInspiration 默认调用
// 实现方式：path.resolve(process.cwd(), 'uploads/neoidea')
function getUploadsNeoideaDir() {
  return path.resolve(process.cwd(), 'uploads/neoidea');
}

// 系统提示词模板（v12 按需提炼改造）
// 功能：根据提炼模式生成 3 套系统提示词
//   - both：AI 全量生成 title + content
//   - title：AI 只生成标题，content 使用用户已有值（原样返回）
//   - content：AI 只生成内容，title 使用用户已有值（原样返回）
// 实现方式：公共核心原则 + 模式专属任务说明；未生成字段的已有值透传给 LLM，
//           保证 LLM 输出始终是完整 { title, content } JSON（taskQueue 回填逻辑不变）
function buildDistillPrompt(mode, existingTitle, existingContent) {
  const base = `你是 AIRA 系统的灵感提炼助手，擅长从文本文件中提炼灵感的标题和描述。

## 核心原则
1. **严格基于原文**：只基于提供的文件内容提炼，不添油加醋、不发挥、不演绎
2. **多文件合并**：用户拖入的多个文件属于同一个灵感，视为同一主题
3. **主题不一致时**：寻找共同主题；找不到则以篇幅最长的文件为主
4. **强制中文**：输出一律使用中文

## 输出格式
严格的 JSON 对象，无任何额外文字、markdown 标记或代码块包裹。`;

  // 仅标题为空：AI 只生成标题，内容原样保留
  if (mode === 'title') {
    return `${base}

## 任务
- 仅根据文件内容生成标题（title 字段）
- 描述（content）已由用户提供，必须原样返回，不得修改、不得润色

## 用户已有描述（原样返回）
${existingContent}

JSON 字段：
- title：一句话标题，概括核心主题（5-15 字）
- content：上面的"用户已有描述"，逐字原样复制`;
  }

  // 仅内容为空：AI 只生成内容，标题原样保留
  if (mode === 'content') {
    return `${base}

## 任务
- 仅根据文件内容生成描述（content 字段）
- 标题（title）已由用户提供，必须原样返回，不得修改、不得润色

## 用户已有标题（原样返回）
${existingTitle}

JSON 字段：
- title：上面的"用户已有标题"，逐字原样复制
- content：2-3 段描述，概括文件内容（50-250 字，视信息密度而定）`;
  }

  // mode === 'both'：全量提炼
  return `${base}

JSON 字段：
- title：一句话标题，概括核心主题（5-15 字）
- content：2-3 段描述，概括文件内容（50-250 字，视信息密度而定）`;
}

/**
 * 计算提炼模式（按需提炼，v12 新增）
 * 功能：根据灵感当前 title/content 是否为空，决定 DISTILL 任务要生成哪些字段
 * 实现方式：
 *   - title 为空或占位 'Loading' → 视为需要生成标题
 *   - content 为空 → 视为需要生成内容
 *   - 两者都有 → 全量重新提炼（仅"重试提炼"等主动触发场景兜底）
 * @param {string|null} title - 当前标题（'Loading' 为新建占位，视为空）
 * @param {string|null} content - 当前内容
 * @returns {'both'|'title'|'content'} 提炼模式
 */
export function computeDistillMode(title, content) {
  const titleEmpty = !title || title === 'Loading';
  const contentEmpty = !content;
  if (titleEmpty && contentEmpty) return 'both';
  if (titleEmpty) return 'title';
  if (contentEmpty) return 'content';
  return 'both';
}

/**
 * 执行 SQL 查询并返回第一行（对象），无结果返回 null
 * 功能：参数化查询封装，与 fingerprintService 中 queryOne 一致
 * 实现方式：prepare → bind → step → getAsObject → free
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
 * 从 LLM 响应文本中提取 JSON 对象
 * 功能：先直接 JSON.parse，失败时正则匹配 {...} 块再解析
 * 实现方式：参考 BaseAgent._parseJSON 模式
 * @param {string} content - LLM 输出文本
 * @returns {{ title?: string, content?: string, raw?: string, error?: string }}
 */
function parseJSON(content) {
  if (!content) return { raw: '' };
  try {
    // 直接尝试解析（最理想情况：LLM 返回纯 JSON）
    return JSON.parse(content);
  } catch {
    // 正则匹配 JSON 块（贪婪匹配最外层花括号）
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fallthrough */ }
    }
    return { raw: content, error: 'JSON parse failed' };
  }
}

/**
 * 逐个读取文件并用分隔标记合并
 * 功能：将 files 数组中每个文件读为文本，用 "=== 文件名: xxx ===" 分隔标记拼接
 * 实现方式：
 *   1. fs.readFile 逐个读取（utf-8）
 *   2. 单文件读取失败时跳过并告警，不阻塞整体流程
 *   3. 用 \n\n 分隔每个文件块，分隔标记占独立一行
 * @param {Array<{filename: string, original_name?: string, size?: number}>} files - 文件元信息
 * @param {string} baseDir - 文件所在绝对目录
 * @returns {Promise<string>} 合并后的文本
 */
async function readAndMergeFiles(files, baseDir) {
  const blocks = [];
  for (const file of files) {
    const filename = file?.filename;
    if (!filename) {
      console.warn(`${LOG_PREFIX} skip file without filename:`, file);
      continue;
    }
    const filePath = path.join(baseDir, filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      // 分隔标记格式：=== 文件名: xxx.md ===\n（文件内容）
      // 显示名优先用 original_name（用户原始文件名），无则用 filename（服务器文件名）
      const displayName = file.original_name || filename;
      blocks.push(`=== 文件名: ${displayName} ===\n${content}`);
    } catch (err) {
      console.warn(`${LOG_PREFIX} read file failed: ${filePath}: ${err.message}`);
    }
  }
  // 多个文件块之间用空行分隔
  return blocks.join('\n\n');
}

/**
 * 调用 LLM 提炼 title 与 content
 * 功能：用 DISTILL agent 配置调用 LLM，withTimeout + withRetry 包装
 * 实现方式：
 *   1. 取 DISTILL agent 的 client + model
 *   2. withTimeout(30s) 包裹单次调用，withRetry(maxRetries:1) 包裹整体（处理瞬时错误）
 *   3. 提取 message.content 后 trim 返回
 * @param {string} userContent - 用户消息内容（合并后的多文件文本）
 * @param {string} systemPrompt - 系统提示词（按提炼模式构建，默认走全量提炼）
 * @returns {Promise<string>} LLM 输出文本（应为 JSON 字符串）
 * @throws {Error} client 未配置 / LLM 超时 / 输出为空时抛错
 */
async function callLLM(userContent, systemPrompt) {
  const { client, model } = getOpenAIClient(AGENT_TYPES.DISTILL);
  // 无 API key 时抛错，由调用方 catch 处理
  if (!client) {
    const err = new Error(`${LOG_PREFIX} OpenAI client not configured`);
    err.code = 'LLM_NOT_CONFIGURED';
    throw err;
  }

  const temperature = getTemperature(AGENT_TYPES.DISTILL);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  // withTimeout + withRetry 双重保护
  // 功能：withTimeout 防止单次调用卡死，withRetry 处理 429/网络抖动等瞬时错误
  const result = await withRetry(
    () => withTimeout(
      client.chat.completions.create({ model, messages, temperature }),
      DISTILL_TIMEOUT_MS
    ),
    { maxRetries: DISTILL_MAX_RETRIES, baseDelayMs: 1000 }
  );

  const content = result?.choices?.[0]?.message?.content || '';
  const trimmed = content.trim();
  if (!trimmed) {
    const err = new Error(`${LOG_PREFIX} LLM returned empty content`);
    err.code = 'LLM_OUTPUT_INVALID';
    throw err;
  }
  return trimmed;
}

/**
 * 多文件合并 → 按需提炼 title + content（v12 精细化改造）
 * 功能：读取 files 中的文本文件，合并后调用 LLM 提炼灵感标题与描述；
 *       根据 existingTitle/existingContent 是否为空只生成缺失字段，用户已有字段原样保留
 * 实现方式：
 *   1. 校验入参 files 非空、baseDir 有效
 *   2. computeDistillMode 计算提炼模式（both/title/content）
 *   3. buildDistillPrompt 按模式构建系统提示词（未生成字段的已有值透传给 LLM）
 *   4. 逐个 fs.readFile 合并文件（=== 文件名: xxx === 分隔）
 *   5. 调用 LLM（DISTILL agent，withTimeout 30s + withRetry 1 次）
 *   6. 第一次失败时用修正提示重试 1 次（参考 Coalesce 模式）
 *   7. 解析 JSON 输出 { title, content }；已有字段缺失时用用户值兜底，绝不覆盖用户输入
 *   8. 校验"需要生成的字段"非空，失败则抛错（由 taskQueue 标记失败）
 *   9. 返回 { title, content, mode }（mode 供 taskQueue 决定 ai_generated 标记）
 * @param {{ files: Array<{filename: string, original_name?: string, size?: number}>, baseDir?: string,
 *           existingTitle?: string|null, existingContent?: string|null }} input
 *   - existingTitle/existingContent：灵感当前已有值，非空字段不重新生成
 * @returns {Promise<{ title: string, content: string, mode: 'both'|'title'|'content' }>}
 * @throws {Error} 入参非法 / client 未配置 / LLM 超时 / JSON 解析失败 / 需生成字段缺失时抛错
 */
export async function distill({ files, baseDir, existingTitle, existingContent }) {
  // ===== 1. 入参校验 =====
  if (!Array.isArray(files) || files.length === 0) {
    const err = new Error(`${LOG_PREFIX} files is required and must be non-empty array`);
    err.code = 'DISTILL_INVALID_INPUT';
    throw err;
  }
  // baseDir 缺省时使用 uploads/neoidea 默认目录
  const dir = baseDir || getUploadsNeoideaDir();

  // ===== 1.5 计算提炼模式 + 构建系统提示词（v12）=====
  // 功能：检测 title/content 空状态，决定只生成缺失字段；已有字段透传并要求 LLM 原样返回
  const mode = computeDistillMode(existingTitle, existingContent);
  const systemPrompt = buildDistillPrompt(mode, existingTitle, existingContent);

  // ===== 2. 读取并合并文件 =====
  const mergedText = await readAndMergeFiles(files, dir);
  if (!mergedText.trim()) {
    const err = new Error(`${LOG_PREFIX} all files are empty or unreadable`);
    err.code = 'DISTILL_EMPTY_INPUT';
    throw err;
  }

  // ===== 3. LLM 调用（第一次尝试）=====
  let llmOutput;
  try {
    llmOutput = await callLLM(mergedText, systemPrompt);
  } catch (err) {
    // 第一次失败：重试 1 次（带修正提示，参考 Coalesce 模式）
    // 功能：在原合并文本后追加修正提示，强调 JSON 格式约束
    console.warn(`${LOG_PREFIX} first LLM call failed (${err.message}), retrying with hint...`);
    const retryContent = mergedText +
      '\n\n## 上次生成失败，请重新生成，严格遵守 JSON 格式（仅输出 {"title":"...","content":"..."}，无任何额外文字、markdown 标记或代码块包裹）。';
    llmOutput = await callLLM(retryContent, systemPrompt);
  }

  // ===== 4. 解析 JSON 输出 =====
  const parsed = parseJSON(llmOutput);
  // 已有字段兜底：LLM 未返回或返回空时用用户已有值（绝不覆盖用户输入）
  // 需要生成的字段：用 LLM 输出（缺失则后续校验抛错）
  const title = typeof parsed?.title === 'string' ? parsed.title : (existingTitle || '');
  const content = typeof parsed?.content === 'string' ? parsed.content : (existingContent || '');

  // 校验：仅校验"需要生成的字段"必须非空（用户已有字段天然满足）
  // 功能：mode='both' 要求 title+content 都有；mode='title' 只要求 title；mode='content' 只要求 content
  const titleMissing = !title;
  const contentMissing = !content;
  const invalid =
    (mode === 'both' && (titleMissing || contentMissing)) ||
    (mode === 'title' && titleMissing) ||
    (mode === 'content' && contentMissing);
  if (invalid) {
    const err = new Error(`${LOG_PREFIX} LLM output is not valid for mode=${mode}: ${llmOutput.slice(0, 200)}`);
    err.code = 'DISTILL_OUTPUT_INVALID';
    throw err;
  }

  console.log(`${LOG_PREFIX} distill success [mode=${mode}]: title="${title}" contentLen=${content.length}`);
  return { title, content, mode };
}

/**
 * 为灵感按需提炼 title + content（v12 精细化改造）
 * 功能：读 inspirations.source_files_json + 当前 title/content → 调 distill → 返回 { title, content, mode }
 * 实现方式：
 *   1. 查询 inspirations 表的 source_files_json / title / content 字段
 *   2. JSON.parse 解析为 files 数组
 *   3. 调 distill({ files, baseDir: uploads/neoidea, existingTitle, existingContent })
 *      —— existing 非空字段不重新生成（用户已填的标题/内容原样保留）
 *   4. 返回 { title, content, mode }（成功后由调用方 taskQueue 更新 DB + 按 mode 设置 ai_generated 标记）
 * @param {string} inspirationId - 灵感 ID
 * @returns {Promise<{ title: string, content: string, mode: 'both'|'title'|'content' }>}
 * @throws {Error} 灵感不存在 / source_files_json 缺失 / distill 失败时抛错
 */
export async function distillForInspiration(inspirationId) {
  if (!inspirationId) {
    const err = new Error(`${LOG_PREFIX} inspirationId is required`);
    err.code = 'DISTILL_INVALID_INPUT';
    throw err;
  }

  // ===== 1. 读 inspirations.source_files_json + 当前 title/content =====
  // v12：一并读取 title/content，用于按需提炼（只生成缺失字段）
  const row = queryOne(
    'SELECT source_files_json, title, content FROM inspirations WHERE id = ?',
    [inspirationId]
  );
  if (!row) {
    const err = new Error(`${LOG_PREFIX} Inspiration not found: ${inspirationId}`);
    err.code = 'INSPIRATION_NOT_FOUND';
    throw err;
  }

  // ===== 2. 解析 source_files_json =====
  let files;
  try {
    files = row.source_files_json ? JSON.parse(row.source_files_json) : null;
  } catch (err) {
    const e = new Error(`${LOG_PREFIX} source_files_json parse failed for ${inspirationId}: ${err.message}`);
    e.code = 'DISTILL_INVALID_INPUT';
    throw e;
  }
  if (!Array.isArray(files) || files.length === 0) {
    const err = new Error(`${LOG_PREFIX} no source_files for inspiration: ${inspirationId}`);
    err.code = 'DISTILL_INVALID_INPUT';
    throw err;
  }

  // ===== 3. 调 distill（baseDir 默认 uploads/neoidea，携带已有 title/content）=====
  console.log(`${LOG_PREFIX} distillForInspiration: inspirationId=${inspirationId}, files=${files.length}`);
  return distill({
    files,
    baseDir: getUploadsNeoideaDir(),
    existingTitle: row.title,
    existingContent: row.content
  });
}

export default { distill, distillForInspiration };
