// CrystallizeAgent — 灵感结晶 Agent（M3-b 改造版）
// 功能：感知灵感类型 → 定制化追问（支持多选）→ 生成对应类型结晶体
// 实现方式：继承 BaseAgent，按 stage 构建不同 prompt，8 类型分支定制化追问与结晶
//
// 状态机：idle → sensing → sense_confirm → questioning → crystal_preview → done
//   - sensing：自动调用 LLM 感知类型，返回 type/confidence/alternative_types/reasoning
//   - sense_confirm：confidence < 0.85 时让用户确认/修正类型；≥ 0.85 时前端自动跳过
//   - questioning：按类型生成定制化问题，支持 multi/max_select 字段（多选）
//   - crystal_preview：按 crystal_type 生成对应字段结构的结晶体
//
// M3-b 关键变更：
//   - 新增 senseStage：感知灵感类型（8 种枚举 + "其他"兜底）
//   - 新增 INSPIRATION_TYPES / TYPE_BRANCHES 常量，按类型定制追问与结晶字段
//   - 新增 multi / max_select 字段支持多选题
//   - prd 字段 → crystal 字段（按类型生成不同形态）
//   - 旧数据兼容：crystal_type='prd' 时仍按 PRD 字段处理

import BaseAgent from './baseAgent.js';
import { AGENT_TYPES } from '../services/openai.js';
import inspirationStorage from '../services/inspirationStorage.js';
import { db, saveDb } from '../database/db.js';
import { v4 as uuidv4 } from 'uuid';
// K4 改造：从 constants.js 引入维度池/类型维度/类型分支/补充题
// fix6：删除 CONCEPT_ORIENTATIONS（概念类型不再使用）
import {
  TYPE_BRANCHES,
  TYPE_DIMENSIONS,
  DIMENSION_POOL,
  SUPPLEMENT_QUESTION_TEXT
} from '../config/constants.js';
// K4 新增：设定胶囊识别服务
import { CapsuleDetector } from '../services/capsuleDetector.js';

// ========== 灵感类型系统 ==========
// 7 种预设枚举 + "美学提案" + "其他"兜底
// 每种类型对应一种结晶形态（crystal_type）和定制化追问维度
// K4 改造：删除"方法流程"类型（与 constants.js 保持一致，v4 迁移后历史数据归入"其他"）
// K4-a 改造：新增"美学提案"类型（命名并定义一种新的美学流派/风格范畴）
export const INSPIRATION_TYPES = {
  PRODUCT:    '产品想法',     // 结晶：PRD
  ATMOSPHERE: '氛围画面',     // 结晶：场景卡
  WORLDVIEW:  '设定世界观',   // 结晶：世界观笔记
  CREATIVE:   '创作素材',     // 结晶：创作方向卡
  RESEARCH:   '研究好奇',     // 结晶：探索地图
  CHARACTER:  '角色人物',     // 结晶：角色档案
  CONCEPT:    '概念',           // 结晶：概念卡（fix6：原"概念命题"→"概念"）
  AESTHETIC:  '美学提案',     // 结晶：美学提案卡（K4-a 新增）
  OTHER:      '其他'          // 兜底，结晶：自由笔记
};

// 类型 → 结晶形态映射
// K4 改造：删除"方法流程"映射（v4 迁移后历史数据 crystal_type='free_note'）
// K4-a 改造：新增"美学提案"映射
export const TYPE_TO_CRYSTAL = {
  '产品想法':   'prd',
  '氛围画面':   'scene_card',
  '设定世界观': 'worldview',
  '创作素材':   'creative_direction',
  '研究好奇':   'exploration_map',
  '角色人物':   'character_profile',
  '概念命题': 'argument_card',  // fix6 历史数据兼容（旧数据读取时仍能识别）
  '概念': 'concept_card',  // fix6 新增
  '美学提案': 'aesthetic_proposal',  // K4-a 新增
  '其他':       'free_note'
};

// ========== 类型分支配置 ==========
// K4 改造：TYPE_BRANCHES 已迁移至 constants.js，由 import 引入
// 每种类型含 baseFields/dynamicFields/metaFields/aiInferredFields（详见 constants.js）

class CrystallizeAgent extends BaseAgent {
  constructor() {
    super('CrystallizeAgent', '感知类型 → 定制化追问 → 生成结晶体');
    this.type = AGENT_TYPES.CRYSTALLIZE;
    // 系统提示词：定义灵感结晶师的人设与原则
    this.systemPrompt = `你是 AIRA 的灵感结晶师，兼具产品伙伴与苏格拉底式追问者的双重身份。
你的任务是通过对话式追问，帮助用户把模糊的灵感引导为清晰的结构化结晶体。

## 核心原则
1. **追问是必经流程**：无论灵感看起来多清晰，都必须先追问，不跳过
2. **一次只问 3-5 个问题**：避免用户疲劳
3. **问题必须具体**：不问"你有什么需求"这种废话，问直指核心的问题
4. **给出具象选项**：每题给 4-5 个**具体且带创意感**的选项，不要抽象分类
5. **允许"其他"**：前端会自动追加"其他：请补充"选项，你只需给出 4-5 个预设选项
6. **支持多选**：对于"涉及哪些感官""包含哪些元素"这类问题，设置 multi:true
7. **由轻到重**：先问形态/用户/价值，后问约束/风险

## 响应必须是 JSON，且严格遵守对应 stage 的输出格式`;
  }

  // 感知灵感类型（Sense 阶段，K4 改造版）
  // 功能：分析灵感文本，返回最可能的类型 + 置信度 + 备选类型 + 推理 + 设定胶囊 + 概念指向
  // 实现方式：构建 sense prompt → 调用 LLM → 解析 JSON → 调用 CapsuleDetector 识别胶囊 → 校验 concept_orientation
  // 输出：{ type, confidence, alternative_types, reasoning, signals, concept_orientation, detected_capsules }
  async sense(inspirationId, text) {
    try {
      if (!text) {
        return { success: false, error: 'No text to sense' };
      }
      const prompt = this._buildSensePrompt(text);
      const result = await this.generate(prompt, this.systemPrompt);
      const content = this._extractContent(result);
      const parsed = this._parseJSON(content);

      // 校验返回的类型是否在枚举内，不在则兜底为"其他"
      const validTypes = Object.values(INSPIRATION_TYPES);
      if (!validTypes.includes(parsed.type)) {
        parsed.type = INSPIRATION_TYPES.OTHER;
        parsed.confidence = 0.5;
      }
      // 确保 confidence 是 0-1 的数字
      if (typeof parsed.confidence !== 'number') {
        parsed.confidence = 0.7;
      }
      parsed.confidence = Math.max(0, Math.min(1, parsed.confidence));
      // 确保 alternative_types 是数组
      if (!Array.isArray(parsed.alternative_types)) {
        parsed.alternative_types = [];
      }

      // 计算对应的 crystal_type
      parsed.crystal_type = TYPE_TO_CRYSTAL[parsed.type] || 'free_note';

      // K4 新增：识别设定胶囊（仅显式关键词匹配，不主动推断）
      try {
        const capsuleResult = CapsuleDetector.detectCapsules(text, parsed.type);
        parsed.detected_capsules = capsuleResult.capsules;
      } catch (capsuleErr) {
        console.warn('[CrystallizeAgent] Capsule detection failed:', capsuleErr.message);
        parsed.detected_capsules = [];
      }

      // fix6：删除 concept_orientation 校验逻辑
      // 原因：概念类型不再绑定"命题/论证"，concept_orientation 字段已废弃
      // 历史数据中的 concept_orientation 字段保留但不再使用（向后兼容）
      // 强制置 null，避免前端误用
      parsed.concept_orientation = null;

      return { success: true, data: parsed };
    } catch (e) {
      this.log(`sense failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // 运行结晶流程（questioning / crystal 阶段，K4 改造版）
  // 功能：按 stage 调用 LLM，保存结果，可选自动分流到下一 Agent（Epitaxy）
  // 实现方式：解构 context → 获取目标内容 → 构建 prompt → 调用 LLM → 解析 JSON → 合并胶囊预填 → 持久化 → 可选分流
  // K4 改造：
  //   - context 新增 detectedCapsules / capsuleDecision 字段
  //   - _buildPrompt 调用透传 capsuleDecision / detectedCapsules
  //   - crystal 生成后合并胶囊预填元素（用户回答优先于胶囊预填）
  async run(context) {
    try {
      const {
        inspirationId,
        stage = 'initial',
        userInput,
        crystalDraft = {},
        prdDraft = {},  // 向后兼容旧调用
        conversationHistory = [],
        autoRun = true,
        inspirationType = INSPIRATION_TYPES.PRODUCT,  // 默认产品想法，兼容旧流程
        detectedCapsules = [],     // K4 新增：sense 阶段识别的胶囊
        capsuleDecision = null     // K4 新增：'use' / 'ignore' / null
      } = context;

      // 兼容旧字段名：prdDraft → crystalDraft
      const draft = Object.keys(crystalDraft).length > 0 ? crystalDraft : prdDraft;

      // 获取目标内容
      let target = userInput;
      if (!target && inspirationId) {
        const inspiration = await this.getInspiration(inspirationId);
        target = inspiration?.content || inspiration?.title;
      }
      if (!target) {
        return { success: false, error: 'No target content to crystallize' };
      }

      // 获取类型分支配置（兜底为"其他"）
      const branch = TYPE_BRANCHES[inspirationType] || TYPE_BRANCHES[INSPIRATION_TYPES.OTHER];
      const crystalType = branch.crystalType;

      // 按 stage 构建 prompt（K4：透传 capsuleDecision / detectedCapsules）
      const prompt = this._buildPrompt(target, stage, draft, conversationHistory, inspirationType, branch, capsuleDecision, detectedCapsules);

      // 调用 LLM 生成
      const result = await this.generate(prompt, this.systemPrompt);
      const content = this._extractContent(result);
      const parsed = this._parseJSON(content);

      // 兼容字段：LLM 可能返回 prd 或 crystal，统一为 crystal
      if (parsed.prd && !parsed.crystal) {
        parsed.crystal = parsed.prd;
      }

      // K4 新增：crystal 生成后，合并胶囊预填 + 用户回答
      // 仅当用户决定使用胶囊且 LLM 生成了 crystal 时执行
      if (parsed.crystal && detectedCapsules.length > 0 && capsuleDecision === 'use') {
        const capsule = detectedCapsules[0];  // 初版只支持单胶囊
        // 初版简化：把胶囊的 elements 直接合并到 crystal（用户回答优先于胶囊预填）
        // 后续可按 CAPSULE_TYPE_MAP 和 DIMENSION_POOL 映射关系精细化字段
        const capsulePreset = {};
        if (capsule.elements && typeof capsule.elements === 'object') {
          // 把胶囊的 elements 字段浅拷贝到 capsulePreset
          for (const [elemKey, elemValue] of Object.entries(capsule.elements)) {
            capsulePreset[`capsule_${elemKey}`] = elemValue;
          }
        }
        parsed.crystal = {
          ...capsulePreset,
          ...parsed.crystal  // 用户回答优先
        };
        // 记录 detected_capsule 到 crystal（用 key 数组表示）
        parsed.crystal.detected_capsule = detectedCapsules.map(c => c.key);
      }

      // 保存到 per-inspiration/crystallize/ 文件存储
      let saved = null;
      try {
        const dataToSave = {
          ...parsed,
          inspiration_type: inspirationType,
          crystal_type: crystalType
        };
        saved = await inspirationStorage.saveCrystallizeResult(inspirationId, dataToSave);
        this.log(`Saved crystallize result for ${inspirationId}`);
      } catch (saveErr) {
        console.warn('[CrystallizeAgent] Failed to save crystallize result to storage:', saveErr.message);
      }

      // 写入 crystallize_results 表（含 inspiration_type/crystal_type）
      try {
        const recordId = uuidv4();
        const autoRunFlag = autoRun && parsed.crystal && parsed.next_agent ? 1 : 0;
        db.run(
          'INSERT INTO crystallize_results (id, inspiration_id, inspiration_type, crystal_type, auto_run, saved_at) VALUES (?, ?, ?, ?, ?, ?)',
          [recordId, inspirationId, inspirationType, crystalType, autoRunFlag, new Date().toISOString()]
        );
        saveDb();
      } catch (dbErr) {
        console.warn('[CrystallizeAgent] Failed to write crystallize_results table:', dbErr.message);
      }

      // 更新 inspirations 表的 inspiration_type / crystal_type 字段
      try {
        db.run(
          'UPDATE inspirations SET inspiration_type = ?, crystal_type = ? WHERE id = ?',
          [inspirationType, crystalType, inspirationId]
        );
        saveDb();
      } catch (dbErr) {
        console.warn('[CrystallizeAgent] Failed to update inspirations table:', dbErr.message);
      }

      // 自动分流：仅当 autoRun 且生成了 crystal 且指定了 next_agent 时触发
      // M3-c 实现后此处将真正触发 Epitaxy 流程
      let dispatchResult = null;
      if (autoRun && parsed.crystal && parsed.next_agent) {
        try {
          const { default: agentHub } = await import('./agentHub.js');
          dispatchResult = await agentHub.dispatch(parsed.next_agent, {
            inspirationId,
            crystal: parsed.crystal,
            inspirationType,
            crystalType
          });
          this.log(`Auto-dispatched to ${parsed.next_agent}`);
        } catch (dispatchErr) {
          console.warn('[CrystallizeAgent] Auto dispatch failed:', dispatchErr.message);
          dispatchResult = { success: false, error: dispatchErr.message };
        }
      }

      return {
        success: true,
        data: {
          ...parsed,
          inspiration_type: inspirationType,
          crystal_type: crystalType,
          saved,
          dispatch: dispatchResult
        }
      };
    } catch (e) {
      this.log(`run failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // 构建 Sense 阶段 prompt（K4 改造版）
  // 功能：让 LLM 分析灵感文本，判断属于 9 种类型中的哪一种
  // 实现方式：列出 9 种类型定义 + 5 信号判断规则 + 概念指向 + 美学命名信号 + 返回 JSON 格式
  // K4 新增：5 信号区分概念 vs 产品想法
  // K4-a 新增：第 8 项"美学提案"+ 信号 6 美学命名信号
  // fix6 改造：删除"概念命题"中的"命题/论证"语义，改为纯"概念"——命名 + 定义 + 区分
  _buildSensePrompt(text) {
    return `分析以下灵感，判断它属于哪一种类型。如果判断为"概念"或"产品想法"，需额外按 5 信号区分。如果出现"命名/定义一种新流派/新美学"信号，优先判定为"美学提案"。

灵感内容：
${text}

## 9 种灵感类型定义
1. **产品想法**：明确想做一个产品/工具/功能，有形态和受众
2. **氛围画面**：描述一个具体画面/场景/瞬间的感官与情绪，没有命名意图
3. **设定世界观**：构建一个虚构世界的规则、设定、背景
4. **创作素材**：用于创作的元素、意象、情感基调
5. **研究好奇**：对某个现象的好奇，想搞清楚为什么/怎么样
6. **角色人物**：塑造一个角色的性格、背景、动机
7. **概念**：命名并定义一个概念，强调"命名 + 定义 + 区分"——这个概念是什么，和已有概念有何不同（fix6：不再要求"论证/主张"）
8. **美学提案**：命名并定义一种新的美学流派/风格范畴，强调命名 + 核心特征 + 与已有流派的差异
9. **其他**：难以归类的灵感

如果灵感同时符合多种类型，选最突出的那个，其他列入 alternative_types。
如果实在无法归类，type 设为"其他"。

## 5 信号判断（仅当类型为"概念"或"产品想法"时适用）

判断灵感是"概念"还是"产品想法"时，综合以下 5 个信号：

### 信号 1：核心名词的抽象度（权重 2）
- 抽象概念词（思维方式/体系/范式/理论/状态/关系）→ +2 概念
- 具象实体词（App/工具/游戏/平台/设备/服务）→ +2 产品想法

### 信号 2："能"后动词性质（权重 1）
- 认知动作词（思考/理解/定义/追问/连接）→ +1 概念
- 功能操作词（记录/搜索/分享/导出/同步）→ +1 产品想法

### 信号 3：是否绑定交付形态（权重 1-2）
- 无形态绑定 → +1 概念
- 明确形态（App/网站/硬件）→ +2 产品想法

### 信号 4："做"字信号（权重 1）
- 含"是/定义为/本质是" → +1 概念
- 含"做/开发/构建/实现" → +1 产品想法

### 信号 5：用户期待被问的方向（权重 1）
- 期待被问"本质特征/与相似概念区别" → +1 概念
- 期待被问"目标用户/核心功能" → +1 产品想法

## 信号 6：美学命名信号（权重 2，仅当出现时触发，优先级高于 5 信号）

如果灵感满足以下任一条件，优先判定为"美学提案"（即使 5 信号指向概念或氛围画面）：
- 含"是一种 XX 流派/风格/美学/新分支" + 自创命名（如"水烟爵士""阈限空间""液态霓虹"）
- 含"我把它叫作 XX" + 美学特征描述
- 命名 + 描述一类风格范畴（不是描述一个具体画面，也不是命名一个普通概念）

### 美学提案 vs 概念
- 概念：命名一个抽象概念（"XX 是一种 XX 思维方式/范式/状态"——命名 + 定义 + 区分）
- 美学提案：命名一种美学范畴（"我把这种 XX 叫作 XX"——命名 + 定义 + 差异，且必须是美学/风格范畴）

### 美学提案 vs 氛围画面
- 氛围画面：描述一个具体画面（无命名，描述即全部）
- 美学提案：定义一类美学范畴（有自创命名，命名是核心）

## 判断规则
- 同时提到"做/产品/工具/功能"+ 受众 → 产品想法
- 重点在感官/画面/氛围/情绪（无命名）→ 氛围画面
- 重点在虚构世界/设定/规则 → 设定世界观
- 重点在创作元素/意象/情感 → 创作素材
- 重点在疑问/为什么/怎么样 → 研究好奇
- 重点在人物/性格/经历 → 角色人物
- 命名 + "是一种 XX 概念/思维方式/范式/模式"+ 与已有概念区分 → 概念
- 命名 + "是一种 XX 流派/风格/美学"+ 核心特征描述 → 美学提案

## 返回 JSON 格式（严格遵守）
{
  "type": "类型名（9 种之一或'其他'）",
  "confidence": 0.85,
  "alternative_types": ["备选类型1", "备选类型2"],
  "reasoning": "一句话说明为什么判断为这个类型",
  "signals": {
    "noun_abstractness": "concept|product",
    "verb_type": "concept|product",
    "form_binding": "concept|product|neutral",
    "definition_vs_making": "concept|product",
    "expected_question_direction": "concept|product"
  },
  "concept_score": 5,
  "product_score": 0,
  "aesthetic_naming": true
}`;
  }

  // 按 stage 构建不同 prompt（K4 改造版）
  // 功能：根据结晶阶段 + 灵感类型 + 胶囊决策生成对应的 prompt 文本
  // 实现方式：
  //   - initial: 按 DIMENSION_POOL 必选/可选维度生成 3-5 个追问问题，最后追加 _supplement 补充题
  //   - questioning: 基于历史判断是否继续追问或生成结晶体
  //   - generate_crystal: 直接生成结晶体
  //   - 默认 fallback: 当作 initial 处理
  // K4 改造：
  //   - 维度配置从 TYPE_DIMENSIONS 取用，options 从 DIMENSION_POOL 取用
  //   - 新增 capsuleDecision 参数，'use' 时走差异化提问（剔除胶囊已预填的维度）
  //   - 末尾固定追加 _supplement 选做补充题
  //   - crystal 字段结构从 TYPE_BRANCHES 的 baseFields/dynamicFields/metaFields/aiInferredFields 推导
  _buildPrompt(target, stage, draft, conversationHistory, inspirationType, branch, capsuleDecision = null, detectedCapsules = []) {
    // 判断是否走胶囊感知路径
    const useCapsuleAware = capsuleDecision === 'use' && detectedCapsules.length > 0;

    // 获取维度配置
    const typeConfig = TYPE_DIMENSIONS[inspirationType] || TYPE_DIMENSIONS['其他'];
    const requiredDims = typeConfig.required || [];
    const optionalDims = typeConfig.optional || [];

    // K4：如果使用胶囊，初版不剔除维度（在 prompt 里告知 LLM 哪些已预填）
    const activeRequiredDims = requiredDims;
    const activeOptionalDims = optionalDims;

    // 构建维度说明段落
    const buildDimensionSection = (dimName) => {
      const dim = DIMENSION_POOL[dimName];
      if (!dim) return '';

      if (dim.type === 'single_choice') {
        const optionsText = dim.options.map(opt => {
          let text = `- ${opt.id} ${opt.label}`;
          if (opt.definition) text += `\n  【定义】${opt.definition}`;
          if (opt.signals) text += `\n  【判断信号】${opt.signals.join('/')}`;
          return text;
        }).join('\n');
        return `### 大维度 ${dimName}（必选 1 个小维度）\n${optionsText}`;
      }

      if (dim.type === 'multi_choice') {
        const optionsText = dim.options.map(opt => {
          let text = `- ${opt.id} ${opt.label}`;
          if (opt.definition) text += `\n  【定义】${opt.definition}`;
          if (opt.signals) text += `\n  【判断信号】${opt.signals.join('/')}`;
          return text;
        }).join('\n');
        return `### 大维度 ${dimName}（必选 1-${dim.max_select} 个小维度，multi:true, max_select:${dim.max_select}）\n${optionsText}`;
      }

      if (dim.type === 'free_text') {
        return `### 大维度 ${dimName}（固定维度，无小维度分支）\n【定义】${dim.description}\n【提问方向】${dim.prompt_direction || dim.description}`;
      }

      if (dim.type === 'two_step') {
        const subDimsText = (dim.sub_dimensions || []).map(sub => {
          return `- ${sub.id} ${sub.label}\n  【提问方向】${sub.prompt_direction}`;
        }).join('\n');
        return `### 大维度 ${dimName}（必选维度，含 ${(dim.sub_dimensions || []).length} 个小维度）\n【说明】${dim.description}\n${subDimsText}`;
      }

      return '';
    };

    // initial 阶段：生成 3-5 个追问问题（含胶囊差异化逻辑）
    if (stage === 'initial') {
      const requiredSections = activeRequiredDims.map(buildDimensionSection).join('\n\n');
      const optionalSections = activeOptionalDims.map(buildDimensionSection).join('\n\n');

      // 胶囊预填说明段落
      let capsuleSection = '';
      if (useCapsuleAware) {
        const capsule = detectedCapsules[0];
        capsuleSection = `
## 设定胶囊已预填的维度（不要问这些）
本灵感基于设定胶囊：${capsule.name}
已预填的元素：${capsule.applicable_elements.join(', ')}

## 你要问的是"差异化"
不要问胶囊已预填的维度——用户已经告诉你了。
要问的是：
1. 在标准胶囊框架外，本作品的独特焦点是什么？
2. 与标准胶囊相比，用户想强化/弱化哪些元素？
3. 胶囊未覆盖的维度（如具体情节/差异点）

## 问题数 2-3 个即可
胶囊已承担了大部分具象化工作，用户只需补"差异点"。
`;
      }

      const questionCount = useCapsuleAware ? '2-3' : '3-5';
      const supplementText = SUPPLEMENT_QUESTION_TEXT[inspirationType] || SUPPLEMENT_QUESTION_TEXT['其他'];

      return `分析以下灵感，生成 ${questionCount} 个最关键的追问问题，帮助用户澄清想法。

灵感内容：
${target}

## 当前灵感类型
${inspirationType}（目标结晶形态：${branch.crystalType}）
${capsuleSection}
## 机制说明
- 大维度是该类型追问的元层级（如"产品形态""核心价值"）
- 每个大维度下有多个小维度（如"产品形态"下有应用/游戏/硬件/内容产品）
- 每个小维度带【定义】和【判断信号】，AI 基于定义+信号选择最相关的路径
- 每个维度带【适用条件】，AI 据此判断该维度是否需要追问
- AI 读完灵感后，先在必选维度中选小维度，再从可选维度中选取相关维度，凑够 ${questionCount} 个问题

## 必选维度（必须选取小维度）

${requiredSections}

## 可选维度（AI 根据适用条件选取 0-2 个）

${optionalSections}

## AI 选择规则
1. 必选维度：${activeRequiredDims.join(' + ')}
2. 可选维度：从可选维度中选 0-2 个最相关的（基于适用条件）
3. 总问题数 ${questionCount} 个
4. 覆盖的大维度不允许重复（同一大维度只能问一个问题）
5. 每题给 4-5 个具象且带创意感的选项
6. 前端会自动追加"其他：请补充"
7. 动态字段：某些维度选了之后，crystal 里会附加对应字段
8. 最后一个问题固定为选做补充题："${supplementText}"（multi:false, 允许自由作答）

## 问题文本质量约束（必须严格遵守，违反将导致用户困惑）
1. **必须紧扣灵感原文**：每个问题的文本必须直接关联灵感中的具体表述、关键词或情境。问题开头应体现"基于你说的 XX..."这种与原文的连接。
2. **禁止脱离原文空问**：不允许问"你希望它是什么样的？""你想要什么感觉？"这类脱离灵感原文的空泛问题。必须把问题锚定到原文中的某个具体点。
3. **禁止揪着不放**：不允许在多个问题中反复追问同一个细节（如"主角是谁？""主角什么性格？""主角背景？"）。每个问题应覆盖不同的大维度。
4. **禁止问八竿子打不着的问题**：如果某个维度与灵感原文明显无关（如纯氛围描写却问"技术约束"），不要选这个维度。
5. **选项要具体且与原文相关**：选项应基于灵感原文能推断出的具体可能，不要给抽象的"是/否/其他"选项。
6. **问题顺序**：从最核心的维度开始问（通常是必选维度的第一个），最后才是补充题。

## 返回 JSON 格式（严格遵守）
{
  "stage": "A",
  "selected_dimensions": [
    {"大维度": "维度名", "小维度": "选项 id + label", "理由": "为什么这个维度与灵感原文相关（一句话）"}
  ],
  "clarifying_questions": [
    {
      "id": 1,
      "text": "问题文本（开头体现与灵感原文的连接，如'你提到 XX，这里想搞清楚...'）",
      "multi": false,
      "options": ["具象选项1（与原文相关）", "选项2", "选项3", "选项4"],
      "key": "对应 crystalField 名",
      "source_dimension": "A2 / B2 / C / ..."
    },
    {
      "id": "last",
      "text": "${supplementText}",
      "multi": false,
      "options": [],
      "key": "_supplement",
      "source_dimension": "supplement"
    }
  ]
}

注意：必须返回 stage="A"、selected_dimensions 数组、clarifying_questions 数组，不要返回 crystal。
选做补充题的 options 为空数组，前端渲染为自由文本输入框。`;
    }

    // questioning 阶段：基于对话历史和新回答，决定是否继续追问或生成结晶体
    if (stage === 'questioning') {
      const supplementText = SUPPLEMENT_QUESTION_TEXT[inspirationType] || SUPPLEMENT_QUESTION_TEXT['其他'];
      return `基于以下灵感原文 + 对话历史 + 用户最新回答，判断信息是否已充分生成结晶体，或仍需继续追问。

灵感原文：
${target}

当前灵感类型：${inspirationType}（目标结晶形态：${branch.crystalType}）

对话历史：
${JSON.stringify(conversationHistory, null, 2)}

当前结晶草稿：
${JSON.stringify(draft, null, 2)}

## 判断规则
- 若已有 1 轮以上追问且用户回答充分 → 生成结晶体（stage="C"）
- 若信息明显不足（关键维度仍空白）→ 继续追问（stage="B"）
- 默认倾向：1 轮追问后即可尝试生成结晶体，避免过度追问让用户疲劳

## 追问问题质量约束（必须严格遵守，违反将导致用户困惑）
1. **必须紧扣灵感原文 + 用户上轮回答**：追问问题的文本必须直接关联灵感原文中的具体表述，或用户在上一轮回答中提到的新信息。问题开头应体现这种连接，如"你刚才提到 XX，那..."或"基于你说的 XX，这里想搞清楚..."。
2. **禁止揪着不放**：不允许反复追问同一个细节（如已经问过"主角是谁"又问"主角什么性格"又问"主角背景"）。如果上一轮已经问了某个大维度，这一轮必须换一个不同的大维度。
3. **禁止问八竿子打不着的问题**：追问必须是为了填补生成 crystal 还缺少的关键字段，不允许突然问一个与灵感原文和上轮回答都无关的问题。
4. **禁止脱离原文空问**：不允许问"你希望它是什么样的？""你想要什么感觉？"这类脱离灵感原文的空泛问题。
5. **一次只问 1 个问题**：追问阶段每次只问 1 个最关键的问题，不要一次抛多个。
6. **选项要具体且与上下文相关**：选项应基于灵感原文 + 上轮回答能推断出的具体可能，不要给抽象的"是/否/其他"选项。
7. **判断该不该问**：如果生成 crystal 还缺的关键字段已经被前几轮回答覆盖（哪怕没显式问），直接生成 crystal，不要再追问。

## 若继续追问，返回 JSON：
{
  "stage": "B",
  "clarifying_questions": [
    {
      "id": 2,
      "text": "问题文本（开头体现与灵感原文或上轮回答的连接，如'你刚才提到 XX，那想搞清楚...'）",
      "multi": false,
      "options": ["具象选项1（与上下文相关）", "选项2", "选项3", "选项4", "选项5"],
      "key": "field_name"
    }
  ]
}

## 若生成结晶体，返回 JSON（crystal 字段结构按类型 + 动态字段 + 元字段）：
{
  "stage": "C",
  "crystal": {
    ${branch.baseFields.map(f => `"${f}": "..."`).join(',\n    ')}
  },
  "selected_dimensions": [...],
  "detected_capsule": [...],
  "next_agent": "epitaxy"
}

## crystal 生成规则
1. 基础字段必生成：${branch.baseFields.join(', ')}
2. 动态字段按 selected_dimensions 附加：${(branch.dynamicFields || []).join(', ')}（如果 selected_dimensions 含对应维度）
3. 元字段 LLM 主动推断：${(branch.metaFields || []).join(', ')}（如 composable_with / follow_up_questions）
4. AI 推断字段 LLM 主动判断：${(branch.aiInferredFields || []).join(', ')}（如 archetype）
5. 合并胶囊预填：如果 detected_capsule 非空，把胶囊预填的元素合并到 crystal（用户回答优先于胶囊预填）

## 各类型 crystal 字段说明
- 产品想法 (prd): { title, goal, target_user, core_features:[] }
- 氛围画面 (scene_card): { title, setting, sensory_detail, mood, protagonist?, moment? }
- 设定世界观 (worldview): { title, premise, rules, inhabitants?, tension? }
- 创作素材 (creative_direction): { title, medium, theme, style_refs:[], mood?, technique?, composable_with? }
- 研究好奇 (exploration_map): { title, core_question, known_boundary:{个人已知,学界已知}, unknown_direction, method?, expected_output?, follow_up_questions? }
- 角色人物 (character_profile): { title, archetype, background:{社会背景,个人经历}, personality, flaw, motivation?, relationships?, mannerisms? }
- 概念 (concept_card): { title, definition, distinction, origin?, signature_features?, applicable_context?, evolution?:{ directions:[] } }
- 其他 (free_note): { title, content, tags:[] }`;
    }

    // generate_crystal 阶段：直接生成结晶体，跳过追问
    if (stage === 'generate_crystal' || stage === 'generate_prd') {
      return `基于以下内容直接生成完整结晶体，跳过追问环节。

灵感内容：
${target}

当前灵感类型：${inspirationType}（目标结晶形态：${branch.crystalType}）

结晶草稿（参考）：
${JSON.stringify(draft, null, 2)}

## 返回 JSON 格式（crystal 字段结构按类型 + 动态字段 + 元字段）
{
  "stage": "C",
  "crystal": {
    ${branch.baseFields.map(f => `"${f}": "..."`).join(',\n    ')}
  },
  "selected_dimensions": [...],
  "detected_capsule": [...],
  "next_agent": "epitaxy"
}

## crystal 生成规则
1. 基础字段必生成：${branch.baseFields.join(', ')}
2. 动态字段按 selected_dimensions 附加：${(branch.dynamicFields || []).join(', ')}
3. 元字段 LLM 主动推断：${(branch.metaFields || []).join(', ')}
4. AI 推断字段 LLM 主动判断：${(branch.aiInferredFields || []).join(', ')}
5. 合并胶囊预填：如果 detected_capsule 非空，把胶囊预填的元素合并到 crystal

## 各类型 crystal 字段说明
- 产品想法 (prd): { title, goal, target_user, core_features:[] }
- 氛围画面 (scene_card): { title, setting, sensory_detail, mood, protagonist?, moment? }
- 设定世界观 (worldview): { title, premise, rules, inhabitants?, tension? }
- 创作素材 (creative_direction): { title, medium, theme, style_refs:[], mood?, technique?, composable_with? }
- 研究好奇 (exploration_map): { title, core_question, known_boundary:{个人已知,学界已知}, unknown_direction, method?, expected_output?, follow_up_questions? }
- 角色人物 (character_profile): { title, archetype, background:{社会背景,个人经历}, personality, flaw, motivation?, relationships?, mannerisms? }
- 概念 (concept_card): { title, definition, distinction, origin?, signature_features?, applicable_context?, evolution?:{ directions:[] } }
- 其他 (free_note): { title, content, tags:[] }`;
    }

    // 默认 fallback：当作 initial 处理
    return `分析以下灵感，生成 3-5 个最关键的追问问题。

灵感内容：
${target}

返回 JSON：{ "stage": "A", "selected_dimensions": [...], "clarifying_questions": [{"id":1,"text":"...","multi":false,"options":["...","..."],"key":"..."}] }`;
  }
}

// 静态便捷方法：供控制器直接 CrystallizeAgent.run(context) 调用
CrystallizeAgent.run = function run(context) {
  return new CrystallizeAgent().run(context);
};

// 静态 sense 方法：供控制器直接 CrystallizeAgent.sense(id, text) 调用
CrystallizeAgent.sense = function sense(inspirationId, text) {
  return new CrystallizeAgent().sense(inspirationId, text);
};

export default CrystallizeAgent;
