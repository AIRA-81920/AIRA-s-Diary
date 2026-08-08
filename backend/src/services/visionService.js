// VisionService — 图片→客观描述服务（多模态输入扩展 v11 任务 4）
// 功能：调用 glm-4v 视觉模型，将图片转为客观中文描述，供追加条目 images_json 使用
// 实现方式：
//   1. describeImage({imagePath}) 或 ({imageBase64, mimeType})：读图→base64→vision 消息→LLM→纯文本描述
//   2. describeForAddendum({addendumId, filename})：包装 describeImage，路径来自 uploads/addenda/
//   3. withTimeout 30s + withRetry 1 次（重试带修正提示，参考 FingerprintService 模式）
//   4. 不直接写 DB，DB 更新由 taskQueue 处理
//
// 接口契约（需求文档 7.8.1）：
//   interface VisionService {
//     describeImage(input: { imagePath?: string, imageBase64?: string, mimeType?: string }): Promise<{ description: string }>;
//     describeForAddendum(input: { addendumId: string, filename: string }): Promise<{ description: string }>;
//   }
//
// 关键约束：
//   - systemPrompt 单一来源（本文件顶部 SYSTEM_PROMPT），不散落到调用方
//   - 消息结构遵循 OpenAI vision：content 数组含 text + image_url 两个 part
//   - 客户端为 null（无 API key）时抛错 `[VisionService] OpenAI client not configured`
//   - 重试时在 text part 追加修正提示，不修改 image_url part

import fs from 'fs';
import path from 'path';
import { getOpenAIClient, withRetry, withTimeout, AGENT_TYPES } from './openai.js';
import { getTemperature } from '../config/modelConfig.js';
import { LLM_LIMITS } from '../config/constants.js';

// 日志前缀（项目惯例：[ServiceName]）
const LOG_PREFIX = '[VisionService]';

// 追加图片上传目录（与 addendumController.js 保持一致：uploads/addenda/）
const UPLOADS_ADDENDA_DIR = path.resolve(process.cwd(), 'uploads', 'addenda');

// ===== systemPrompt（需求文档 7.8.1，单一来源，禁止散落）=====
// 功能：约束 LLM 客观描述图片，分类处理环境图/文本图，强制中文输出；
//       当携带灵感语境（context：标题+指纹）时，追加可选的"关联补充"层，
//       让描述贴合灵感材料——仅当确有概念/意象关联时才补一句，强约束不许硬凑

// 基础段（始终存在）：客观描述的三大原则 + 输出格式
const BASE_SYSTEM_PROMPT = `你是 AIRA 系统的视觉描述助手，擅长客观描述图片内容。

## 核心原则
1. **客观描述**：只描述图片中确实存在的物体、场景、人物、文字，不添加主观意象或情感渲染
2. **分类处理**：先判断图片类型，再采用对应描述方式
3. **环境图**（场景/物体/人物）：一段话描述，30-80 字，覆盖主体、场景、关键细节
   例：「一只黑猫蹲在木制窗台上，背景是模糊的城市夜景，窗外有霓虹灯光」
4. **文本图**（截图/文档/笔记）：识别并提取图片中的文字内容，直接输出识别到的文字
5. **强制中文**：环境图描述一律使用中文；文本图内容保持原文（如英文原文保留英文）

## 输出格式
纯文本，一段话，无标题，无 JSON 包裹，无 markdown 标记。`;

// 语境 + 关联/延伸段（仅在提供灵感 context 时拼入）：
//   - 语境仅作背景参考，不强求匹配
//   - 关联层是可选：确有概念/意象呼应才点出具体意象，不泛泛说"相关"
//   - 延伸层更克制：仅在关联成立且视角明确可成立时，给一句启发性的视角；否则省略
//   - 严格克制：任何牵强/泛泛/臆测都禁止，宁可只留客观描述
const CONTEXT_SYSTEM_PROMPT = `

## 灵感语境（仅作背景参考）
你正为某个灵感（思考条目）识别图片。以下是它所属灵感的标题与语义指纹，**仅作背景参考**，
帮助你判断图片是否与它相关；它不要求你改变对图片的事实描述。
所属灵感标题：\${title}
灵感语义指纹：\${fingerprint}

## 关联与延伸（可选层，严格克制）
在完成客观描述后，**仅当**图片内容与灵感确有可成立的联系时才考虑补充，分两层，任一层不符合就省略：
1. **灵感关联**：图片与灵感在"文本概念相似"或"意象/主题一致"上确有呼应时，点出**所呼应的具体意象或概念**
   （如"锈蚀军事头盔与少女裙摆同框"），不要用"呼应XX""与之相关"这类泛泛表述。
2. **灵感延伸**（更克制）：在关联成立的前提下，若画面与灵感之间存在**明确、可自然成立的视角延伸**，
   再用一句话给出"这一画面可为这条灵感补充的视角/思路"。若延伸牵强、不确定、或只是泛泛的创作建议，一律省略。
- 文字图（截图/文档/笔记）：看识别出的文字与灵感概念是否呼应
- 环境图：看画面主体、意象与灵感的意象是否可对应
**任何牵强、泛泛、臆测的联想都严格禁止，宁可只保留客观描述。**

## 输出格式
（客观描述一段话）

灵感关联：…（可选，仅当确有呼应时）
灵感延伸：…（可选，仅在关联成立且视角明确时）`;

// 修正提示（重试时追加到 text part 末尾，参考 FingerprintService 的修正提示模式）
const RETRY_HINT = '\n\n## 上次识别失败，请重新客观描述图片，严格遵守输出格式（纯文本，客观描述一段话；如有灵感语境，灵感关联/延伸仅在确凿时应给出，牵强的一律省略）。';

/**
 * 组装最终 systemPrompt
 * 功能：根据是否提供灵感 context（title+fingerprint）决定是否拼入"语境 + 关联补充"段
 * 实现方式：context 中 title/fingerprint 任一有效时，用 CONTEXT_SYSTEM_PROMPT 的模板替换变量再拼接；
 *           否则只返回基础段（纯客观描述，不注入灵感语境）
 * @param {{ title?: string, fingerprint?: string }|null} context - 灵感语境
 * @returns {string} 完整 systemPrompt
 */
function buildSystemPrompt(context) {
  let prompt = BASE_SYSTEM_PROMPT;
  const hasTitle = !!(context && context.title && String(context.title).trim());
  const hasFingerprint = !!(context && context.fingerprint && String(context.fingerprint).trim());
  // 两者都无 → 纯客观（用户约定：缺语境时不做任何贴合）
  if (!hasTitle && !hasFingerprint) return prompt;
  // 有语境：拼入语境 + 关联补充段（title/fingerprint 缺失的用空占位）
  return prompt + CONTEXT_SYSTEM_PROMPT
    .replace('${title}', context.title || '')
    .replace('${fingerprint}', context.fingerprint || '');
}

// 扩展名 → MIME type 映射（白名单，与 addendumController 的 ALLOWED_MIME 对齐）
const EXT_TO_MIME = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.gif':  'image/gif'
};

/**
 * 根据文件扩展名推断 MIME type
 * 功能：从文件名解析扩展名，返回对应 MIME；未知扩展名兜底为 image/jpeg
 * 实现方式：path.extname + 小写化 + 查表
 * @param {string} filename - 文件名（含扩展名）
 * @returns {string} MIME type
 */
function inferMimeType(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  return EXT_TO_MIME[ext] || 'image/jpeg';
}

/**
 * 读取图片文件并转 base64
 * 功能：校验文件存在 → 同步读取 → Buffer.toString('base64')
 * 实现方式：fs.existsSync + fs.readFileSync
 * @param {string} imagePath - 图片绝对路径
 * @returns {{ base64: string, mimeType: string }}
 * @throws {Error} 文件不存在时抛错（code: VISION_FILE_NOT_FOUND）
 */
function readImageAsBase64(imagePath) {
  if (!fs.existsSync(imagePath)) {
    const err = new Error(`Image file not found: ${imagePath}`);
    err.code = 'VISION_FILE_NOT_FOUND';
    throw err;
  }
  const buffer = fs.readFileSync(imagePath);
  const base64 = buffer.toString('base64');
  const mimeType = inferMimeType(imagePath);
  return { base64, mimeType };
}

/**
 * VisionService 单例对象
 * 设计原则：参考 FingerprintService 风格，所有方法静态化（无 this 状态），状态由调用方（taskQueue）管理
 */
export const VisionService = {
  /**
   * 描述图片内容
   * 功能：读图 → base64 → 构建 OpenAI vision 消息 → LLM 调用 → 纯文本中文描述
   * 实现方式：
   *   1. 输入支持 imagePath 或 imageBase64+mimeType 两种形式（二选一）
   *   2. 读图转 base64（imagePath 模式），或直接使用传入的 base64
   *   3. 构建 content: [{type:'text', text:systemPrompt(context)}, {type:'image_url', image_url:{url:'data:...'}}]
   *   4. 调 _callLLM（withTimeout 30s + withRetry 1 次）
   *   5. 第一次失败：带修正提示重试 1 次（参考 FingerprintService.generate 模式）
   *   6. 返回 { description }
   * @param {{ imagePath?: string, imageBase64?: string, mimeType?: string, context?: {title?: string, fingerprint?: string} }} input - 图片输入
   * @returns {Promise<{ description: string }>}
   * @throws {Error} 输入非法 / 客户端未配置 / 文件不存在 / LLM 超时 / 输出空时抛错
   */
  async describeImage(input) {
    const { imagePath, imageBase64, mimeType, context } = input || {};

    // ===== 1. 解析图片 base64 + mimeType =====
    let base64, finalMime;
    if (imagePath) {
      // 文件路径模式：读文件转 base64
      const result = readImageAsBase64(imagePath);
      base64 = result.base64;
      finalMime = result.mimeType;
    } else if (imageBase64) {
      // 直接传入 base64 模式（调用方已读好文件）
      base64 = imageBase64;
      finalMime = mimeType || 'image/jpeg';
    } else {
      const err = new Error('Either imagePath or imageBase64 is required');
      err.code = 'VISION_INVALID_INPUT';
      throw err;
    }

    // ===== 2. 构建 OpenAI vision 消息 =====
    // 消息结构：content 数组含 text（systemPrompt）+ image_url（data URL）两个 part
    // systemPrompt 依据 context（标题+指纹）动态组装：有语境时拼接"关联补充"层，否则纯客观
    const dataUrl = `data:${finalMime};base64,${base64}`;
    const systemPrompt = buildSystemPrompt(context);
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: systemPrompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ];

    // ===== 3. LLM 调用（withTimeout + withRetry）=====
    let description;
    try {
      description = await this._callLLM(messages);
    } catch (err) {
      // 第一次失败：重试 1 次（带修正提示，参考 FingerprintService.generate 模式）
      console.warn(`${LOG_PREFIX} first LLM call failed (${err.message}), retrying with hint...`);
      const retryMessages = [
        {
          role: 'user',
          content: [
            // 修正提示追加到 text part 末尾，image_url part 保持不变
            { type: 'text', text: systemPrompt + RETRY_HINT },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ];
      description = await this._callLLM(retryMessages);
    }

    return { description };
  },

  /**
   * 为追加条目的图片生成描述
   * 功能：包装 describeImage，图片路径来自 uploads/addenda/<filename>
   * 实现方式：拼接绝对路径 → 调 describeImage → 返回 { description }
   *   - context 为可选的灵感语境（标题+指纹），用于提示词贴合灵感材料；
   *     缺省/null 时退回纯客观描述
   *   - 不直接写 DB，DB 更新（images_json）由 taskQueue 处理
   *   - addendumId 仅用于日志追踪，本服务不查 DB
   * @param {{ addendumId: string, filename: string, context?: {title?: string, fingerprint?: string} }} input - 追加条目 ID + 图片文件名 + 灵感语境
   * @returns {Promise<{ description: string }>}
   * @throws {Error} filename 缺失 / 文件不存在 / LLM 失败时抛错
   */
  async describeForAddendum({ addendumId, filename, context }) {
    if (!filename) {
      const err = new Error('filename is required');
      err.code = 'VISION_INVALID_INPUT';
      throw err;
    }
    const imagePath = path.join(UPLOADS_ADDENDA_DIR, filename);
    console.log(`${LOG_PREFIX} describeForAddendum: addendumId=${addendumId}, file=${filename}, hasContext=${!!(context && (context.title || context.fingerprint))}`);
    return this.describeImage({ imagePath, context });
  },

  // ========== 私有方法 ==========

  /**
   * 调用 LLM 进行视觉描述
   * 功能：用 VISION agent 配置调用 LLM，withTimeout + withRetry 双重保护
   * 实现方式：
   *   1. 取 VISION agent 的 client + model + temperature（client 为 null 时抛错）
   *   2. withRetry(maxRetries: LLM_LIMITS.RETRY_TIMES) 包裹瞬时错误重试
   *   3. withTimeout(LLM_LIMITS.TIMEOUT_MS) 包裹超时控制
   *   4. 提取 choices[0].message.content，trim 后返回
   * @private
   * @param {Array} messages - OpenAI 消息数组（content 为多模态数组）
   * @returns {Promise<string>} 描述文本（trim 后）
   * @throws {Error} 客户端未配置 / LLM 超时 / 输出空时抛错
   */
  async _callLLM(messages) {
    const { client, model } = getOpenAIClient(AGENT_TYPES.VISION);
    if (!client) {
      const err = new Error(`${LOG_PREFIX} OpenAI client not configured`);
      err.code = 'LLM_NOT_CONFIGURED';
      throw err;
    }

    const temperature = getTemperature(AGENT_TYPES.VISION);

    // withRetry + withTimeout 双重保护（与 FingerprintService._callLLM 一致）
    const result = await withRetry(
      () => withTimeout(
        client.chat.completions.create({ model, messages, temperature }),
        LLM_LIMITS.TIMEOUT_MS
      ),
      { maxRetries: LLM_LIMITS.RETRY_TIMES, baseDelayMs: LLM_LIMITS.RETRY_BACKOFF_MS[0] || 1000 }
    );

    const content = result?.choices?.[0]?.message?.content || '';
    const trimmed = content.trim();
    if (!trimmed) {
      const err = new Error('LLM returned empty content');
      err.code = 'LLM_OUTPUT_INVALID';
      throw err;
    }
    return trimmed;
  }
};

export default VisionService;
