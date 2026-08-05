// 按 Agent 类型分配 OpenAI 模型
// 功能：不同 Agent 使用不同模型（推理类用强模型，创意类用快模型）
// 实现方式：
//   1. 代码内默认值作为 fallback（CODE_DEFAULTS）
//   2. 优先从环境变量读取：全局默认（OPENAI_API_KEY/BASE_URL/DEFAULT_MODEL/DEFAULT_TEMPERATURE）
//      + 按 Agent 覆盖（OPENAI_<KEY/BASE_URL/MODEL/TEMP>_<AGENT>）
//   3. 采用惰性求值（每次调用 resolveConfig），避免 ES module import hoisting
//      导致 dotenv.config() 还没执行就缓存了空 env 的配置
//
// M3 变更：原 CLARIFY/RESEARCH/QUESTION/ASSOCIATION/ORGANIZATION/EVALUATION/EXECUTION
// 精简为 CRYSTALLIZE/EPITAXY/COALESCE 三大用户可见 Agent
// 删除 QUESTION/EVALUATION/EXECUTION/ORGANIZATION（功能下放或废弃）
//
// M3 补丁：每个 Agent 可独立配置 API_KEY / BASE_URL / MODEL / TEMP
//   - 支持 OPENAI_API_KEY_<AGENT> 与 OPENAI_BASE_URL_<AGENT> 单独覆盖
//   - 缺失时回退到全局 OPENAI_API_KEY / OPENAI_BASE_URL
//   - 场景：Crystallize 用 DeepSeek Pro，Epitaxy 用 OpenAI GPT-4o，Coalesce 用其他服务

// Agent 类型枚举（M3 精简后，v7 新增 CONVERSATION）
export const AGENT_TYPES = {
  CRYSTALLIZE: 'crystallize',  // 结晶：感知类型 → 定制化追问 → 生成结晶体（原 CLARIFY）
  EPITAXY:     'epitaxy',      // 外延：方向提案 → 深挖笔记 → 选词填空（原 RESEARCH）
  COALESCE:    'coalesce',     // 融合：跨灵感桥梁 → 新灵感种子（原 ASSOCIATION）
  CONVERSATION:'conversation', // v7 新增：追加条目对话，基于灵感上下文回答用户追问
  VISION:      'vision',       // 图片识图，glm-4v 视觉模型
  DISTILL:     'distill',      // 多文件提炼 title+content
  DEFAULT:     'default'       // 默认 fallback
};

// 代码内默认模型配置（当 .env 未设置时使用）
// 字段：model 模型名、temperature 采样温度
const CODE_DEFAULTS = {
  crystallize:  { model: 'gpt-4o',       temperature: 0.3 },  // 感知+追问+结晶，需要较强推理
  epitaxy:      { model: 'gpt-4o',       temperature: 0.7 },  // 提案+深挖，需要创意+严谨
  coalesce:     { model: 'gpt-4o',       temperature: 0.8 },  // 桥梁生成，需要联想
  conversation: { model: 'gpt-4o',       temperature: 0.5 },  // v7 新增：对话，复用默认模型，可被 env 覆盖为带联网能力的模型
  vision:       { model: 'glm-4v-flash', temperature: 0.3 },  // 识图，低温保证客观
  distill:      { model: 'gpt-4o-mini',  temperature: 0.3 },  // 提炼，低温保证基于原文
  default:      { model: 'gpt-4o-mini',  temperature: 0.5 }
};

/**
 * 解析 temperature 字符串为数字
 * 功能：处理 .env 中字符串形态的数字，校验范围 [0, 2]
 * 实现方式：Number.parseFloat + Number.isNaN + 范围夹紧
 * @param {string|undefined} raw - 原始字符串
 * @param {number} fallback - 解析失败时的回退值
 * @returns {number}
 */
function parseTemperature(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  const n = Number.parseFloat(raw);
  if (Number.isNaN(n)) return fallback;
  // OpenAI temperature 范围 [0, 2]，超出则夹紧
  return Math.min(2, Math.max(0, n));
}

/**
 * 按 Agent 类型计算最终生效的完整配置（惰性求值，每次调用都读取最新 env）
 * 功能：实现"按 Agent 覆盖 > 全局默认 > 代码默认"的优先级，包含 model/temperature/apiKey/baseURL
 * 实现方式：
 *   1. 取代码默认作为起点（model/temperature）
 *   2. 全局默认：OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_DEFAULT_MODEL / OPENAI_DEFAULT_TEMPERATURE
 *   3. 按 Agent 覆盖（仅非 default 类型）：
 *      - OPENAI_MODEL_<AGENT> / OPENAI_TEMP_<AGENT>
 *      - OPENAI_API_KEY_<AGENT> / OPENAI_BASE_URL_<AGENT>
 *   4. apiKey/baseURL 的回退链：per-agent > 全局（缺失时为 undefined，由调用方判断）
 * @param {string} agentType - AGENT_TYPES 中的某个值
 * @returns {{model: string, temperature: number, apiKey: string|undefined, baseURL: string|undefined}}
 */
function resolveConfig(agentType) {
  // 起点：代码默认值（不存在该类型时回退到 default）
  const base = CODE_DEFAULTS[agentType] || CODE_DEFAULTS.default;

  // 全局默认覆盖（.env 中 OPENAI_DEFAULT_MODEL / OPENAI_DEFAULT_TEMPERATURE）
  const globalModel = process.env.OPENAI_DEFAULT_MODEL;
  const globalTemp = process.env.OPENAI_DEFAULT_TEMPERATURE;
  let model = (globalModel && globalModel.trim()) || base.model;
  let temperature = parseTemperature(globalTemp, base.temperature);

  // 全局 API 凭证（所有 Agent 共用，可被 per-agent 覆盖）
  const globalApiKey = process.env.OPENAI_API_KEY;
  const globalBaseURL = process.env.OPENAI_BASE_URL;
  let apiKey = globalApiKey;
  let baseURL = globalBaseURL;

  // 按 Agent 覆盖（仅对非 default 类型生效）
  // 命名约定：OPENAI_<FIELD>_<AGENT 大写>，FIELD 为 MODEL/TEMP/API_KEY/BASE_URL
  if (agentType !== AGENT_TYPES.DEFAULT) {
    const agentKey = agentType.toUpperCase();
    const agentModel = process.env[`OPENAI_MODEL_${agentKey}`];
    const agentTemp = process.env[`OPENAI_TEMP_${agentKey}`];
    const agentApiKey = process.env[`OPENAI_API_KEY_${agentKey}`];
    const agentBaseURL = process.env[`OPENAI_BASE_URL_${agentKey}`];
    if (agentModel && agentModel.trim()) model = agentModel.trim();
    if (agentTemp != null && agentTemp !== '') temperature = parseTemperature(agentTemp, temperature);
    // per-agent 凭证存在才覆盖，否则继续用全局
    if (agentApiKey && agentApiKey.trim()) apiKey = agentApiKey.trim();
    if (agentBaseURL && agentBaseURL.trim()) baseURL = agentBaseURL.trim();
  }

  return { model, temperature, apiKey, baseURL };
}

/**
 * 获取所有 Agent 的最终配置（每次调用都重新解析，用于打印/调试）
 * 兼容旧代码中对 AGENT_MODEL_CONFIG 的引用
 * @returns {Object<string, {model: string, temperature: number, apiKey: string|undefined, baseURL: string|undefined}>}
 */
export function getAgentModelConfig() {
  return Object.fromEntries(
    Object.values(AGENT_TYPES).map((type) => [type, resolveConfig(type)])
  );
}

// 向后兼容：保留 AGENT_MODEL_CONFIG 命名导出，但用 getter 形式惰性求值
// 注意：这是一个新对象，每次访问都重新解析；解构一次后不会再变化
export const AGENT_MODEL_CONFIG = new Proxy({}, {
  get(_target, prop) {
    return getAgentModelConfig()[prop];
  },
  ownKeys() {
    return Reflect.ownKeys(getAgentModelConfig());
  },
  getOwnPropertyDescriptor(_target, prop) {
    const cfg = getAgentModelConfig();
    if (prop in cfg) {
      return { configurable: true, enumerable: true, value: cfg[prop], writable: false };
    }
    return undefined;
  }
});

// 创建 OpenAI 客户端
// 功能：根据 agentType 创建对应客户端，支持 per-agent 独立的 apiKey / baseURL
// 实现方式：
//   1. 通过 resolveConfig 拿到该 Agent 的 apiKey 与 baseURL（已处理优先级）
//   2. 无 apiKey 时返回 null（调用方自行处理）
//   3. baseURL 缺失时回退到 OpenAI 官方默认
import OpenAI from 'openai';

export function createOpenAIClient(agentType = AGENT_TYPES.DEFAULT) {
  const { apiKey, baseURL } = resolveConfig(agentType);
  // 无 API key 时返回 null，调用方需自行处理
  if (!apiKey) return null;
  // 支持通过环境变量配置 baseURL（用于代理或兼容服务）
  return new OpenAI({ apiKey, baseURL: baseURL || 'https://api.openai.com/v1' });
}

// 获取 agentType 对应的模型名
// 实现：惰性调用 resolveConfig，未命中时回退到 default 配置
export function getModel(agentType = AGENT_TYPES.DEFAULT) {
  return resolveConfig(agentType).model;
}

// 获取 agentType 对应的 temperature
// 实现：惰性调用 resolveConfig，未命中时回退到 0.7
export function getTemperature(agentType = AGENT_TYPES.DEFAULT) {
  return resolveConfig(agentType).temperature;
}

/**
 * 启动时打印当前生效的模型配置
 * 功能：便于在控制台一眼确认各 Agent 实际使用的模型与凭证来源（来自代码默认 / 全局 env / per-agent env）
 * 实现方式：遍历所有 Agent 类型，惰性调用 resolveConfig，对比代码默认标注来源
 * @param {boolean} [force=false] - 是否强制打印（默认仅在 OPENAI_API_KEY 存在时打印）
 */
export function printModelConfig(force = false) {
  const hasKey = !!process.env.OPENAI_API_KEY;
  if (!force && !hasKey) return; // 无 API key 时静默，避免日志噪音

  console.log('[ModelConfig] 当前生效的模型配置：');
  for (const type of Object.values(AGENT_TYPES)) {
    const cfg = resolveConfig(type);
    // 判断来源：与代码默认对比，不同则标注 env
    const codeDefault = CODE_DEFAULTS[type] || CODE_DEFAULTS.default;
    const source = (cfg.model !== codeDefault.model || cfg.temperature !== codeDefault.temperature)
      ? 'env'
      : 'code';
    // 凭证来源标注：per-agent 覆盖则标 agent，否则标 global
    const hasPerAgentKey = type !== AGENT_TYPES.DEFAULT && !!process.env[`OPENAI_API_KEY_${type.toUpperCase()}`];
    const hasPerAgentURL = type !== AGENT_TYPES.DEFAULT && !!process.env[`OPENAI_BASE_URL_${type.toUpperCase()}`];
    const credSource = (hasPerAgentKey || hasPerAgentURL) ? 'per-agent' : 'global';
    console.log(`  ${type.padEnd(12)} model=${cfg.model}  temp=${cfg.temperature}  [${source}]  cred=[${credSource}]`);
  }
}
