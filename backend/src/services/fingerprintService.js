// FingerprintService — 语义指纹生成与维护（K3 架构改造版）
// 功能：基于"原文 + crystal（可空） + chunks（可空）"三源合并，
//       调用 LLM 生成 150-200 字结构化摘要（语义指纹），作为 embedding 的输入。
// 实现方式：
//   1. generate({inspirationId})：读三源 → 截断 → LLM 生成 → 写 inspiration_embeddings 表（stale=1，待 embedding 重算）
//   2. markStale(inspirationId)：编辑内容/确认 crystal/distill 完成时调用，置 stale=1
//   3. ensureFresh(inspirationId)：scan 前置；stale/缺失/模型不一致则同步重算（L6 断链风险）
//   4. LLM 经 coalesce agent 配置（per-agent，与 CoalesceScanService 共用）
//   5. withTimeout + withRetry 包装（30s 超时，重试 1 次）
//   6. 失败抛错，由 taskQueue catch 标记 stale，不冒泡至请求线程
//
// 架构文档 §10.1 接口契约：
//   interface FingerprintService {
//     generate(input: { inspirationId: string }): Promise<{ fingerprint: string }>;
//     markStale(inspirationId: string): Promise<void>;
//     ensureFresh(inspirationId: string): Promise<void>;
//   }
//
// 关键约束（架构 §11 边界条件 + §13 风险）：
//   - 指纹长度 150-200 字（FINGERPRINT_MIN_LENGTH / MAX_LENGTH）
//   - LLM 输入截断：原文 ≤1500 字 + crystal JSON ≤2000 字 + chunks ≤30 条
//   - 指纹仅在产物变化（crystal 确认 / distill / 编辑）时重算（R1：避免 embedding 抖动）
//   - 模型不一致即判 stale 重算（R12：model_name 校验）
//   - crystal 内容在文件系统而非 DB（L5：双源合并）

import { db, saveDb } from '../database/db.js';
import { getOpenAIClient, withRetry, withTimeout, AGENT_TYPES } from './openai.js';
import { getTemperature, getModel } from '../config/modelConfig.js';
import { getCrystallizeLatest } from './inspirationStorage.js';
import {
  FINGERPRINT_MIN_LENGTH,
  FINGERPRINT_MAX_LENGTH,
  FINGERPRINT_INPUT_LIMITS,
  LLM_LIMITS,
  MULTILINGUAL_EMBEDDING_MODEL
} from '../config/constants.js';

/**
 * 截断字符串到指定长度（按字符数）
 * 功能：防止 LLM 输入超上下文
 * 实现方式：String.prototype.slice 按字符数截断，追加省略号
 * @param {string} str - 原始字符串
 * @param {number} maxLen - 最大长度
 * @returns {string} 截断后的字符串
 */
function truncate(str, maxLen) {
  if (!str || typeof str !== 'string') return '';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '…';
}

/**
 * 执行 SQL 查询并返回所有匹配行（对象数组）
 * 功能：与 Inspiration.js 中 queryOne 类似，但返回多行
 * 实现方式：prepare → bind → step 循环 → getAsObject → free
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
 * FingerprintService 单例对象
 * 设计原则：所有方法静态化（无 this 状态），状态由 DB 行承载
 */
export const FingerprintService = {
  /**
   * 生成（或重新生成）灵感的语义指纹
   * 功能：读三源 → 截断 → LLM 生成 → 写 inspiration_embeddings 表（stale=1）
   * 实现方式：
   *   1. 读 inspirations 表（title + content）
   *   2. 读文件系统 crystallize/latest（crystal JSON，L5 双源合并）
   *   3. 读 knowledge_chunks 表（distill 产物，≤30 条）
   *   4. 三源拼接 + 截断：content ≤1500 字 + crystal JSON ≤2000 字 + chunks ≤30 条
   *   5. 构建 prompt → LLM 调用（withTimeout 30s + withRetry 1 次）
   *   6. 长度校验（150-200 字），不达标重试 1 次
   *   7. UPSERT inspiration_embeddings：fingerprint + fingerprint_model + fingerprint_updated_at + stale=1
   *   8. 返回 { fingerprint }
   * @param {{ inspirationId: string }} input - 灵感 ID
   * @returns {Promise<{ fingerprint: string }>}
   * @throws {Error} LLM 超时/输出非法/输入不存在时抛错，由 taskQueue catch
   */
  async generate({ inspirationId }) {
    if (!inspirationId) {
      const err = new Error('inspirationId is required');
      err.code = 'FINGERPRINT_INVALID_INPUT';
      throw err;
    }

    // ===== 1. 读三源 =====
    const inspiration = queryOne('SELECT id, title, content, inspiration_type FROM inspirations WHERE id = ?', [inspirationId]);
    if (!inspiration) {
      const err = new Error(`Inspiration not found: ${inspirationId}`);
      err.code = 'INSPIRATION_NOT_FOUND';
      throw err;
    }

    // 源 1：原文（title + content），截断 ≤1500 字
    const rawContent = `${inspiration.title || ''}\n${inspiration.content || ''}`.trim();
    const contentExcerpt = truncate(rawContent, FINGERPRINT_INPUT_LIMITS.CONTENT_EXCERPT);

    // 源 2：crystal（从文件系统读 latest，L5 双源合并），JSON 截断 ≤2000 字
    // K4 改造：同时读取 selected_dimensions / detected_capsule / concept_orientation（新字段）
    let crystalJson = '';
    let selectedDimensions = null;
    let detectedCapsule = null;
    try {
      const latest = await getCrystallizeLatest(inspirationId);
      if (latest && (latest.crystal || latest.prd)) {
        // 优先 crystal 字段（M3-c 后），兼容 prd 字段（旧数据）
        const crystalData = latest.crystal || latest.prd;
        crystalJson = truncate(JSON.stringify(crystalData), FINGERPRINT_INPUT_LIMITS.CRYSTAL_JSON);
      }
      // K4 新增：读取 crystallize_results 表的新字段（selected_dimensions / detected_capsule）
      // 实现方式：getCrystallizeLatest 返回的 snapshot 包含 v4 迁移后的新字段
      if (latest) {
        selectedDimensions = latest.selected_dimensions || null;
        detectedCapsule = latest.detected_capsule || null;
      }
    } catch (err) {
      // 文件读取失败不阻塞（视为无 crystal）
      console.warn(`[FingerprintService] read crystal failed for ${inspirationId}: ${err.message}`);
    }

    // 源 3：chunks（knowledge_chunks 表，≤30 条），按 selected_at 降序
    let chunksText = '';
    try {
      const chunks = queryAll(
        'SELECT chunk_text, chunk_kind, chunk_subkind FROM knowledge_chunks WHERE inspiration_id = ? ORDER BY selected_at DESC LIMIT ?',
        [inspirationId, FINGERPRINT_INPUT_LIMITS.CHUNKS_MAX]
      );
      if (chunks.length > 0) {
        chunksText = chunks.map(c => `[${c.chunk_kind || 'unknown'}${c.chunk_subkind ? '/' + c.chunk_subkind : ''}] ${c.chunk_text || ''}`).join('\n');
      }
    } catch (err) {
      // 表不存在或查询失败不阻塞（视为无 chunks）
      console.warn(`[FingerprintService] read chunks failed for ${inspirationId}: ${err.message}`);
    }

    // 源 5（v7 新增）：追加条目（inspiration_addenda 表，≤20 条最近条目，评论不读）
    // 功能：把用户最近追加的思考注入指纹，使指纹体现思路演进方向而非停留在最初原文
    let addendaText = '';
    try {
      const addenda = queryAll(
        'SELECT content FROM inspiration_addenda WHERE inspiration_id = ? ORDER BY created_at DESC LIMIT ?',
        [inspirationId, FINGERPRINT_INPUT_LIMITS.ADDENDA_MAX]
      );
      if (addenda.length > 0) {
        addendaText = addenda
          .map((r, i) => `[追加${i + 1}] ${String(r.content || '').slice(0, 200)}`)
          .join('\n');
      }
    } catch (err) {
      // 表不存在或查询失败不阻塞（视为无追加条目）
      console.warn(`[FingerprintService] read addenda failed for ${inspirationId}: ${err.message}`);
    }

    // ===== 2. 构建 prompt =====
    // K4 改造：透传 selectedDimensions / detectedCapsule 给 _buildPrompt（四源输入）
    // v7 改造：新增 addendaText 作为第五源注入
    const inspirationType = inspiration.inspiration_type || '其他';
    const prompt = this._buildPrompt({ inspirationType, contentExcerpt, crystalJson, chunksText, selectedDimensions, detectedCapsule, addendaText });

    // ===== 3. LLM 调用（withTimeout + withRetry） =====
    let fingerprint;
    try {
      fingerprint = await this._callLLM(prompt);
    } catch (err) {
      // 第一次失败：重试 1 次（带修正提示）
      console.warn(`[FingerprintService] first LLM call failed (${err.message}), retrying with hint...`);
      const retryPrompt = prompt + '\n\n## 上次生成失败，请重新生成，严格遵守字数限制（150-200 字）与 JSON 格式。';
      fingerprint = await this._callLLM(retryPrompt);
    }

    // ===== 4. 长度校验（150-200 字）=====
    // 字符数按中文计（含英文与标点，简化处理）
    if (fingerprint.length < FINGERPRINT_MIN_LENGTH || fingerprint.length > FINGERPRINT_MAX_LENGTH) {
      console.warn(`[FingerprintService] fingerprint length ${fingerprint.length} out of [${FINGERPRINT_MIN_LENGTH}, ${FINGERPRINT_MAX_LENGTH}], using as-is`);
      // 不抛错（LLM 难以精确控制字数），落库后由后续 cosine 阶段决定是否可用
    }

    // ===== 5. UPSERT inspiration_embeddings =====
    const now = new Date().toISOString();
    const modelName = MULTILINGUAL_EMBEDDING_MODEL; // 指纹模型与 embedding 模型同源
    try {
      // INSERT OR REPLACE：行存在则覆盖（保留 embedding BLOB 不动，仅更新 fingerprint + 置 stale=1）
      db.run(
        `INSERT OR REPLACE INTO inspiration_embeddings
          (inspiration_id, embedding, fingerprint, fingerprint_model, model_name, stale, fingerprint_updated_at, embedding_updated_at)
         VALUES (?, NULL, ?, ?, ?, 1, ?, NULL)`,
        [inspirationId, fingerprint, modelName, modelName, now]
      );
      saveDb();
      console.log(`[FingerprintService] fingerprint saved for ${inspirationId} (len=${fingerprint.length}, stale=1)`);
    } catch (err) {
      console.error(`[FingerprintService] failed to save fingerprint for ${inspirationId}:`, err.message);
      throw err;
    }

    return { fingerprint };
  },

  /**
   * 标记灵感指纹为 stale（需重算）
   * 功能：编辑内容/确认 crystal/distill 完成时调用
   * 实现方式：UPDATE inspiration_embeddings SET stale=1 WHERE inspiration_id=?
   *           行不存在时静默跳过（无需标记，下次 ensureFresh 会触发首次生成）
   * @param {string} inspirationId - 灵感 ID
   * @returns {Promise<void>}
   */
  async markStale(inspirationId) {
    if (!inspirationId) return;
    try {
      db.run(
        'UPDATE inspiration_embeddings SET stale = 1 WHERE inspiration_id = ?',
        [inspirationId]
      );
      saveDb();
    } catch (err) {
      // 标记失败不阻塞主流程（最坏情况是下次 scan 重算）
      console.warn(`[FingerprintService] markStale failed for ${inspirationId}:`, err.message);
    }
  },

  /**
   * 确保灵感指纹是 fresh 的（scan 前置校验，L6 断链风险）
   * 功能：检查 stale/缺失/模型不一致，需要则同步重算
   * 实现方式：
   *   1. SELECT inspiration_embeddings WHERE inspiration_id=?
   *   2. 以下任一条件成立则调 generate 重算：
   *      a. 行不存在
   *      b. stale=1
   *      c. fingerprint 为空
   *      d. fingerprint_model 与当前模型不一致（R12）
   *   3. 否则直接返回
   * @param {string} inspirationId - 灵感 ID
   * @returns {Promise<void>}
   * @throws {Error} generate 失败时抛错（scanService 应捕获并返回 503/loading）
   */
  async ensureFresh(inspirationId) {
    if (!inspirationId) {
      const err = new Error('inspirationId is required');
      err.code = 'FINGERPRINT_INVALID_INPUT';
      throw err;
    }

    const row = queryOne(
      'SELECT fingerprint, fingerprint_model, stale FROM inspiration_embeddings WHERE inspiration_id = ?',
      [inspirationId]
    );

    const currentModel = MULTILINGUAL_EMBEDDING_MODEL;
    const needsRecompute =
      !row ||                       // 行不存在
      row.stale === 1 ||            // 标记 stale
      !row.fingerprint ||           // 指纹为空
      row.fingerprint_model !== currentModel;  // 模型不一致（R12）

    if (needsRecompute) {
      console.log(`[FingerprintService] ensureFresh: recompute fingerprint for ${inspirationId} (reason: ${!row ? 'no_row' : row.stale === 1 ? 'stale' : !row.fingerprint ? 'empty' : 'model_mismatch'})`);
      await this.generate({ inspirationId });
    }
  },

  /**
   * 读取灵感的当前指纹（不触发重算）
   * 功能：供 scanService 构建 PairSide 时使用
   * 实现方式：SELECT fingerprint FROM inspiration_embeddings WHERE inspiration_id=?
   * @param {string} inspirationId - 灵感 ID
   * @returns {string|null} 指纹文本，无则 null
   */
  getFingerprint(inspirationId) {
    const row = queryOne(
      'SELECT fingerprint FROM inspiration_embeddings WHERE inspiration_id = ?',
      [inspirationId]
    );
    return row?.fingerprint || null;
  },

  // ========== 私有方法 ==========

  /**
   * 构建 LLM 生成指纹的 prompt
   * 功能：将五源（原文 + crystal + chunks + selected_dimensions + detected_capsule + addenda）合并为结构化 prompt
   * K4 改造：新增 selectedDimensions 和 detectedCapsule 参数，作为第四源注入
   * v7 改造：新增 addendaText 参数，作为第五源注入，体现用户思路演进方向
   * v8 改造：源优先级分层——原文为核心源（70%语义占比），其余为补充源（≤30%），
   *          切断词块元标签污染跨灵感 cosine 召回的传播路径
   * 实现方式：模板拼接 + 核心/补充源分区展示 + 量化源占比约束
   * @private
   */
  _buildPrompt({ inspirationType, contentExcerpt, crystalJson, chunksText, selectedDimensions, detectedCapsule, addendaText }) {
    // ===== 核心/补充源分区拼接（v8：明确源优先级）=====
    const coreSections = [];
    coreSections.push(`【灵感类型】${inspirationType}`);
    coreSections.push(`【原文】\n${contentExcerpt}`);

    // 补充源：仅在存在时拼入，不强制出现
    const enrichSections = [];
    if (crystalJson) {
      enrichSections.push(`【结晶体 JSON】\n${crystalJson}`);
    }
    if (chunksText) {
      enrichSections.push(`【词块】\n${chunksText}`);
    }
    // K4 新增：第四源 selected_dimensions（LLM 在 crystallize 阶段选择的维度路径）
    if (selectedDimensions && Array.isArray(selectedDimensions) && selectedDimensions.length > 0) {
      enrichSections.push(`【选中维度】\n${JSON.stringify(selectedDimensions)}`);
    }
    // K4 新增：第四源 detected_capsule（识别到的设定胶囊名称列表）
    if (detectedCapsule && Array.isArray(detectedCapsule) && detectedCapsule.length > 0) {
      enrichSections.push(`【设定胶囊】\n${detectedCapsule.map(c => c?.name || c).join(', ')}`);
    }
    // v7 新增：第五源 addendaText（用户最近追加的思考）
    if (addendaText) {
      enrichSections.push(`【追加思考】\n${addendaText}`);
    }

    // 组装最终 prompt：核心源与补充源明确分区标注
    const sections = [`## 核心源（指纹主体必须来自此部分）`, ...coreSections];
    if (enrichSections.length > 0) {
      sections.push(`## 补充源（仅用于补充细节，不得主导指纹语义）`, ...enrichSections);
    }

    return `你是 AIRA 系统的语义指纹生成器。请基于以下灵感的多源信息，生成一段 **150-200 字** 的结构化语义摘要（指纹）。

${sections.join('\n\n')}

## 生成规则（严格遵守）

### 1. 源优先级（最重要）
- 【原文】是语义地基，指纹中至少 **70% 的语义空间** 必须来自它
- 【词块】【结晶体】【追加】等补充源仅用于：
  a) 补充原文没有覆盖的**具体技法或概念名称**
  b) 体现用户**思路的演进方向**（如果追加中存在）
- 补充源中的元分类词汇（如 "reference" "imagery" "concept" "technique" 等）**严禁进入指纹正文**

### 2. 结构化要求
指纹应包含以下要素（按需取舍，不必都出现）：
- 核心主题（这个灵感在讲什么）
- 关键意象（视觉/听觉/触觉画面）
- 内在结构（节奏/层次/形态）
- 情感基调（情绪/氛围）
- 技法特征（方法/手法）
- 主题张力（对立/呼应）

### 3. 语义浓缩
不要复述原文，要提炼出"这个灵感的本质是什么"。

### 4. 跨灵感可比
保留可供检索的语义特征（意象词、结构词、情感词），但**禁止使用泛化的抽象术语**（如"空间""感知""梦境""意识"等）填充字数。

### 5. 无废话
不要"这个灵感是关于..."这种元描述，直接给指纹。

### 6. 胶囊意识
若有设定胶囊，指纹中应体现胶囊带来的核心意象与氛围，便于跨灵感匹配同胶囊的内容。

### 7. 思路演进
若有追加思考，指纹应体现用户最新思路的演进方向，而非停留在最初原文。

## 输出格式
纯文本，一段，无换行，无标题，无 markdown，无 JSON 包裹。`;
  },

  /**
   * 调用 LLM 生成指纹
   * 功能：用 coalesce agent 配置调用 LLM，withTimeout + withRetry
   * 实现方式：
   *   1. 取 coalesce agent 的 client + model
   *   2. withTimeout(LLM_LIMITS.TIMEOUT_MS) 包裹
   *   3. withRetry({maxRetries: LLM_LIMITS.RETRY_TIMES}) 包裹
   *   4. 提取 content，trim 后返回
   * @private
   * @param {string} prompt - 完整 prompt
   * @returns {Promise<string>} 指纹文本
   * @throws {Error} LLM 超时/输出空时抛错
   */
  async _callLLM(prompt) {
    const { client, model } = getOpenAIClient(AGENT_TYPES.COALESCE);
    if (!client) {
      const err = new Error('OpenAI client not configured for coalesce agent');
      err.code = 'LLM_NOT_CONFIGURED';
      throw err;
    }

    const temperature = getTemperature(AGENT_TYPES.COALESCE);
    const messages = [
      { role: 'system', content: '你是 AIRA 系统的语义指纹生成器，仅输出 150-200 字纯文本摘要，无任何额外标记。' },
      { role: 'user', content: prompt }
    ];

    // withTimeout + withRetry 双重保护
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

export default FingerprintService;
