// 系统常量配置文件（K3 架构改造版）
// 功能：集中管理项目全局使用的阈值、枚举、批次大小、模型名称等常量
// 实现方式：按架构文档 §10.5 与 §4.2 定义，所有阈值与枚举均为单一来源
//
// 设计原则（架构文档 §2.2）：
//   - 全部阈值集中于本文件，代码中禁止散落魔法数字
//   - 枚举用英文 key 入库，中文 label 由前端映射层产出
//   - 阈值分层：candidate(0.3) / persist(0.5) / llm(0.7) / duplicate(0.9)
//
// 变更历史：
//   - 初版：仅含 SEMANTIC_LINK_THRESHOLD 等少量阈值
//   - K3-a：新增 BRIDGE_TYPES / THRESHOLDS / FRAGMENT_TEMPLATES / INSPIRATION_TYPES
//           废弃旧 BRIDGE_TYPE key（structural_resonance 等），统一为需求书 key

// =========================================================================
// 阈值分层（架构文档 §4.2.5 与 §10.2）
// =========================================================================
// cosine 相似度的四级阈值，不同场景不同阈值
//   - candidate：候选筛选（宽进），cosine >= 0.3 进入候选池
//   - persist  ：写入候选表，cosine >= 0.5 持久化到 coalesce_candidates
//   - llm      ：LLM 深挖触发，cosine >= 0.55 才调 LLM（2026-07 调低：实测 6 灵感最高 cosine 仅 0.66，0.7 永远不触发 LLM）
//   - duplicate：去重检测，cosine >= 0.9 视为重复灵感
export const THRESHOLDS = {
  CANDIDATE: 0.3,
  PERSIST: 0.5,
  LLM: 0.55,
  DUPLICATE: 0.9
};

// =========================================================================
// Bridge Type 枚举（架构文档 §4.2.2 与 §10.1）
// =========================================================================
// 5 种桥梁类型，英文 key 入库，中文 label 由前端映射
// 注意：需求书 key 为准，旧 key（structural_resonance/emotional_echo/thematic_opposition）
//       在 v3 迁移中映射为新 key（structure_resonance/emotion_echo/theme_opposition）
export const BRIDGE_TYPES = {
  IMAGERY_ISOMORPHISM: 'imagery_isomorphism', // 意象同构：不同主题但画面感相似
  STRUCTURE_RESONANCE: 'structure_resonance', // 结构共振：内在结构/逻辑相似
  EMOTION_ECHO: 'emotion_echo',               // 情感回响：唤起相似情绪
  TECHNIQUE_TRANSFER: 'technique_transfer',   // 技法迁移：可借用方法
  THEME_OPPOSITION: 'theme_opposition'        // 主题对立：互为镜像/反面
};

// 旧 key → 新 key 映射表（供 v3 迁移使用）
// 功能：把现状库中的旧 bridge_type 值映射为需求书统一 key
// 实现方式：在 migrateV3 中遍历 bridges 表，逐行映射
export const BRIDGE_TYPE_KEY_MAP = {
  structural_resonance: 'structure_resonance',
  emotional_echo: 'emotion_echo',
  thematic_opposition: 'theme_opposition'
  // imagery_isomorphism / technique_transfer 沿用，无需映射
};

// 所有合法 bridge_type 值（供 schema 校验使用）
export const BRIDGE_TYPE_VALUES = Object.values(BRIDGE_TYPES);

// =========================================================================
// 灵感类型枚举（架构文档 §3.4 与需求书 §3.4）
// =========================================================================
// 7 种灵感类型 + 兜底"其他"，对应 8 种结晶形态
// K4 改造：删除"方法流程"类型（灵感阶段出现率低，相关内容应归入概念命题或产品想法）
//         v4 迁移会把历史"方法流程"数据迁移到"其他"
// fix6 改造：删除"概念命题"（argument_card），新增"概念"（concept_card）
//           概念聚焦"命名 + 定义 + 区分"，不再绑定"命题/论证"
export const INSPIRATION_TYPES = {
  PRODUCT_IDEA: '产品想法',       // 结晶形态：prd
  ATMOSPHERE: '氛围画面',         // 结晶形态：scene_card
  WORLDVIEW: '设定世界观',        // 结晶形态：worldview
  CREATIVE_MATERIAL: '创作素材',  // 结晶形态：creative_direction
  RESEARCH_CURIOSITY: '研究好奇', // 结晶形态：exploration_map
  CHARACTER: '角色人物',          // 结晶形态：character_profile
  CONCEPT: '概念',                // 结晶形态：concept_card（fix6 替换原"概念命题"）
  AESTHETIC_PROPOSAL: '美学提案', // 结晶形态：aesthetic_proposal（K4-a 新增）
  OTHER: '其他'                   // 结晶形态：free_note（兜底）
};

// 灵感类型 → 结晶形态 映射（供 CrystallizeAgent sense 阶段使用）
// K4 改造：删除"方法流程"映射（v4 迁移后历史数据 inspiration_type='其他'）
// fix6 改造：'概念命题' → '概念'，argument_card → concept_card
export const TYPE_TO_CRYSTAL = {
  '产品想法': 'prd',
  '氛围画面': 'scene_card',
  '设定世界观': 'worldview',
  '创作素材': 'creative_direction',
  '研究好奇': 'exploration_map',
  '角色人物': 'character_profile',
  '概念': 'concept_card',
  '美学提案': 'aesthetic_proposal',  // K4-a 新增
  '其他': 'free_note'
};

// =========================================================================
// Epitaxy Fragment 模板映射（架构文档 §10.5）
// =========================================================================
// 7 类型 × 4 模板 + 兜底 4 种 = 32 种 fragment_type 取值空间
// K4 改造：删除"方法流程"行（v4 迁移后历史数据 inspiration_type='其他'，使用兜底模板）
// 契约：后端 excavate 只输出该灵感类型对应行的 4 种 key
//       前端 fragmentMeta 表由同一 JSON 定义生成（防枚举漂移，R9）
export const FRAGMENT_TEMPLATES = {
  '产品想法': ['existing_case', 'anti_pattern', 'tech_constraint', 'user_scenario'],
  '氛围画面': ['visual_reference', 'sensory_detail', 'color_palette', 'mood_contrast'],
  '设定世界观': ['precedent', 'internal_logic', 'edge_case', 'cultural_root'],
  '创作素材': ['material_source', 'technique', 'variation', 'combination'],
  '研究好奇': ['existing_theory', 'open_question', 'counter_evidence', 'implication'],
  '角色人物': ['archetype', 'contradiction', 'motivation', 'voice'],
  '概念': ['concept_precedent', 'distinction_case', 'application_case', 'evolution_case'],  // fix6 新增
  '美学提案': ['aesthetic_precedent', 'variation_case', 'combination_case', 'cultural_root'],  // K4-a 新增
  '其他': ['existing_case', 'concept', 'warning', 'blank'] // 兜底，沿用现有 4 种
};

// 所有合法 fragment_type 值（供 schema 校验使用，自动从 FRAGMENT_TEMPLATES 提取）
export const FRAGMENT_TYPE_VALUES = [
  ...new Set(Object.values(FRAGMENT_TEMPLATES).flat())
];

// =========================================================================
// Fragment Meta 映射（架构文档 §10.5，R9 单一来源）
// =========================================================================
// 功能：为每个 fragment_type 提供中文 label、对应 chunk kind、LLM 提示描述
// 契约：后端 _buildExcavatePrompt 与前端 EpitaxyPanel 渲染均由本表驱动
//       前端 fragmentMeta.js 是本表的同步副本（运行时独立、语义一致）
// kind 取值必须 ∈ CHUNK_KINDS（reference/technique/imagery/concept/warning/material）
export const FRAGMENT_META = {
  // 产品想法
  existing_case:    { label: '同类案例', kind: 'reference', desc: '已存在的同类产品/功能案例，可借鉴其设计决策' },
  anti_pattern:     { label: '反面模式', kind: 'warning',   desc: '应避免的设计反模式或失败案例' },
  tech_constraint:  { label: '技术约束', kind: 'concept',   desc: '实现层面的技术限制、依赖与权衡' },
  user_scenario:    { label: '用户场景', kind: 'imagery',   desc: '用户使用此产品的具体场景与触发时机' },
  // 氛围画面
  visual_reference: { label: '视觉参考', kind: 'reference', desc: '可参考的视觉作品、画家、影像或摄影' },
  sensory_detail:   { label: '感官细节', kind: 'imagery',   desc: '具体的感官描写细节（视觉/听觉/触觉）' },
  color_palette:    { label: '配色方案', kind: 'material',  desc: '可借鉴的配色组合与色彩关系' },
  mood_contrast:    { label: '情绪对比', kind: 'concept',   desc: '画面中的情绪张力与对比结构' },
  // 设定世界观
  precedent:        { label: '先例',     kind: 'reference', desc: '类似世界观的已有作品先例与处理方式' },
  internal_logic:   { label: '内在逻辑', kind: 'concept',   desc: '世界观的自洽性规则与运行机制' },
  edge_case:        { label: '边界情况', kind: 'warning',   desc: '设定可能崩塌或被挑战的极端场景' },
  cultural_root:    { label: '文化根源', kind: 'reference', desc: '设定背后的文化、历史或哲学根源' },
  // 创作素材
  material_source:  { label: '素材来源', kind: 'material',  desc: '可用的原始素材来源（文献/实物/田野）' },
  technique:        { label: '技法',     kind: 'technique', desc: '处理此素材的具体技法或手法' },
  variation:        { label: '变体',     kind: 'concept',   desc: '素材可能的变体方向与演绎' },
  combination:      { label: '组合',     kind: 'concept',   desc: '素材间的组合可能与方法' },
  // 研究好奇
  existing_theory:  { label: '已有理论', kind: 'reference', desc: '相关领域的已有理论与经典论述' },
  open_question:    { label: '开放问题', kind: 'concept',   desc: '领域内尚未解决的核心问题' },
  counter_evidence: { label: '反证',     kind: 'warning',   desc: '与假设相悖的证据或反例' },
  implication:      { label: '推论',     kind: 'concept',   desc: '若假设成立可推导出的进一步结论' },
  // 角色人物
  archetype:        { label: '原型',     kind: 'reference', desc: '角色对应的原型或文学形象谱系' },
  contradiction:    { label: '矛盾',     kind: 'concept',   desc: '角色内在的矛盾张力与性格层次' },
  motivation:       { label: '动机',     kind: 'concept',   desc: '角色行为的深层动机与心理根源' },
  voice:            { label: '声音',     kind: 'imagery',   desc: '角色的语言风格、口吻与口头禅' },
  // 方法流程
  failure_mode:     { label: '失败模式', kind: 'warning',   desc: '流程可能失败的环节与典型故障' },
  optimization:     { label: '优化',     kind: 'technique', desc: '可优化的关键点与改进手法' },
  integration:      { label: '集成',     kind: 'concept',   desc: '与其他流程或系统的集成方式' },
  // 概念（fix6 新增，替换原"概念命题"的 support_arg/counter_arg/analogy）
  concept_precedent: { label: '概念先例', kind: 'reference', desc: '已有相似概念的先例，可借以理解这个概念的边界' },
  distinction_case:  { label: '区分案例', kind: 'concept',   desc: '与相邻概念的具体区分案例，展示何时该用/不该用此概念' },
  application_case:  { label: '应用案例', kind: 'imagery',   desc: '这个概念在具体场景中如何体现/落地的实际案例' },
  evolution_case:    { label: '演化可能', kind: 'concept',   desc: '这个概念未来可能演化为何种形态（命题/产品/美学/方法论）' },
  // 美学提案（K4-a 新增）
  aesthetic_precedent: { label: '美学先例', kind: 'reference', desc: '已有美学流派先例，作为参考或对比对象' },
  variation_case:      { label: '变体案例', kind: 'concept',   desc: '这个流派可能的变体方向与演绎案例' },
  combination_case:    { label: '组合案例', kind: 'technique', desc: '这个流派与其他流派组合的可能与方法' },
  // cultural_root 已在"设定世界观"中定义，复用即可
  // 兜底（其他）
  concept:          { label: '概念',     kind: 'concept',   desc: '与灵感相关的抽象概念' },
  warning:          { label: '陷阱',     kind: 'warning',   desc: '需注意的陷阱或风险' },
  blank:            { label: '笔记',     kind: 'material',  desc: '空白待填的笔记占位' }
};

// =========================================================================
// 词块 kind 枚举（沿用 M3，架构文档 §3.4）
// =========================================================================
export const CHUNK_KINDS = {
  REFERENCE: 'reference',   // 引用：人名/作品/事件
  TECHNIQUE: 'technique',   // 技法：方法/手法
  IMAGERY: 'imagery',       // 意象：感官画面
  CONCEPT: 'concept',       // 概念：抽象思想
  WARNING: 'warning',       // 陷阱：风险提示
  MATERIAL: 'material'      // 素材：可用资源
};

// =========================================================================
// Coalesce 状态枚举（架构文档 §8.3 与 §10.1）
// =========================================================================
// bridges 表的 status 字段取值
export const BRIDGE_STATUS = {
  PENDING: 'pending',         // 待策展（默认）
  CONFIRMED: 'confirmed',     // 用户确认
  DISMISSED: 'dismissed'      // 用户忽略
};

// =========================================================================
// Embedding 模型相关（架构文档 §2.1 与 §4.1）
// =========================================================================
export const MULTILINGUAL_EMBEDDING_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
export const EMBEDDING_DIMENSION = 384;
export const EMBEDDING_BATCH_SIZE = 32;

// =========================================================================
// 语义指纹约束（架构文档 §10.1 与 §11）
// =========================================================================
export const FINGERPRINT_MIN_LENGTH = 150;
export const FINGERPRINT_MAX_LENGTH = 200;
// LLM 输入截断上限（防超上下文）
export const FINGERPRINT_INPUT_LIMITS = {
  CONTENT_EXCERPT: 1500,  // 原文截断 ≤1500 字
  CRYSTAL_JSON: 2000,     // crystal JSON ≤2000 字
  CHUNKS_MAX: 30,         // chunks 最多 30 条
  ADDENDA_MAX: 20         // v7 新增：指纹生成时读取追加主帖的最大条数（按 created_at 降序取最近 N 条）
};

// =========================================================================
// LLM 调用约束（架构文档 §9.5 与 §6.5）
// =========================================================================
export const LLM_LIMITS = {
  TIMEOUT_MS: 30000,           // 通用 LLM 超时 30s
  SCAN_TIMEOUT_MS: 45000,      // scan 深挖超时 45s
  EMBED_TIMEOUT_MS: 20000,     // 单文本 embedding 超时 20s
  RETRY_TIMES: 1,              // 超时/5xx 重试 1 次
  RETRY_BACKOFF_MS: [1000, 3000], // 指数退避 1s→3s
  SCAN_TOP_N: 5,               // scan 深挖的 top N 对上限
  PAIR_CONTENT_EXCERPT: 500    // PairSide 原文截断 ≤500 字
};

// =========================================================================
// 力导向图约束（架构文档 §12.1 R5）
// =========================================================================
export const FORCE_GRAPH_LIMITS = {
  MAX_NODES: 500,              // 节点数上限，超出按 bridgeCount 降序截断
  ITERATIONS: 300              // d3-force 迭代次数上限
};

// =========================================================================
// 后台任务队列约束（架构文档 §10.3 R8）
// =========================================================================
export const TASK_QUEUE_LIMITS = {
  DRAWER_CACHE_MAX: 20         // drawerCache LRU 淘汰上限
};

// =========================================================================
// 历史保留（向后兼容，已废弃但保留导出）
// =========================================================================
// 以下常量保留用于向后兼容，新代码应优先使用 THRESHOLDS / BRIDGE_TYPES 等
export const DEFAULT_SIMILARITY_THRESHOLD = THRESHOLDS.LLM;       // 等价于 LLM 深挖阈值
export const SEMANTIC_LINK_THRESHOLD = THRESHOLDS.PERSIST;        // 等价于持久化阈值
export const DUPLICATE_CHECK_DAYS = 30;
export const MAX_RELATED_INSPIRATIONS = 5;

// 搜索服务（本期不实现，保留供未来扩展）
export const BATCH_SIZE = 3;
export const BATCH_DELAY_MS = 500;

// 自动打标（已废弃，保留导出防引用断裂）
export const AUTO_TAG_MIN_CLUSTER_SIZE = 2;
export const AUTO_TAG_MAX_CLUSTERS = 5;
export const AUTO_TAG_MAX_ITERATIONS = 20;
export const AUTO_TAG_SIMILARITY_THRESHOLD = 0.5;

export const DEFAULT_PAGE_LIMIT = 100;

// =========================================================================
// 维度池（K4 新增，架构文档 §10.6）
// =========================================================================
// 跨类型共享的维度池，每个维度含 type/options/description
// 每个 option 含 id/label/definition/signals/applicable_to（可选）
// 契约：crystallizeAgent._buildPrompt 从本表动态生成 prompt
//       前端 CrystalPreview 从本表读维度元数据（label/icon）
export const DIMENSION_POOL = {
  // ========== 产品想法维度 ==========
  '产品形态': {
    type: 'single_choice',
    description: '产品是什么形态',
    options: [
      { id: 'A1', label: '应用', definition: '明确想做一个软件工具，目的是解决某个具体问题或提升效率', signals: ['工具', 'App', '网站', '系统', '解决', '提升', '简化'] },
      { id: 'A2', label: '游戏', definition: '以体验/玩法为核心，目的是带来某种感受，不要求解决具体问题', signals: ['游戏', '玩家', '玩法', '体验', '沉浸'] },
      { id: 'A3', label: '硬件', definition: '物理设备是核心载体，软件只是配套', signals: ['设备', '硬件', '传感器', '物理'] },
      { id: 'A4', label: '内容产品', definition: '以内容/信息流为核心，产品本身是内容的容器或组织形式', signals: ['博客', '订阅', '知识库', '内容', '信息流'] }
    ]
  },
  '核心价值': {
    type: 'single_choice',
    description: '产品的核心价值是什么',
    options: [
      { id: 'B1', label: '解决什么事情', definition: '产品聚焦的具体问题，用户用完产品后某个痛点被消除', signals: ['问题', '痛点', '效率', '简化', '自动化'], applicable_to: ['A1', 'A3'] },
      { id: 'B2', label: '带来怎样的体验', definition: '玩家/受众获得的核心感受，不要求解决具体问题', signals: ['体验', '感受', '沉浸', '氛围', '美感'], applicable_to: ['A2', 'A4'] },
      { id: 'B3', label: '表达怎样的观点', definition: '产品承载的核心主张，用户用完产品后接受某种观点或信息', signals: ['观点', '主张', '论述', '传播', '教育'], applicable_to: ['A4'] }
    ]
  },
  '目标用户': {
    type: 'free_text',
    description: '产品的具体使用者画像',
    prompt_direction: '产品的具体使用者画像，不是"所有人"，而是有具体特征的一群人'
  },
  '视觉风格': {
    type: 'single_choice',
    description: '产品的视觉风格倾向',
    options: [
      { id: 'F1', label: '写实', definition: '真实感强，照片级质感', signals: ['写实', '真实', '照片'] },
      { id: 'F2', label: '极简', definition: '留白多，元素少，强调呼吸感', signals: ['极简', '留白', '简约'] },
      { id: 'F3', label: '抽象', definition: '几何化/符号化，不追求真实感', signals: ['抽象', '几何', '符号'] },
      { id: 'F4', label: '复古', definition: '怀旧感，老式质感', signals: ['复古', '怀旧', '老式'] },
      { id: 'F5', label: '未来感', definition: '科技感，霓虹/金属/光效', signals: ['未来', '科技', '霓虹', '金属'] }
    ]
  },
  '玩家动机': {
    type: 'single_choice',
    description: '玩家在游戏中的主要动机',
    applicable_to: ['A2'],
    options: [
      { id: 'E1', label: '挑战', definition: '克服困难，获得成就感', signals: ['挑战', '困难', '成就'] },
      { id: 'E2', label: '探索', definition: '发现新事物，满足好奇心', signals: ['探索', '发现', '好奇'] },
      { id: 'E3', label: '创造', definition: '自由创造，表达自我', signals: ['创造', '自由', '表达'] },
      { id: 'E4', label: '沉浸', definition: '代入角色，体验故事', signals: ['沉浸', '代入', '故事'] },
      { id: 'E5', label: '收集', definition: '收集物品，完成图鉴', signals: ['收集', '图鉴', '完成'] }
    ]
  },
  '使用场景': {
    type: 'single_choice',
    description: '产品的使用场景',
    applicable_to: ['A1', 'A3'],
    options: [
      { id: 'F1', label: '在线/离线', definition: '是否需要网络连接', signals: ['在线', '离线', '网络'] },
      { id: 'F2', label: '碎片/沉浸', definition: '使用时间的长短和深度', signals: ['碎片', '沉浸', '时间'] },
      { id: 'F3', label: '工作/生活', definition: '使用场景的正式程度', signals: ['工作', '生活', '正式'] }
    ]
  },
  '情感曲线': {
    type: 'single_choice',
    description: '产品的情感曲线设计',
    applicable_to: ['A2', 'A4'],
    options: [
      { id: 'G1', label: '起伏型', definition: '有节奏的高潮与平息', signals: ['起伏', '节奏', '高潮'] },
      { id: 'G2', label: '持续高压', definition: '保持紧张感，不放松', signals: ['高压', '紧张', '持续'] },
      { id: 'G3', label: '平稳沉浸', definition: '长时间把玩不累', signals: ['平稳', '沉浸', '放松'] },
      { id: 'G4', label: '反转高潮', definition: '平淡中突然爆发的惊艳', signals: ['反转', '高潮', '惊艳'] }
    ]
  },
  // ========== 氛围画面维度 ==========
  '场景类型': {
    type: 'single_choice',
    description: '画面的场景类型',
    options: [
      { id: 'A1', label: '自然场景', definition: '野外/山水/天空/海洋等自然景观为画面主体', signals: ['山', '海', '天空', '森林', '沙漠', '雨雪'] },
      { id: 'A2', label: '人造空间', definition: '室内/城市/建筑/街道等人为建造的空间为画面主体', signals: ['房间', '街道', '建筑', '城市', '地铁'] },
      { id: 'A3', label: '抽象空间', definition: '无具体场景，纯氛围/纯意象/纯情绪的视觉表达', signals: ['情绪', '色彩', '形状', '质感', '抽象'] }
    ]
  },
  '感官主导': {
    type: 'multi_choice',
    max_select: 2,
    description: '画面的主导感官（可多选，最多 2 个）',
    options: [
      { id: 'B1', label: '视觉主导', definition: '画面感最强，视觉元素是氛围的主要载体', signals: ['色彩', '光影', '形状', '画面'] },
      { id: 'B2', label: '听觉主导', definition: '声音是氛围的核心（雨声/爵士/寂静/喧嚣）', signals: ['声音', '音乐', '寂静', '噪音'] },
      { id: 'B3', label: '触觉主导', definition: '温度/质感/重量是氛围的核心（冰冷/粘稠/柔软）', signals: ['温度', '质感', '重量', '触感'] },
      { id: 'B4', label: '嗅觉主导', definition: '气味是氛围的核心（潮湿/烟味/花香）', signals: ['气味', '香味', '烟味'] },
      { id: 'B5', label: '通感混合', definition: '多种感官交织，无法分离出主导感官，且无法选出 2 个明确主导', signals: ['混合', '交织', '通感'] }
    ]
  },
  '情绪基调': {
    type: 'single_choice',
    description: '画面的整体情绪基调',
    options: [
      { id: 'C1', label: '冷峻', definition: '理性、克制、疏离，如雪夜实验室', signals: ['冰冷', '理性', '克制', '疏离'] },
      { id: 'C2', label: '温暖', definition: '柔和、亲密、舒适，如午后阳光', signals: ['温暖', '柔和', '亲密', '舒适'] },
      { id: 'C3', label: '超现实', definition: '诡异 + 荒诞的结合，不合常理但自洽，如达利的融化时钟', signals: ['诡异', '荒诞', '错乱', '不可能', '梦境'] },
      { id: 'C4', label: '宁静', definition: '平静、空灵、无扰，如清晨湖面', signals: ['宁静', '平静', '空灵', '寂静'] },
      { id: 'C5', label: '躁动', definition: '焦躁、不安、能量积聚，如暴风雨前', signals: ['躁动', '不安', '焦躁', '紧张', '能量'] },
      { id: 'C6', label: '孤寂', definition: '孤独、空旷、被遗弃，如废弃车站', signals: ['孤独', '空旷', '废弃', '无人'] },
      { id: 'C7', label: '宏伟', definition: '壮阔、崇高、超越个体，如星空/雪山/大海', signals: ['壮阔', '宏大', '无限', '震撼'] },
      { id: 'C8', label: '忧郁', definition: '内省、沉郁、淡淡的哀伤，如秋日午后', signals: ['忧郁', '沉郁', '哀伤', '内省'] }
    ]
  },
  '主角存在': {
    type: 'single_choice',
    description: '画面中是否有人物存在',
    applicable_to_scene_type_not: ['A3'],
    options: [
      { id: 'D1', label: '无人物', definition: '纯风景/纯场景，画面里没有人', signals: ['无人', '纯景', '空'] },
      { id: 'D2', label: '单人', definition: '孤独感/沉思/行动，画面里有一个人的存在', signals: ['单人', '孤独', '沉思'] },
      { id: 'D3', label: '群像', definition: '关系/共处/对抗，画面里有多个人', signals: ['群像', '多人', '关系'] }
    ]
  },
  '动态属性': {
    type: 'single_choice',
    description: '画面的动态属性',
    applicable_to: ['有动态感或临界感'],
    options: [
      { id: 'E1', label: '定格照片型', definition: '画面像一张照片，完全静止', signals: ['定格', '静止', '照片'] },
      { id: 'E2', label: '连续片段型', definition: '画面是一段流动的过程（如金属变形、烟雾升腾）', signals: ['流动', '过程', '连续'] },
      { id: 'E3', label: '临界时刻型', definition: '即将发生某事的瞬间（如杯子将碎未碎、门将开未开）', signals: ['临界', '即将', '瞬间'] }
    ]
  },
  // ========== 美学提案维度（K4-a 新增） ==========
  '美学媒介': {
    type: 'single_choice',
    description: '这个流派主要通过什么媒介被识别',
    options: [
      { id: 'A1', label: '视觉主导', definition: '这个流派主要通过视觉元素被识别（绘画/设计/影像/造型）', signals: ['画面', '色彩', '形状', '光影', '造型', '视觉'] },
      { id: 'A2', label: '听觉主导', definition: '这个流派主要通过声音被识别（音乐/音效/声音设计）', signals: ['音乐', '节奏', '音色', '旋律', '声音', '节拍'] },
      { id: 'A3', label: '文字主导', definition: '这个流派主要通过文字风格被识别（诗歌/文体/语言风格）', signals: ['文体', '语言', '诗句', '文字风格', '措辞'] },
      { id: 'A4', label: '混合媒介', definition: '多种媒介交织，无法分离出主导媒介', signals: ['混合', '交织', '多媒介'] }
    ]
  },
  '美学属性': {
    type: 'multi_choice',
    max_select: 2,
    description: '这个流派的主导感官属性（可多选，最多 2 个）',
    options: [
      { id: 'C1', label: '视觉特征', definition: '这个流派的视觉表现特征（色彩/构图/形状/质感）', signals: ['色彩', '构图', '形状', '视觉特征'] },
      { id: 'C2', label: '听觉特征', definition: '这个流派的听觉表现特征（节奏/音色/编排/声场）', signals: ['节奏', '音色', '编排', '声场'] },
      { id: 'C3', label: '质感特征', definition: '这个流派的质感特征（粗糙/光滑/粘稠/干燥/湿润）', signals: ['质感', '粗糙', '光滑', '粘稠', '干燥', '湿润'] },
      { id: 'C4', label: '动态特征', definition: '这个流派的动态特征（静止/流动/断裂/临界/循环）', signals: ['静止', '流动', '断裂', '临界', '循环', '动态'] }
    ]
  },
  '核心定义': {
    type: 'free_text',
    description: '用一句话定义这个流派是什么',
    prompt_direction: '如果一句话告诉别人你命名的这个流派是什么，你会怎么说？'
  },
  '情感内核': {
    type: 'single_choice',
    description: '这个流派传达什么情绪/氛围',
    options: [
      { id: 'D1', label: '冷峻', definition: '理性、克制、疏离', signals: ['冰冷', '理性', '克制', '疏离'] },
      { id: 'D2', label: '温暖', definition: '柔和、亲密、舒适', signals: ['温暖', '柔和', '亲密', '舒适'] },
      { id: 'D3', label: '超现实', definition: '诡异 + 荒诞，不合常理但自洽', signals: ['诡异', '荒诞', '错乱', '梦境'] },
      { id: 'D4', label: '宁静', definition: '平静、空灵、无扰', signals: ['宁静', '平静', '空灵', '寂静'] },
      { id: 'D5', label: '躁动', definition: '焦躁、不安、能量积聚', signals: ['躁动', '不安', '焦躁', '紧张'] },
      { id: 'D6', label: '孤寂', definition: '孤独、空旷、被遗弃', signals: ['孤独', '空旷', '废弃', '无人'] },
      { id: 'D7', label: '宏伟', definition: '壮阔、崇高、超越个体', signals: ['壮阔', '宏大', '无限', '震撼'] },
      { id: 'D8', label: '忧郁', definition: '内省、沉郁、淡淡的哀伤', signals: ['忧郁', '沉郁', '哀伤', '内省'] }
    ]
  },
  '差异点': {
    type: 'free_text',
    description: '这个流派与已有流派的区别——为什么这不是已有流派的变体',
    prompt_direction: '你命名的这个流派，和已有的什么流派最像？但它在哪一点上和那个不一样？'
  },
  '文化语境': {
    type: 'free_text',
    description: '这个流派回应什么文化现象/审美需求',
    prompt_direction: '这个流派是在回应什么？是某种文化现象、某种审美需求、还是某种时代情绪？'
  },
  '标志性元素': {
    type: 'free_text',
    description: '这个流派的视觉/听觉符号——看到/听到就知道是它',
    prompt_direction: '这个流派有什么"标志性的东西"？让人一看到/听到就知道"这是 XX 流派"？'
  },
  // ========== 设定世界观维度 ==========
  '世界类型': {
    type: 'single_choice',
    description: '世界的类型',
    options: [
      { id: 'A1', label: '物理法则型', definition: '世界的物理法则与现实不同（如重力可调、时间可逆）', signals: ['重力', '时间', '空间', '光', '能量'] },
      { id: 'A2', label: '社会制度型', definition: '社会的组织方式与现实不同（如阶级固化、记忆共享、集体意识）', signals: ['阶级', '制度', '集体', '共享', '统治'] },
      { id: 'A3', label: '魔法体系型', definition: '有明确的魔法/超自然体系（如元素魔法、血脉能力、符文系统）', signals: ['魔法', '符文', '血脉', '元素', '咒语'] },
      { id: 'A4', label: '科技未来型', definition: '科技发展到某种程度（如意识上传、星际殖民、AI 觉醒）', signals: ['AI', '意识', '星际', '赛博', '纳米'] },
      { id: 'A5', label: '抽象概念型', definition: '世界本身是某种抽象概念的具象化（如时间 marketplace、情绪银行）', signals: ['抽象', '概念', '具象化', '拟人'] },
      { id: 'A6', label: '历史架空型', definition: '现实历史的某个分叉点走向了不同结局（如"如果明朝没有灭亡"）', signals: ['如果', '假如', '没有', '历史', '朝代'] },
      { id: 'A7', label: '梦境型', definition: '世界的本质是梦/意识流/潜意识投影（如庄周梦蝶、盗梦空间）', signals: ['梦', '梦境', '意识', '潜意识', '醒来', '虚实'] },
      { id: 'A8', label: '多重维度型', definition: '存在多个平行世界/多重宇宙（如量子分岔、维度叠加）', signals: ['平行', '多重', '维度', '分岔', '另一个我'] }
    ]
  },
  '核心前提': {
    type: 'free_text',
    description: '这个世界与现实的根本差异是什么',
    prompt_direction: '如果一句话概括这个世界的"不同之处"，是什么？'
  },
  '世界法则': {
    type: 'free_text',
    description: '这个世界遵循什么法则？法则的边界或代价是什么？',
    prompt_direction: '这个世界能做什么？不能做什么？做这些事的代价是什么？（叙述性文本，自然融合法则与代价）'
  },
  '居民形态': {
    type: 'single_choice',
    description: '谁生活在这里',
    applicable_to_world_type_not: ['A5'],
    options: [
      { id: 'D1', label: '人类', definition: '与现实中的人类相同', signals: ['人类', '普通'] },
      { id: 'D2', label: '改造人类', definition: '有某种能力/特征变异', signals: ['改造', '变异', '能力'] },
      { id: 'D3', label: '非人类种族', definition: '精灵/机械/能量体等', signals: ['精灵', '机械', '能量'] },
      { id: 'D4', label: '多种族共存', definition: '多个种族并存', signals: ['多种族', '共存'] },
      { id: 'D5', label: '无居民', definition: '纯物理/纯抽象世界', signals: ['无居民', '纯物理', '纯抽象'] }
    ]
  },
  '内在张力': {
    type: 'single_choice',
    description: '在这个世界里，会有什么样的人过得最痛苦？或者什么样的处境最让人纠结？',
    applicable_to: ['有冲突信号或明显潜在张力'],
    options: [
      { id: 'E1', label: '用能力会付出代价的人', definition: '如用魔法失忆的法师【系统级】', signals: ['代价', '付出', '能力'] },
      { id: 'E2', label: '被规则排斥在外的群体', definition: '如无魔法者、买不起义体的穷人【社会级】', signals: ['排斥', '穷人', '无能力'] },
      { id: 'E3', label: '和世界格格不入的个体', definition: '如天生免疫规则的人【个体级】', signals: ['格格不入', '免疫', '异常'] },
      { id: 'E4', label: '这个世界本身就在崩塌', definition: '走向某种终局【系统级变体】', signals: ['崩塌', '终局', '毁灭'] },
      { id: 'E5', label: '我没想过这个', definition: '选做题，跳过', signals: ['没想过', '跳过'] }
    ]
  },
  '时间设定': {
    type: 'single_choice',
    description: '世界的时间锚点或时代感',
    applicable_to: ['有明确时间锚点或时代感'],
    options: [
      { id: 'G1', label: '古代', definition: '远古/封建时代', signals: ['古代', '远古', '封建'] },
      { id: 'G2', label: '近代', definition: '工业革命到二战前', signals: ['近代', '工业', '革命'] },
      { id: 'G3', label: '现代', definition: '二战后到 21 世纪初', signals: ['现代', '当代'] },
      { id: 'G4', label: '近未来', definition: '21 世纪中叶到末叶', signals: ['近未来', '中叶'] },
      { id: 'G5', label: '远未来', definition: '22 世纪及以后', signals: ['远未来', '星际'] },
      { id: 'G6', label: '无时间锚点', definition: '架空世界，无明确时代', signals: ['架空', '无时间'] }
    ]
  },
  // ========== 创作素材维度 ==========
  '媒介类型': {
    type: 'single_choice',
    description: '素材的媒介类型',
    options: [
      { id: 'A1', label: '2D 视觉', definition: '平面视觉创作——绘画/插画/平面设计/数字绘画', signals: ['画', '绘', '插画', '平面', '厚涂', '水彩'] },
      { id: 'A2', label: '3D 视觉', definition: '立体视觉创作——3D 建模/雕塑/材质/渲染', signals: ['3D', '建模', '材质', '渲染', '雕塑', 'PBR'] },
      { id: 'A3', label: '文字', definition: '文字创作——诗歌/散文/小说/剧本', signals: ['诗', '文', '小说', '剧本', '写作', '散文'] },
      { id: 'A4', label: '声音', definition: '声音创作——音乐/音效/环境音/人声', signals: ['音乐', '音效', '声音', '曲', '旋律', '采样'] },
      { id: 'A5', label: '影像', definition: '动态影像创作——视频/动画/电影/短片', signals: ['视频', '影像', '动画', '电影', '短片', '镜头'] },
      { id: 'A6', label: '混合媒介', definition: '多种媒介组合——跨媒介实验/多媒体装置', signals: ['混合', '跨媒介', '多媒体', '装置'] }
    ]
  },
  '主题意向': {
    type: 'free_text',
    description: '这个素材表达什么',
    prompt_direction: '如果一句话概括这个素材要表达的核心，是什么？'
  },
  '表现手法': {
    type: 'free_text',
    description: '这个素材用什么技法/手法来表现',
    applicable_to: ['有明确技法'],
    prompt_direction: '这个素材用什么技法/手法来表现？（如厚涂法/蒙太奇/复调）'
  },
  '风格参考': {
    type: 'free_text',
    description: '你参考的作品/艺术家有哪些？（只填名字，AI 会补全年代/流派/特点）',
    applicable_to: ['所有素材都适用，但深度可选'],
    prompt_direction: '你参考的作品/艺术家有哪些？（只填名字，AI 会补全年代/流派/特点）'
  },
  // ========== 研究好奇维度 ==========
  '问题类型': {
    type: 'single_choice',
    description: '这个好奇属于什么类型',
    options: [
      { id: 'A1', label: '事实型', definition: '问"是什么/什么时候/谁"——有客观答案的事实性问题', signals: ['是什么', '什么时候', '谁', '哪里'] },
      { id: 'A2', label: '原理型', definition: '问"为什么/怎么运作"——探究机制或原理', signals: ['为什么', '怎么', '原理', '机制', '如何运作'] },
      { id: 'A3', label: '比较型', definition: '问"A 和 B 有什么异同"——对比两个或多个事物', signals: ['对比', '异同', '区别', '比较', '差异'] },
      { id: 'A4', label: '评价型', definition: '问"好不好/值不值/应不应该"——涉及价值判断', signals: ['好不好', '值不值', '应该', '合理', '值得'] },
      { id: 'A5', label: '创造性', definition: '问"能不能/如果...会怎样"——探索可能性或假设情境', signals: ['能不能', '如果', '假设', '想象', '可能'] }
    ]
  },
  '核心问题': {
    type: 'free_text',
    description: '你最想搞清楚的那个问题，具体是什么？',
    prompt_direction: '你最想搞清楚的那个问题，具体是什么？'
  },
  '已知边界': {
    type: 'two_step',
    description: '你已经知道什么 + 你认为别人已经研究到哪了',
    sub_dimensions: [
      { id: 'C1', label: '个人已知', prompt_direction: '关于这个，你已经知道些什么？（哪怕是常识也算）' },
      { id: 'C2', label: '学界已知', prompt_direction: '你觉得这个问题，别人大概已经研究到什么程度了？（猜一下就行，不确定也没关系）' }
    ]
  },
  '未知方向': {
    type: 'free_text',
    description: '你可以往哪些方向追问？',
    prompt_direction: '除了核心问题，你还想往哪些方向继续问？'
  },
  '研究方法': {
    type: 'free_text',
    description: '用什么方法研究',
    applicable_to: ['实证型/文献型好奇'],
    prompt_direction: '用什么方法研究？（实证型问实验/观察/调研；思辨型问哲学方法；文献型问重点查哪些学派）'
  },
  '预期产出': {
    type: 'free_text',
    description: '如果研究清楚了，能回答你什么疑问？或者能用在什么地方？',
    applicable_to: ['能预判产出'],
    prompt_direction: '如果研究清楚了，能回答你什么疑问？或者能用在什么地方？'
  },
  // ========== 角色人物维度 ==========
  '基本背景': {
    type: 'two_step',
    description: '他从什么样的环境里来 + 他经历过什么',
    sub_dimensions: [
      { id: 'A1', label: '社会背景', prompt_direction: '他从什么样的环境里来？（社会阶层/时代背景/家庭出身）' },
      { id: 'A2', label: '个人经历', prompt_direction: '他经历过什么让他变成现在这样？' }
    ]
  },
  '性格特质': {
    type: 'free_text',
    description: '如果用几个词形容他的性格，会是什么？',
    prompt_direction: '如果用几个词形容他的性格，会是什么？'
  },
  '弱点缺陷': {
    type: 'free_text',
    description: '他最大的弱点或毛病是什么？',
    prompt_direction: '他最大的弱点或毛病是什么？（可以是性格缺陷/过往创伤/认知盲区）'
  },
  '动机欲望': {
    type: 'free_text',
    description: '他最想要什么？为了得到这个他能做到什么程度？',
    applicable_to: ['动机无法从弱点+性格+背景直接推断'],
    prompt_direction: '他最想要什么？为了得到这个他能做到什么程度？'
  },
  '关键关系': {
    type: 'free_text',
    description: '他生命中最重要的人是谁？',
    applicable_to: ['角色不是孤狼型'],
    prompt_direction: '他生命中最重要的人是谁？（可以是亲人/对手/挚友/宿敌）'
  },
  '标志性举止': {
    type: 'free_text',
    description: '他有什么口头禅或习惯性的小动作？',
    applicable_to: ['灵感文本提到口癖/习惯动作/小动作'],
    prompt_direction: '他有什么口头禅或习惯性的小动作？（比如柯南的"真相只有一个"、福尔摩斯的搓手）'
  },
  '视觉形象': {
    type: 'free_text',
    description: '如果用画面呈现他，第一眼看到的是什么？',
    applicable_to: ['角色有明确视觉设计'],
    prompt_direction: '如果用画面呈现他，第一眼看到的是什么？（外貌/穿着/气质）'
  },
  // ========== 概念维度（fix6 新增，替换原"概念命题"维度） ==========
  // fix6 设计：3 必填维度（概念类型/核心定义/区分点）+ 3 动态字段
  // 提问语言遵循"具体场景化"原则，避免"张力"等术语
  '概念类型': {
    type: 'single_choice',
    description: '这个概念属于哪一类',
    options: [
      { id: 'A1', label: '实体概念', definition: '指代某类事物/对象（如"细胞""城市"）', signals: ['事物', '对象', '实体'] },
      { id: 'A2', label: '属性概念', definition: '指代某种特征/属性（如"韧性""流动性"）', signals: ['特征', '属性', '性质'] },
      { id: 'A3', label: '关系概念', definition: '指代事物间的关联（如"共生""映射"）', signals: ['关系', '关联', '互动'] },
      { id: 'A4', label: '过程概念', definition: '指代某种动态过程（如"相变""衰减"）', signals: ['过程', '变化', '演变'] },
      { id: 'A5', label: '范式概念', definition: '指代某种思维方式/范式（如"还原论""整体论"）', signals: ['范式', '思维方式', '框架'] }
    ]
  },
  // '核心定义' 已在"美学提案"维度中定义（free_text），此处复用
  '区分点': {
    type: 'free_text',
    description: '和它最像的已有概念是什么？但在哪一点上不一样？',
    prompt_direction: '想想和这个概念最像的已有概念是什么？但它在哪一点上和那个不一样？（例：和"惯性"很像，但"惯性"是物理学概念，我这个用在人的行为习惯上）'
  },
  '概念起源': {
    type: 'free_text',
    description: '这个概念是怎么来的？',
    applicable_to: ['用户自创概念或借用概念'],
    prompt_direction: '这个概念是怎么来的？是你自创的，还是从某个领域借来的？如果是借来的，原来用在什么地方？'
  },
  '标志性特征': {
    type: 'free_text',
    description: '看到什么就知道是这个概念？',
    applicable_to: ['概念有明确视觉/行为符号'],
    prompt_direction: '看到一个东西时，看到什么特征你就知道"这就是我说的那个概念"？（可以是具体画面、行为、状态）'
  },
  '适用场景': {
    type: 'free_text',
    description: '什么时候会用到这个概念？',
    applicable_to: ['概念有明确应用领域'],
    prompt_direction: '什么时候你会用到这个概念？在什么场景下，这个概念能帮你解释/理解/判断什么？'
  }
};

// =========================================================================
// 类型维度配置（K4 新增）
// =========================================================================
// 每种类型的必选/可选/不适用维度配置
// 契约：crystallizeAgent._buildPrompt 从本表取必选维度，从 DIMENSION_POOL 取小维度定义
export const TYPE_DIMENSIONS = {
  '产品想法': {
    required: ['产品形态', '核心价值', '目标用户'],
    optional: ['视觉风格', '玩家动机', '使用场景', '情感曲线'],
    excluded: ['人物关系', '世界规则', '技术约束', '优先级', '成功标准']
  },
  '氛围画面': {
    required: ['场景类型', '感官主导', '情绪基调'],
    optional: ['主角存在', '动态属性', '视觉风格'],
    excluded: ['产品形态', '玩家动机', '使用场景', '技术约束', '成功标准', '世界规则', '人物关系']
  },
  '设定世界观': {
    required: ['世界类型', '核心前提', '世界法则'],
    optional: ['居民形态', '内在张力', '视觉风格', '时间设定'],
    excluded: ['产品形态', '玩家动机', '使用场景', '技术约束', '成功标准', '感官主导', '情绪基调']
  },
  '创作素材': {
    required: ['媒介类型', '主题意向'],
    optional: ['表现手法', '情感基调', '风格参考', '视觉风格', '感官主导', '场景类型'],
    excluded: ['产品形态', '玩家动机', '使用场景', '技术约束', '成功标准', '世界类型', '居民形态', '内在张力', '时间设定']
  },
  '研究好奇': {
    required: ['问题类型', '核心问题', '已知边界', '未知方向'],
    optional: ['研究方法', '预期产出', '时间设定'],
    excluded: ['产品形态', '玩家动机', '使用场景', '技术约束', '成功标准', '感官主导', '情绪基调', '场景类型', '世界类型', '居民形态', '视觉风格', '媒介类型']
  },
  '角色人物': {
    required: ['基本背景', '性格特质', '弱点缺陷'],
    optional: ['动机欲望', '关键关系', '标志性举止', '视觉形象', '时间设定'],
    excluded: ['产品形态', '玩家动机', '使用场景', '技术约束', '成功标准', '感官主导', '情绪基调', '场景类型', '世界类型', '居民形态', '问题类型', '已知边界', '媒介类型', '视觉风格']
  },
  '概念': {
    required: ['概念类型', '核心定义', '区分点'],
    optional: ['概念起源', '标志性特征', '适用场景'],
    excluded: ['产品形态', '玩家动机', '使用场景', '技术约束', '成功标准', '感官主导', '情绪基调', '场景类型', '世界类型', '居民形态', '问题类型', '已知边界', '媒介类型', '视觉风格', '角色原型', '标志性举止', '美学媒介', '美学属性', '情感内核', '差异点', '文化语境', '标志性元素']
  },
  '美学提案': {
    required: ['美学媒介', '核心定义', '美学属性', '情感内核', '差异点'],
    optional: ['文化语境', '标志性元素'],
    excluded: ['产品形态', '玩家动机', '使用场景', '技术约束', '成功标准', '世界类型', '居民形态', '内在张力', '问题类型', '已知边界', '媒介类型', '角色原型', '基本背景', '性格特质', '表现手法', '感官主导', '情绪基调', '场景类型', '视觉风格']
  },
  '其他': {
    required: [],
    optional: [],
    excluded: []
  }
};

// =========================================================================
// 设定胶囊字典（K4 新增，附录 A）
// =========================================================================
// 24 个网络美学/科幻体裁胶囊，每个胶囊含 7 元素
// 契约：capsuleDetector 从本表匹配关键词，crystallizeAgent 按 CAPSULE_TYPE_MAP 取用元素
export const AESTHETIC_CAPSULES = {
  cyberpunk: {
    key: 'cyberpunk',
    name: '赛博朋克',
    aliases: ['赛博朋克', 'cyberpunk'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '近未来反乌托邦',
      connotation: '高科技低生活、个体异化',
      imagery: ['霓虹灯牌', '雨夜街道', '义体', '全息广告', '巨企摩天楼'],
      atmosphere: '冷峻+躁动',
      premise: '企业寡头统治+义体化普及+网络空间平行存在',
      worldview_features: '技术中性但权力不公；义体/记忆可商品化',
      ultimate_theme: '人的定义 vs 技术的边界'
    }
  },
  post_cyberpunk: {
    key: 'post_cyberpunk',
    name: '后赛博朋克',
    aliases: ['后赛博朋克', 'post-cyberpunk', 'postcyberpunk'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '赛博朋克的演化与反思',
      connotation: '技术乐观主义、社会责任、企业改良',
      imagery: ['绿色科技', '可持续城市', '人机协作', '开源社区'],
      atmosphere: '希望+批判',
      premise: '赛博朋克之后的反思——技术可以不只服务于巨企',
      worldview_features: '技术乐观但警惕；企业可被改良；个人有选择权',
      ultimate_theme: '技术与人的共生可能'
    }
  },
  steampunk: {
    key: 'steampunk',
    name: '蒸汽朋克',
    aliases: ['蒸汽朋克', 'steampunk'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '维多利亚+蒸汽动力',
      connotation: '工匠机械、冒险精神、工业浪漫',
      imagery: ['黄铜齿轮', '蒸汽机', '飞艇', '维多利亚服饰', '伦敦雾'],
      atmosphere: '冒险+温暖',
      premise: '蒸汽动力主导的世界，电力未普及',
      worldview_features: '机械可手工修复；工匠地位高；冒险精神盛行',
      ultimate_theme: '机械美学 vs 人文温度'
    }
  },
  dieselpunk: {
    key: 'dieselpunk',
    name: '柴油朋克',
    aliases: ['柴油朋克', 'dieselpunk'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '两次世界大战+柴油动力',
      connotation: '战争机器、极权主义、黑色电影',
      imagery: ['坦克', '战斗机', '军装', '宣传海报', '工业区'],
      atmosphere: '冷硬+压抑',
      premise: '柴油动力主导的世界，处于战争或极权统治',
      worldview_features: '战争常态化；极权统治；个人被机器碾压',
      ultimate_theme: '战争机器中的人'
    }
  },
  atompunk: {
    key: 'atompunk',
    name: '原子朋克',
    aliases: ['原子朋克', 'atompunk'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '冷战+原子能',
      connotation: '太空竞赛、核恐惧、未来主义',
      imagery: ['火箭', '原子符号', '太空舱', '冷战宣传', '郊区住宅'],
      atmosphere: '乐观+焦虑',
      premise: '原子能主导的世界，太空竞赛白热化',
      worldview_features: '原子能无所不能；太空竞赛；核恐惧阴影',
      ultimate_theme: '原子能的希望与恐惧'
    }
  },
  cassette_futurism: {
    key: 'cassette_futurism',
    name: '磁带未来主义',
    aliases: ['磁带未来主义', 'cassette futurism', '磁带朋克'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '70-80 年代未来想象',
      connotation: '模拟技术、复古未来、冷战科技',
      imagery: ['磁带', 'CRT 屏幕', '模拟仪表盘', '复古电脑', '太空时代设计'],
      atmosphere: '怀旧+未来',
      premise: '以 70-80 年代的技术想象未来',
      worldview_features: '模拟技术主导；复古未来美学；冷战科技竞赛',
      ultimate_theme: '过去眼中的未来'
    }
  },
  biopunk: {
    key: 'biopunk',
    name: '生物朋克',
    aliases: ['生物朋克', 'biopunk'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '基因工程+生物改造',
      connotation: '身体改造、基因优化、生物伦理',
      imagery: ['基因编辑', '生物机械', '培养皿', '变异生物', '实验室'],
      atmosphere: '冷峻+伦理困境',
      premise: '基因工程主导的世界，身体可改造',
      worldview_features: '基因可编辑；身体可优化；生物伦理争议',
      ultimate_theme: '人的定义 vs 基因的可塑性'
    }
  },
  nanopunk: {
    key: 'nanopunk',
    name: '纳米朋克',
    aliases: ['纳米朋克', 'nanopunk'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '纳米技术+微观世界',
      connotation: '纳米机器人、微观操控、技术奇点',
      imagery: ['纳米机器人', '显微镜', '分子结构', '微观城市', '技术奇点'],
      atmosphere: '精密+失控',
      premise: '纳米技术主导的世界，微观可操控',
      worldview_features: '纳米机器人普及；微观可编程；技术奇点临近',
      ultimate_theme: '微观控制 vs 宏观失控'
    }
  },
  solarpunk: {
    key: 'solarpunk',
    name: '太阳朋克',
    aliases: ['太阳朋克', 'solarpunk'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '可持续+绿色生态',
      connotation: '环境友好、社区互助、技术乐观',
      imagery: ['太阳能板', '垂直农场', '绿色建筑', '社区花园', '可再生能源'],
      atmosphere: '希望+温暖',
      premise: '可持续技术主导的世界，生态与技术和谐',
      worldview_features: '可再生能源主导；社区互助；技术服务生态',
      ultimate_theme: '技术与生态的共生'
    }
  },
  clockpunk: {
    key: 'clockpunk',
    name: '钟表朋克',
    aliases: ['钟表朋克', 'clockpunk'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '文艺复兴+钟表机械',
      connotation: '精密机械、工匠美学、前工业革命',
      imagery: ['钟表', '齿轮', '发条', '达芬奇手稿', '精密仪器'],
      atmosphere: '精密+复古',
      premise: '钟表机械主导的世界，精密工艺巅峰',
      worldview_features: '钟表机械精密；工匠美学；前工业革命',
      ultimate_theme: '精密机械的美学'
    }
  },
  post_apocalyptic: {
    key: 'post_apocalyptic',
    name: '后启示录',
    aliases: ['后启示录', 'post-apocalyptic', 'post apocalyptic'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '文明终结+幸存者',
      connotation: '生存挣扎、道德灰色、重建或遗忘',
      imagery: ['废墟城市', '幸存者营地', '辐射尘埃', '拾荒者', '变异生物'],
      atmosphere: '苍凉+荒芜',
      premise: '文明经历毁灭性灾变后的世界',
      worldview_features: '资源匮乏；旧文明遗迹；小团体生存；道德重塑',
      ultimate_theme: '文明与人性的关系'
    }
  },
  backrooms: {
    key: 'backrooms',
    name: '后室',
    aliases: ['后室', 'backrooms'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '无限空旷空间+诡异实体',
      connotation: '阈限恐惧、存在主义、探索与迷失',
      imagery: ['黄色走廊', '荧光灯', '空房间', '诡异实体', '无尽楼梯'],
      atmosphere: '孤寂+超现实',
      premise: '无限延伸的空旷空间，存在诡异实体',
      worldview_features: '空间无限；实体出没；规则不明；迷失常态',
      ultimate_theme: '存在主义的恐惧'
    }
  },
  scp: {
    key: 'scp',
    name: 'SCP',
    aliases: ['scp', 'scp foundation', 'scp 基金会'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '异常收容+秘密组织',
      connotation: '控制与收容、科学与未知、伦理边界',
      imagery: ['收容设施', '异常实体', '研究员', '实验记录', '秘密档案'],
      atmosphere: '冷峻+压抑',
      premise: '秘密组织收容异常实体，保护人类',
      worldview_features: '异常存在；收容优先；科学探索；伦理灰色',
      ultimate_theme: '控制与未知的边界'
    }
  },
  rule_horror: {
    key: 'rule_horror',
    name: '规则怪谈',
    aliases: ['规则怪谈', 'rule horror'],
    pack_type: 'worldview_aesthetic',
    elements: {
      attribute: '规则+诡异',
      connotation: '规则的不可违反性、日常中的异常',
      imagery: ['规则列表', '日常场景', '诡异细节', '违反规则的后果'],
      atmosphere: '日常+不安',
      premise: '看似正常的场景，但必须遵守诡异规则',
      worldview_features: '规则诡异；违反有后果；日常与异常并存',
      ultimate_theme: '日常中的异常'
    }
  },
  liminal_space: {
    key: 'liminal_space',
    name: '阈限空间',
    aliases: ['阈限空间', 'liminal space'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '过渡空间+空置化',
      connotation: '既熟悉又陌生、时间的凝固感',
      imagery: ['空走廊', '停车场', '学校教室', '商场', '医院走廊'],
      atmosphere: '孤寂+超现实',
      premise: '过渡性空间的空置化',
      worldview_features: '空间过渡性；人迹罕至；时间凝固',
      ultimate_theme: '过渡空间的存在感'
    }
  },
  dreamcore: {
    key: 'dreamcore',
    name: '梦核',
    aliases: ['梦核', 'dreamcore'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '千禧年怀旧+梦境',
      connotation: '童年回忆、梦境美学、低保真',
      imagery: ['老式电脑', '像素艺术', '千禧年设计', '梦境场景', '低保真'],
      atmosphere: '温暖+超现实',
      premise: '千禧年怀旧的梦境美学',
      worldview_features: '怀旧元素；梦境逻辑；低保真美学',
      ultimate_theme: '童年与梦境的交织'
    }
  },
  weirdcore: {
    key: 'weirdcore',
    name: '怪核',
    aliases: ['怪核', 'weirdcore'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '怪异+不合常理',
      connotation: '荒诞、错乱、无法归类',
      imagery: ['不合常理的组合', '错乱的场景', '怪异的物体', '无法解释的现象'],
      atmosphere: '荒诞+不安',
      premise: '无法归类的怪异美学',
      worldview_features: '不合常理；无法解释；错乱感',
      ultimate_theme: '荒诞的存在'
    }
  },
  poolcore: {
    key: 'poolcore',
    name: '池核',
    aliases: ['池核', 'poolcore'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '蓝色水域+宁静',
      connotation: '水的平静、蓝色的治愈、沉浸感',
      imagery: ['蓝色水面', '瓷砖', '水下光线', '波纹', '静谧泳池'],
      atmosphere: '宁静+沉浸',
      premise: '蓝色水域的宁静美学',
      worldview_features: '蓝色主导；水的平静；沉浸感',
      ultimate_theme: '水的治愈'
    }
  },
  concretecore: {
    key: 'concretecore',
    name: '砼核',
    aliases: ['砼核', 'concretecore', '混凝土核'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '混凝土+巨构',
      connotation: '冷峻、宏伟、压抑',
      imagery: ['混凝土建筑', '巨构', '冷灰色调', '几何形态', '粗野主义'],
      atmosphere: '冷峻+孤寂+宏伟',
      premise: '混凝土巨构的美学',
      worldview_features: '混凝土主导；巨构建筑；冷灰色调',
      ultimate_theme: '混凝土的冷峻与宏伟'
    }
  },
  chinese_dreamcore: {
    key: 'chinese_dreamcore',
    name: '中式梦核',
    aliases: ['中式梦核', 'chinese dreamcore'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '中国元素+梦境',
      connotation: '中式怀旧、文化符号、梦境美学',
      imagery: ['中式建筑', '传统元素', '怀旧物品', '梦境场景'],
      atmosphere: '怀旧+梦境',
      premise: '中国元素的梦境美学',
      worldview_features: '中式元素；怀旧氛围；梦境逻辑',
      ultimate_theme: '中式怀旧与梦境'
    }
  },
  vaporwave: {
    key: 'vaporwave',
    name: '蒸汽波',
    aliases: ['蒸汽波', 'vaporwave'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '80-90 年代怀旧+数字美学',
      connotation: '消费主义批判、复古未来、数字怀旧',
      imagery: ['霓虹', '老式电脑', '古典雕塑', '日文文字', '格子背景'],
      atmosphere: '怀旧+讽刺',
      premise: '80-90 年代的数字怀旧美学',
      worldview_features: '复古未来；消费主义符号；数字怀旧',
      ultimate_theme: '消费主义的怀旧与批判'
    }
  },
  y2k: {
    key: 'y2k',
    name: 'Y2K',
    aliases: ['y2k', 'Y2K', '千禧年'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '千禧年+数字乐观',
      connotation: '数字时代的乐观、科技美学、未来感',
      imagery: ['金属质感', '数字界面', '未来字体', '科技产品', '霓虹'],
      atmosphere: '乐观+未来',
      premise: '千禧年的数字乐观美学',
      worldview_features: '数字乐观；科技美学；未来感',
      ultimate_theme: '数字时代的乐观'
    }
  },
  frutiger_aero: {
    key: 'frutiger_aero',
    name: 'Frutiger Aero',
    aliases: ['frutiger aero', 'Frutiger Aero'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '2000 年代设计+清新',
      connotation: '清新、自然、科技感',
      imagery: ['绿色植物', '水滴', '清新界面', '自然元素', '科技感'],
      atmosphere: '清新+自然',
      premise: '2000 年代的清新设计美学',
      worldview_features: '清新设计；自然元素；科技感',
      ultimate_theme: '清新与科技的融合'
    }
  },
  analog_horror: {
    key: 'analog_horror',
    name: '模拟恐怖',
    aliases: ['模拟恐怖', 'analog horror'],
    pack_type: 'pure_aesthetic',
    elements: {
      attribute: '模拟信号+恐怖',
      connotation: '老式媒体的恐怖、信号的异常',
      imagery: ['老式电视', '雪花屏', '录像带', '模拟信号', '异常画面'],
      atmosphere: '不安+怀旧',
      premise: '模拟信号的恐怖美学',
      worldview_features: '模拟信号；异常画面；老式媒体',
      ultimate_theme: '模拟信号的恐怖'
    }
  }
};

// =========================================================================
// 胶囊类型取用映射（K4 新增）
// =========================================================================
// 每种 inspiration_type 取用胶囊的哪些元素
// 契约：capsuleDetector 按本表决定返回哪些 applicable_elements
export const CAPSULE_TYPE_MAP = {
  '氛围画面': ['attribute', 'connotation', 'imagery', 'atmosphere'],
  '设定世界观': ['attribute', 'connotation', 'premise', 'worldview_features', 'ultimate_theme'],
  '创作素材': ['attribute', 'imagery', 'atmosphere'],
  '概念': [],  // fix6：概念不使用设定胶囊
  '角色人物': ['attribute', 'connotation', 'imagery'],
  '产品想法': ['attribute', 'imagery', 'atmosphere'],
  '研究好奇': [],
  '美学提案': [],  // K4-a 新增：美学提案不使用胶囊（本身在创建胶囊）
  '其他': []
};

// =========================================================================
// fix6：删除 CONCEPT_ORIENTATIONS 与 CONCEPT_ORIENTATION_SIGNALS
// 原因：概念类型不再绑定"命题/论证"，concept_orientation 字段已废弃
// 历史数据中的 concept_orientation 字段保留但不再使用（向后兼容）
// =========================================================================

// =========================================================================
// 选做补充题文案（K4 新增，附录 B）
// =========================================================================
// 所有类型的 questioning 末尾追加的补充题文案
export const SUPPLEMENT_QUESTION_TEXT = {
  '产品想法': '你对你的这个产品还有什么想补充的吗？（选做，可不答）',
  '氛围画面': '你对你的这个画面还有什么想补充的吗？（选做，可不答）',
  '设定世界观': '你对你的这个世界观还有什么想补充的吗？（选做，可不答）',
  '创作素材': '你对你的这个素材还有什么想补充的吗？（选做，可不答）',
  '研究好奇': '你对你的这个问题还有什么想补充的吗？（选做，可不答）',
  '角色人物': '你对你的这个角色还有什么想补充的吗？（选做，可不答）',
  '概念': '你对你的这个概念还有什么想补充的吗？（选做，可不答）',  // fix6
  '美学提案': '你对你的这个美学流派还有什么想补充的吗？（选做，可不答）',  // K4-a 新增
  '其他': '你还有什么想补充的吗？（选做，可不答）'
};

// =========================================================================
// 类型字段配置（K4 新增，从 crystallizeAgent.js 迁移）
// =========================================================================
// 每种类型的 crystal 字段配置
// baseFields：必有字段
// dynamicFields：按 selected_dimensions 附加的字段
// metaFields：LLM 主动推断的元字段
// aiInferredFields：LLM 主动推断的 AI 字段
export const TYPE_BRANCHES = {
  '产品想法': {
    crystalType: 'prd',
    baseFields: ['title', 'goal', 'target_user', 'core_features'],
    dynamicFields: [],
    metaFields: [],
    aiInferredFields: []
  },
  '氛围画面': {
    crystalType: 'scene_card',
    baseFields: ['title', 'setting', 'sensory_detail', 'mood'],
    dynamicFields: ['protagonist', 'moment'],
    metaFields: [],
    aiInferredFields: []
  },
  '设定世界观': {
    crystalType: 'worldview',
    baseFields: ['title', 'premise', 'rules'],
    dynamicFields: ['inhabitants', 'tension'],
    metaFields: [],
    aiInferredFields: []
  },
  '创作素材': {
    crystalType: 'creative_direction',
    baseFields: ['title', 'medium', 'theme', 'style_refs'],
    dynamicFields: ['mood', 'technique'],
    metaFields: ['composable_with'],
    aiInferredFields: []
  },
  '研究好奇': {
    crystalType: 'exploration_map',
    baseFields: ['title', 'core_question', 'known_boundary', 'unknown_direction'],
    dynamicFields: ['method', 'expected_output'],
    metaFields: ['follow_up_questions'],
    aiInferredFields: []
  },
  '角色人物': {
    crystalType: 'character_profile',
    baseFields: ['title', 'archetype', 'background', 'personality', 'flaw'],
    dynamicFields: ['motivation', 'relationships', 'mannerisms'],
    metaFields: [],
    aiInferredFields: ['archetype']
  },
  '概念': {
    crystalType: 'concept_card',
    // fix6：3 必填字段（title/definition/distinction）+ 3 动态字段（origin/signature_features/applicable_context）
    // evolution 是 metaField（LLM 推断：可演化为命题/产品/美学/方法论）
    baseFields: ['title', 'definition', 'distinction'],
    dynamicFields: ['origin', 'signature_features', 'applicable_context'],
    metaFields: ['evolution'],  // LLM 主动推断：{ directions: ['proposition', 'product', 'aesthetic', 'methodology'] }
    aiInferredFields: []
  },
  '美学提案': {
    crystalType: 'aesthetic_proposal',
    baseFields: ['title', 'core_definition', 'aesthetic_attributes', 'emotional_core', 'differentiation'],
    dynamicFields: ['cultural_context', 'signature_elements'],
    metaFields: ['extensions'],  // LLM 主动推断：{ variations: [], combinations: [] }
    aiInferredFields: []
  },
  '其他': {
    crystalType: 'free_note',
    baseFields: ['title', 'content', 'tags'],
    dynamicFields: [],
    metaFields: [],
    aiInferredFields: []
  }
};

// =========================================================================
// 统一导出（便于一次性导入）
// =========================================================================
export const CONSTANTS = {
  THRESHOLDS,
  BRIDGE_TYPES,
  BRIDGE_TYPE_KEY_MAP,
  BRIDGE_TYPE_VALUES,
  BRIDGE_STATUS,
  INSPIRATION_TYPES,
  TYPE_TO_CRYSTAL,
  FRAGMENT_TEMPLATES,
  FRAGMENT_TYPE_VALUES,
  FRAGMENT_META,
  CHUNK_KINDS,
  MULTILINGUAL_EMBEDDING_MODEL,
  EMBEDDING_DIMENSION,
  EMBEDDING_BATCH_SIZE,
  FINGERPRINT_MIN_LENGTH,
  FINGERPRINT_MAX_LENGTH,
  FINGERPRINT_INPUT_LIMITS,
  LLM_LIMITS,
  FORCE_GRAPH_LIMITS,
  TASK_QUEUE_LIMITS,
  // 历史保留
  DEFAULT_SIMILARITY_THRESHOLD,
  SEMANTIC_LINK_THRESHOLD,
  DUPLICATE_CHECK_DAYS,
  MAX_RELATED_INSPIRATIONS,
  BATCH_SIZE,
  BATCH_DELAY_MS,
  AUTO_TAG_MIN_CLUSTER_SIZE,
  AUTO_TAG_MAX_CLUSTERS,
  AUTO_TAG_MAX_ITERATIONS,
  AUTO_TAG_SIMILARITY_THRESHOLD,
  DEFAULT_PAGE_LIMIT,

  // K4 新增
  DIMENSION_POOL,
  TYPE_DIMENSIONS,
  AESTHETIC_CAPSULES,
  CAPSULE_TYPE_MAP,
  // fix6：删除 CONCEPT_ORIENTATIONS / CONCEPT_ORIENTATION_SIGNALS（概念类型不再使用）
  SUPPLEMENT_QUESTION_TEXT,
  TYPE_BRANCHES
};
