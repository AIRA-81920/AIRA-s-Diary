// EmbeddingService — 文本→384 维语义向量（K3 架构改造版）
// 功能：基于 Xenova/paraphrase-multilingual-MiniLM-L12-v2（ONNX 量化）生成 384 维向量，
//       供 CoalesceScanService 做 cosine 召回；提供纯函数 cosine 计算。
// 实现方式：
//   1. 单例懒加载：init() 仅执行一次，成功后 embedder 常驻内存
//   2. 失败抛错不降级（ADR-6）：模型加载失败立即抛错，绝不静默回退到 n-gram 哈希
//   3. cacheDir 用 __dirname 相对路径（V0.6 硬编码 '/workspace/.cache/xenova' 是 bug，已修复）
//   4. HF_ENDPOINT 默认 https://hf-mirror.com（仅作模型缺失时兜底下载，本地已有则不联网）
//   5. embed(text) 返回 Float32Array(384)；cosine(a,b) 纯函数
//   6. modelName 只读属性，供 fingerprintService / scanService 写入行内 model_name（R12：模型不一致即 stale）
//
// 架构文档 §10.1 接口契约：
//   interface EmbeddingService {
//     init(): Promise<void>;
//     embed(text: string): Promise<Float32Array>;
//     cosine(a: Float32Array, b: Float32Array): number;
//     readonly modelName: string;
//   }
//
// 关键约束：
//   - ONNX 首载 3–5s（架构 §12.1），启动同步预热，未 ready 时 API 返回 503 EMBEDDING_UNAVAILABLE
//   - 全部推理经 taskQueue 串行执行（架构 §6.6），避免并发推理抢占
//   - 批量 embed 用 Promise.all（架构 project_memory 要求真并行，但实际由 taskQueue 串行调度）

import path from 'path';
import { fileURLToPath } from 'url';
import {
  MULTILINGUAL_EMBEDDING_MODEL,
  EMBEDDING_DIMENSION,
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_WEIGHTS,
  LLM_LIMITS
} from '../config/constants.js';

// ESM 下手动构造 __dirname（与 db.js 一致风格）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 模型缓存目录：优先环境变量（Electron 打包后由主进程注入 %APPDATA% 或 resources/models），
// 否则回退 __dirname 相对路径（与 V0.6 搬运过来的目录结构一致：backend/.cache/hub）
const CACHE_DIR = process.env.CACHE_DIR || path.resolve(__dirname, '../../.cache/hub');

// 单例状态（模块级变量）
let pipelineFn = null;     // @huggingface/transformers 的 pipeline 函数
let embedder = null;       // 已加载的 feature-extraction pipeline 实例
let initPromise = null;    // 防止并发 init（initPromise 模式）
let mlAvailable = false;   // 模型是否已就绪（健康门）

/**
 * EmbeddingService 单例对象
 * 设计原则：所有方法静态化（无 this 状态），状态收敛在模块级变量
 */
export const EmbeddingService = {
  /**
   * 模型名（只读）— 写入 inspiration_embeddings.model_name / chunk_embeddings.model_name
   * 读取时校验一致性，不一致即判 stale 重算（R12）
   */
  get modelName() {
    return MULTILINGUAL_EMBEDDING_MODEL;
  },

  /**
   * 向量维度（只读）— 384
   */
  get dimension() {
    return EMBEDDING_DIMENSION;
  },

  /**
   * 健康门：模型是否已就绪
   * 功能：供 server.js 启动健康检查、scanService 前置校验使用
   * 实现：返回 mlAvailable 布尔值
   * @returns {boolean}
   */
  isReady() {
    return mlAvailable && embedder !== null;
  },

  /**
   * 初始化 ML 模型（懒加载，只执行一次）
   * 功能：加载 ONNX 量化模型到内存，预热 pipeline
   * 实现方式：
   *   1. 已就绪直接返回
   *   2. 用 initPromise 模式防并发 init（多次调用共享同一个 Promise）
   *   3. 配置 env：cacheDir 用 __dirname 相对路径 + HF_ENDPOINT 兜底 + allowRemoteModels=true（仅缺失时下载）
   *   4. 失败抛错不降级（ADR-6）：清空状态后 re-throw，调用方必须处理
   * @returns {Promise<void>}
   * @throws {Error} 模型加载失败时抛错，绝不静默降级
   */
  async init() {
    // 已就绪：幂等返回
    if (mlAvailable && embedder) return;

    // 防并发：共享同一个 initPromise
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        // 动态 import @huggingface/transformers（避免顶层 import 阻塞）
        const { pipeline, env } = await import('@huggingface/transformers');

        // 配置本地模型路径（v3 用 localModelPath 加载本地模型，cacheDir 仅用于远程下载缓存）
        // 路径：backend/.cache/hub（其下有 Xenova/paraphrase-multilingual-MiniLM-L12-v2/ 目录）
        env.localModelPath = CACHE_DIR;
        // cacheDir 仍设置（兼容性，远程下载时会用，但 allowRemoteModels=false 后不会触发）
        env.cacheDir = CACHE_DIR;
        // HF_ENDPOINT 默认 https://hf-mirror.com（中国网络加速，仅缺失时兜底下载）
        if (!process.env.HF_ENDPOINT) {
          process.env.HF_ENDPOINT = 'https://hf-mirror.com';
        }
        // 本地优先 + 缺失时自动远程下载
        // 原配置 allowRemoteModels=false 仅适用"模型已内置"场景；
        // 打包发布时不再内置 286MB 模型，改为首次启动自动下载到 .cache/hub
        env.allowLocalModels = true;
        env.allowRemoteModels = true;

        console.log(`[EmbeddingService] Loading model: ${MULTILINGUAL_EMBEDDING_MODEL}`);
        console.log(`[EmbeddingService] localModelPath: ${env.localModelPath}`);
        console.log(`[EmbeddingService] allowRemoteModels: ${env.allowRemoteModels} (auto-download on first run if missing)`);

        // 加载 feature-extraction pipeline（量化版 q8，对应 model_quantized.onnx）
        // v3 用 dtype 替代 v2 的 quantized 选项：dtype='q8' → 文件名后缀 _quantized
        embedder = await pipeline(
          'feature-extraction',
          MULTILINGUAL_EMBEDDING_MODEL,
          { dtype: 'q8' }
        );
        pipelineFn = pipeline;

        mlAvailable = true;
        console.log('[EmbeddingService] ✅ Model loaded — paraphrase-multilingual-MiniLM-L12-v2 (384-dim)');
      } catch (error) {
        // 失败：清空状态，标记不可用
        mlAvailable = false;
        embedder = null;
        pipelineFn = null;
        console.error('[EmbeddingService] ❌ Model load FAILED:', error.message);
        // ADR-6：失败抛错不降级（绝不静默回退到 n-gram 哈希）
        // 调用方（server.js）应捕获并决定进程退出或继续
        throw new Error(`EmbeddingService init failed: ${error.message}`);
      } finally {
        // 无论成功失败，都清空 initPromise（允许失败后重试）
        initPromise = null;
      }
    })();

    return initPromise;
  },

  /**
   * 生成文本的语义向量（384 维 Float32Array）
   * 功能：调用 ONNX 模型推理，输出归一化的 384 维向量
   * 实现方式：
   *   1. 未就绪自动调 init()（启动预热后通常已就绪）
   *   2. 调 embedder(text, { pooling: 'mean', normalize: true }) 得到 Tensor
   *   3. 返回 Float32Array 视图（不拷贝，性能最优）
   *   4. 推理失败抛错（不降级），由 taskQueue 统一 catch 标记 stale
   * @param {string} text - 待向量化的文本
   * @returns {Promise<Float32Array>} 384 维归一化向量
   * @throws {Error} 模型未就绪或推理失败时抛 EMBEDDING_UNAVAILABLE
   */
  async embed(text) {
    // 未就绪：尝试 init；init 失败则抛错
    if (!mlAvailable || !embedder) {
      await this.init();
    }
    // 二次校验（init 可能失败）
    if (!mlAvailable || !embedder) {
      const err = new Error('EmbeddingService not ready: model unavailable');
      err.code = 'EMBEDDING_UNAVAILABLE';
      throw err;
    }

    // 输入校验：非字符串或空字符串抛错
    if (typeof text !== 'string' || text.length === 0) {
      const err = new Error('embed() requires non-empty string');
      err.code = 'EMBEDDING_INVALID_INPUT';
      throw err;
    }

    try {
      // 调用 pipeline：mean pooling + L2 normalize（输出单位向量，cosine 即点积）
      const output = await embedder(text, { pooling: 'mean', normalize: true });
      // output.data 是 Float32Array，长度 384；直接返回视图避免拷贝
      const vec = output.data;
      if (vec.length !== EMBEDDING_DIMENSION) {
        console.warn(`[EmbeddingService] Unexpected dim: got ${vec.length}, expected ${EMBEDDING_DIMENSION}`);
      }
      return vec;
    } catch (error) {
      console.error('[EmbeddingService] embed() failed:', error.message);
      const err = new Error(`Embedding inference failed: ${error.message}`);
      err.code = 'EMBEDDING_UNAVAILABLE';
      throw err;
    }
  },

  /**
   * 批量生成 embeddings（Promise.all 真并行，但实际由 taskQueue 串行调度）
   * 功能：一次性生成多条文本的向量，供 distill 批量场景使用
   * 实现方式：
   *   1. 校验输入数组长度 ≤ EMBEDDING_BATCH_SIZE（32）
   *   2. 用 Promise.all 并发触发 embed()（但 ONNX 内部仍串行）
   *   3. 失败逐条标记，不阻塞其他（架构 §6.5：批量 embed 单条 20s 超时）
   * @param {string[]} texts - 待向量化的文本数组
   * @returns {Promise<Float32Array[]>} 向量数组（与输入同序）
   */
  async embedBatch(texts) {
    if (!Array.isArray(texts)) {
      throw new Error('embedBatch() requires array input');
    }
    if (texts.length > EMBEDDING_BATCH_SIZE) {
      console.warn(`[EmbeddingService] Batch size ${texts.length} exceeds ${EMBEDDING_BATCH_SIZE}, truncating`);
      texts = texts.slice(0, EMBEDDING_BATCH_SIZE);
    }
    // Promise.all 真并行（但 ONNX runtime 内部仍串行，主要是避免 await 循环开销）
    return Promise.all(texts.map(t => this.embed(t)));
  },

  /**
   * 计算两个向量的余弦相似度（纯函数）
   * 功能：a·b / (|a|·|b|)，归一化向量简化为 a·b
   * 实现方式：
   *   1. 长度校验：不等长返回 0
   *   2. 归一化向量（embed 输出已 normalize）直接点积即为 cosine
   *   3. 但为防未归一化输入（如旧缓存），仍走完整公式 dot / (|a|·|b|)
   * @param {Float32Array|number[]} a - 向量 A
   * @param {Float32Array|number[]} b - 向量 B
   * @returns {number} cosine 相似度，范围 [-1, 1]；输入非法返回 0
   */
  cosine(a, b) {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;
    if (a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const av = a[i];
      const bv = b[i];
      dot += av * bv;
      normA += av * av;
      normB += bv * bv;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  },

  /**
   * 三源加权相似度合成（多源召回共用）
   * 功能：按「标题 / 正文 / 指纹」三源各自的余弦相似度 + EMBEDDING_WEIGHTS 权重合成总分
   * 实现方式：
   *   1. 输入 aVecs / bVecs 为 { fingerprint, title, content }，每项是 Float32Array 或 null
   *   2. 逐源比对：仅当双方该源向量都存在才参与余弦计算
   *   3. 某源缺失时，该源权重按比例分摊到其余已参与源上，保证总分落在权重正常区间、不畸变
   * @param {{fingerprint?: Float32Array, title?: Float32Array, content?: Float32Array}} aVecs - A 方三源向量
   * @param {{fingerprint?: Float32Array, title?: Float32Array, content?: Float32Array}} bVecs - B 方三源向量
   * @returns {{ score: number, sources: {title?: number, content?: number, fingerprint?: number}, basis: string[] }}
   *          score 为加权总分；basis 为实际参与合成的源名；sources 为各源独立 cosine
   */
  weightedSimilarity(aVecs, bVecs) {
    // 三源权重表（缺省 title/content/fingerprint）
    const srcNames = ['title', 'content', 'fingerprint'];

    // 逐源算 cosine，只在双方该源向量都存在时参与
    const cos = {};
    const present = [];
    for (const name of srcNames) {
      const a = aVecs && aVecs[name];
      const b = bVecs && bVecs[name];
      if (a && b && a.length > 0 && b.length > 0) {
        cos[name] = this.cosine(a, b);
        present.push(name);
      }
    }
    // 无任何源可比（全部缺失）：返回 0 分
    if (present.length === 0) {
      return { score: 0, sources: {}, basis: [] };
    }

    // 收集参与源的原始权重
    const rawWeights = { title: EMBEDDING_WEIGHTS.TITLE, content: EMBEDDING_WEIGHTS.CONTENT, fingerprint: EMBEDDING_WEIGHTS.FINGERPRINT };
    // 参与源权重和（防御：全部为 0 / 缺失时回退等权，见 _nonZeroSum）
    const presentWeightSum = this._nonZeroSum(present, rawWeights);

    // 把缺失源权重按比例分摊到参与源，保证总和 = 1
    let score = 0;
    const sources = {};
    for (const name of present) {
      const w = rawWeights[name] / presentWeightSum;
      sources[name] = cos[name];
      score += w * cos[name];
    }
    return { score, sources, basis: present };
  },

  /**
   * 计算参与源权重之和（防御：权重表异常时兜底为各源等权重）
   * @private
   * @param {string[]} present - 参与合成的源名
   * @param {object} rawWeights - 三源原始权重
   * @returns {number} 参与源权重和（>0）
   */
  _nonZeroSum(present, rawWeights) {
    let sum = 0;
    for (const n of present) sum += (rawWeights[n] ?? 0);
    if (sum > 0) return sum;
    // 权重表全缺失/全 0：回退各源等权
    return present.length;
  },

  /**
   * 将 Float32Array 序列化为 Buffer（BLOB 存入 SQLite）
   * 功能：供 fingerprintService 把 embedding 写入 inspiration_embeddings.embedding 列
   * 实现方式：Buffer.from(float32Array.buffer) 直接共享底层 ArrayBuffer（零拷贝）
   * @param {Float32Array} vec - 384 维向量
   * @returns {Buffer} 1536 字节（384 × 4）
   */
  toBlob(vec) {
    if (!(vec instanceof Float32Array)) {
      vec = new Float32Array(vec);
    }
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  },

  /**
   * 将 Buffer 反序列化为 Float32Array（从 SQLite BLOB 读取）
   * 功能：供 scanService 从 inspiration_embeddings.embedding 列加载向量做 cosine 召回
   * 实现方式：new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
   * @param {Buffer} blob - 1536 字节 BLOB
   * @returns {Float32Array} 384 维向量
   */
  fromBlob(blob) {
    if (!blob || blob.length === 0) return null;
    return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  },

  /**
   * 从 inspiration_embeddings 行组装三源向量对象（多源召回/对账共用）
   * 功能：把指纹/标题/正文三个 BLOB 反序列化为 Float32Array，缺失源为 null
   * 实现方式：fromBlob × 3；子源缺失（旧数据未回填）返回 null，由加权合成自动分摊
   * @param {object} row - 至少含 embedding / embedding_title / embedding_content 字段的行
   * @returns {{ fingerprint: Float32Array|null, title: Float32Array|null, content: Float32Array|null }}
   */
  vecsFromRow(row) {
    return {
      fingerprint: row.embedding ? this.fromBlob(row.embedding) : null,
      title: row.embedding_title ? this.fromBlob(row.embedding_title) : null,
      content: row.embedding_content ? this.fromBlob(row.embedding_content) : null
    };
  }
};

export default EmbeddingService;
