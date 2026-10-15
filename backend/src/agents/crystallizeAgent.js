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
  SUPPLEMENT_QUESTION_TEXT,
  CONCEPT_MAP_LIMITS
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

  // 运行结晶流程（questioning / crystal 阶段，K4 改造版 + 概念地图引擎）
  // 功能：按 stage 调用 LLM，保存结果，可选自动分流到下一 Agent（Epitaxy）
  // 实现方式：解构 context → 获取目标内容 → 构建 prompt → 调用 LLM → 解析 JSON → 合并胶囊预填 → 持久化 → 可选分流
  // K4 改造：
  //   - context 新增 detectedCapsules / capsuleDecision 字段
  //   - _buildPrompt 调用透传 capsuleDecision / detectedCapsules
  //   - crystal 生成后合并胶囊预填元素（用户回答优先于胶囊预填）
  // 概念地图改造（Task 1.3 / 2.5）：
  //   - context 新增 conceptMap（上一轮地图，首轮 null）/ checkpointInput（检查点补充方向）
  //   - 落盘改为「仅当本轮产出 crystal 时才写文件」（修复 0-5：问题文件不再遮蔽 latest）
  //   - concept_map 兜底：结构不合法则丢弃字段（前端自动降级），绝不抛未捕获异常
  // Task 8 加固：
  //   - context 新增 answeredConcept（被答概念 id，可选）：由代码标记为已覆盖，不依赖 LLM 自觉
  //   - coverage 由代码按 concepts 权威重算；single 不得出检查点；fusion 结构兜底
  // v2 张力对改造（Task 1.3 / 2）：
  //   - context 新增 tensionPairs（用户保留的张力对）/ tensionScan（张力扫描留痕，结晶轮回显）
  //   - stage='tension'：只找张力对，做原文校验与结构兜底，不产出 concept_map；不落 crystallize 文件，
  //     也不写 crystallize_results / inspirations 两张表（该阶段不带类型，防脏默认值，见 §2）
  //   - stage='initial' 带 tensionPairs：concept_map 由代码构建并做权威覆盖（LLM 只贡献 dimension）
  //   - stage='initial' 不带 tensionPairs：退回单概念（原文原词 + 过校验），mode=single / fusion=null
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
        capsuleDecision = null,    // K4 新增：'use' / 'ignore' / null
        conceptMap = null,         // 概念地图新增：上一轮返回的地图（首轮为 null）
        checkpointInput = null,    // 概念地图新增：检查点"还想补充"的输入
        answeredConcept = null,    // Task 8 新增：本轮刚被回答的概念 id（'A' / 'A×B'），用于代码侧标记已覆盖
        tensionPairs = null,       // v2 新增：用户保留的张力对（仅 initial 阶段使用，由前端勾选后回传）
        tensionScan = null         // v2 新增：张力扫描留痕（仅 generate_crystal 阶段回显，随结晶轮落盘）
      } = context;

      // 兼容旧字段名：prdDraft → crystalDraft
      const draft = Object.keys(crystalDraft).length > 0 ? crystalDraft : prdDraft;

      // 获取目标内容
      let target = userInput;
      if (!target && inspirationId) {
        const inspiration = await this.getInspiration(inspirationId);
        target = inspiration?.content || inspiration?.title;
      }
      // 概念地图改造：检查点补充场景下，若前两处都没取到材料，用 checkpointInput 兜底，避免直接报错
      if (!target && checkpointInput) {
        target = String(checkpointInput);
      }
      if (!target) {
        return { success: false, error: 'No target content to crystallize' };
      }

      // 获取类型分支配置（兜底为"其他"）
      const branch = TYPE_BRANCHES[inspirationType] || TYPE_BRANCHES[INSPIRATION_TYPES.OTHER];
      const crystalType = branch.crystalType;

      // SubTask 8.1（输入侧）：用代码把「被答概念」标记为已覆盖，不依赖 LLM 自觉
      // 目的：消除「答完 A 又重复问 A」以及「融合题反复出现」的风险
      // 关键：标记后的地图同时用于「喂给 LLM 的提示词」与「返回给前端的响应」，保证二者一致
      const markedConceptMap = this._markAnsweredConcept(conceptMap, answeredConcept);

      // v2 新增：请求带张力对（且 stage='initial'）时，概念地图由代码构建（LLM 只负责配维度 + 出首题）
      // 判定：tensionPairs 为数组且长度 ≥1。
      // 注意：builtMap 为 null 有两种来源——① 建图抛异常；② 全部端点都无法在原文定位时 _buildMapFromTensionPairs 返回 null。
      //       两者都属异常路径，其兜底见下方「SubTask 8.2」块（丢弃未经校验的 LLM 地图，绝不透出）。
      const hasTensionPairs = Array.isArray(tensionPairs) && tensionPairs.length >= 1;
      let builtMap = null;
      if (stage === 'initial' && hasTensionPairs) {
        try {
          builtMap = this._buildMapFromTensionPairs(tensionPairs, target);
        } catch (bmErr) {
          console.warn('[CrystallizeAgent] build map from tension pairs failed:', bmErr.message);
          builtMap = null;
        }
      }

      // 按 stage 构建 prompt（K4：透传 capsuleDecision / detectedCapsules；概念地图：透传 conceptMap / checkpointInput / answeredConcept；
      // v2：透传 tensionPairs —— initial 分支据此构建并嵌入代码地图）
      const prompt = this._buildPrompt(target, stage, draft, conversationHistory, inspirationType, branch, capsuleDecision, detectedCapsules, markedConceptMap, checkpointInput, answeredConcept, tensionPairs);

      // 调用 LLM 生成
      const result = await this.generate(prompt, this.systemPrompt);
      const content = this._extractContent(result);
      let parsed = this._parseJSON(content);

      // SubTask 9.1：tension 阶段解析彻底失败（含 _parseJSON 内的控制字符修复）时的处理——绝不静默。
      // 原因：tension 的失败形态会被后处理兜成 tension_pairs=[] / no_tension_reason=null，
      //       看起来像"这篇灵感没有张力对"，从而让整个 v2 静默失效且用户毫无察觉。
      // 处理：① 用同一个 prompt 重试一次（追加"必须返回可解析 JSON、字符串值写成单行"的修正要求，
      //         沿用本项目 single 守卫"唯一允许的兜底二次调用"的先例）；
      //       ② 仍失败 → 返回 { success:false, error }，把"没找到张力"与"没解析出来"区分开。
      // 注意：其它 stage 的解析失败行为保持原样，不做重试、不做特殊处理。
      if (stage === 'tension' && parsed && typeof parsed === 'object' && typeof parsed.error === 'string') {
        this.log(`tension parse failed, retrying once: ${parsed.error}`);
        try {
          const retryPrompt = `${prompt}

## 重要修正（上一次输出无法被解析）
上一次输出无法被 JSON.parse 解析。本次必须**只返回可解析的 JSON**：所有字符串值写成**单行**，字符串内部不得出现换行。`;
          const retryResult = await this.generate(retryPrompt, this.systemPrompt);
          const retryParsed = this._parseJSON(this._extractContent(retryResult));
          if (retryParsed && typeof retryParsed === 'object' && typeof retryParsed.error !== 'string') {
            parsed = retryParsed;   // 重试成功 → 继续走下方 tension 后处理
          } else {
            return { success: false, error: 'Tension stage output could not be parsed as JSON (retried once)' };
          }
        } catch (retryErr) {
          console.warn('[CrystallizeAgent] tension retry failed:', retryErr.message);
          return { success: false, error: `Tension stage parse failed: ${retryErr.message}` };
        }
      }

      // ===== v2 张力对改造：解析后的权威处理 =====
      // 路径 A（带张力对的 initial）：以代码构建的地图为唯一事实来源，LLM 只贡献 dimension。
      //   即使 LLM 完全没回显 concept_map，也直接用代码地图（绝不回退为"照抄 LLM"）。
      if (builtMap) {
        try {
          parsed = this._applyAuthoritativeMap(parsed, builtMap);
        } catch (amErr) {
          console.warn('[CrystallizeAgent] apply authoritative map failed:', amErr.message);
          parsed.concept_map = builtMap;
        }
      } else if (stage === 'initial' && hasTensionPairs) {
        // SubTask 8.2：带张力对但代码建图失败/为空的异常路径收紧
        // 触发：hasTensionPairs 为真但 builtMap 为空（建图抛异常，或全部端点都无法在原文定位 → 返回 null）。
        // 风险：此时提示词已退化为单概念路径，而下方路径 B 的校验条件写的是 !hasTensionPairs，会漏过校验——
        //       LLM 若自带一张自造概念的地图，就会未经校验直接透给前端（正是本次改造要根治的"造词"病）。
        // 处理：直接丢弃该地图，让前端走既有"无地图 → 全链路降级"路径；宁可降级，也绝不透出未经校验的概念轴。
        //       （不选"仅对概念名做原文校验"：那样 LLM 仍可自造概念数量与分组——即 v1 的"逐句抄"退化，且 fusion 缺代码权威。）
        delete parsed.concept_map;
      }

      // 路径 B（不带张力对的 initial）：concept name 走原文校验，并收敛为单概念（concepts 长度 1 / mode single / fusion null）
      if (stage === 'initial' && !hasTensionPairs
        && parsed.concept_map && typeof parsed.concept_map === 'object'
        && Array.isArray(parsed.concept_map.concepts)) {
        try {
          const cleanedConcepts = this._enforceVerbatimNames(parsed.concept_map.concepts, target);
          if (cleanedConcepts.length > 0) {
            parsed.concept_map = {
              ...parsed.concept_map,
              mode: 'single',
              concepts: [cleanedConcepts[0]],
              fusion: null
            };
          } else {
            delete parsed.concept_map;   // 概念名全部无法在原文定位 → 丢弃地图（前端自动降级）
          }
        } catch (vbErr) {
          console.warn('[CrystallizeAgent] enforce verbatim concept name failed:', vbErr.message);
        }
      }

      // tension 阶段：概念名原文校验 + 结构兜底；该阶段不产出概念地图
      if (stage === 'tension') {
        parsed.stage = 'tension';   // 锁定阶段标识，避免模型误标导致前端走错分支
        parsed.tension_pairs = this._cleanTensionPairs(parsed.tension_pairs, target);
        if (typeof parsed.no_tension_reason !== 'string' || !parsed.no_tension_reason.trim()) {
          parsed.no_tension_reason = null;   // 缺失 → null
        }
        delete parsed.concept_map;   // 保持 undefined，不把 concept_map 透给前端
        // SubTask 8.1：显式丢弃结晶体相关字段——tension 是前置中间产物，不许携带结晶体，
        // 不依赖模型自觉（提示词虽写了不许返回，但若模型误返回 crystal，会触发结晶轮落盘与后续分流）
        delete parsed.crystal;
        delete parsed.prd;   // 兼容字段：LLM 可能用 prd 代指 crystal，一并丢弃
      }

      // SubTask 8.3-1 守卫：single 模式不得出检查点
      // 判定单概念（任一命中）：LLM 返回 mode 为 single / LLM 返回地图只有 1 个概念 / LLM 未返回地图但回显地图只有 1 个概念
      // 异常路径处理：改以 stage:'generate_crystal' 的提示词重新生成一次（这是唯一允许的兜底二次调用），解析后按 C 返回
      // 若二次调用仍拿不到 crystal → 直接返回失败，绝不把 checkpoint 透给前端
      const rawConcepts = Array.isArray(parsed.concept_map?.concepts) ? parsed.concept_map.concepts : [];
      const echoConcepts = Array.isArray(markedConceptMap?.concepts) ? markedConceptMap.concepts : [];
      const singleLike = parsed.concept_map?.mode === 'single'
        || rawConcepts.length === 1
        || (rawConcepts.length === 0 && echoConcepts.length === 1);
      if (singleLike && parsed.stage === 'checkpoint') {
        this.log('single mode returned checkpoint → fallback to generate_crystal');
        try {
          const fbPrompt = this._buildPrompt(target, 'generate_crystal', draft, conversationHistory, inspirationType, branch, capsuleDecision, detectedCapsules, markedConceptMap, checkpointInput, answeredConcept, tensionPairs);
          const fbResult = await this.generate(fbPrompt, this.systemPrompt);
          const fbParsed = this._parseJSON(this._extractContent(fbResult));
          if (fbParsed && typeof fbParsed === 'object' && fbParsed.crystal) {
            parsed = fbParsed;  // 用二次结果替换，后续统一走 C 分支
          } else {
            return { success: false, error: 'Single-concept crystallize failed: checkpoint is not allowed for single mode' };
          }
        } catch (fbErr) {
          console.warn('[CrystallizeAgent] single-mode fallback generate_crystal failed:', fbErr.message);
          return { success: false, error: fbErr.message };
        }
      }

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

      // 概念地图兜底（Task 2.5）：结构不合法 / 概念超限时截断或丢弃该字段
      // 约定：concept_map 缺失或解析失败时响应体不带该字段 → 前端全链路降级为旧行为（不崩溃）
      try {
        if (parsed.concept_map && typeof parsed.concept_map === 'object' && Array.isArray(parsed.concept_map.concepts)) {
          const validConcepts = parsed.concept_map.concepts
            .filter(c => c && typeof c === 'object')
            .slice(0, CONCEPT_MAP_LIMITS.MAX_CONCEPTS);
          if (validConcepts.length > 0) {
            parsed.concept_map.concepts = validConcepts;
            // mode 缺失或不合法时按概念数补正（≥2 → multi）
            if (parsed.concept_map.mode !== 'single' && parsed.concept_map.mode !== 'multi') {
              parsed.concept_map.mode = validConcepts.length >= 2 ? 'multi' : 'single';
            }
          } else {
            delete parsed.concept_map;  // concepts 为空 → 视为无效地图
          }
        } else if (parsed.concept_map !== undefined) {
          delete parsed.concept_map;    // 结构不合法 → 丢弃，前端降级
        }
      } catch (cmErr) {
        console.warn('[CrystallizeAgent] concept_map normalize failed:', cmErr.message);
        delete parsed.concept_map;
      }

      // SubTask 8.1（响应侧）+ 8.2：对返回给前端的地图做权威后处理
      //   8.1 标记被答概念（LLM 若漏标，由此兜底，保证返回地图与提示词一致）
      //   8.2 按 concepts 重算 coverage（覆盖 LLM 返回值，LLM 可能算错；partial 不计入 covered）
      // 兜底：LLM 未返回可用地图但本轮确有回显地图时，改用「已标记 + 已重算」的回显地图，
      //       避免前端进度倒退（首轮 initial 无回显地图，行为不变）
      try {
        if (parsed.concept_map && typeof parsed.concept_map === 'object' && Array.isArray(parsed.concept_map.concepts)) {
          parsed.concept_map = this._recomputeCoverage(this._markAnsweredConcept(parsed.concept_map, answeredConcept));
        } else if (markedConceptMap && Array.isArray(markedConceptMap.concepts)) {
          parsed.concept_map = this._recomputeCoverage(markedConceptMap);
        }
      } catch (cmPostErr) {
        console.warn('[CrystallizeAgent] concept_map post-process failed:', cmPostErr.message);
      }

      // SubTask 8.3-2 / v2 修正（SubTask 7.2）：crystal.fusion 规范化——代码权威补齐字段，不编造内容
      // 条件：mode 为 multi、地图有 fusion、本轮产出 crystal
      // 实现：① crystal.fusion 不是对象 → 先按既有逻辑创建 { of: [], insight: '' }；
      //      ② 无论 LLM 是否给了，都把 of / name / line 覆盖为代码值（of 取概念地图 fusion.of，非数组 → 空数组；
      //         name 优先取 concept_map.fusion.name，缺失时用 of 对应概念名以 ' × ' 连接；line 缺失置 null）；
      //      ③ 不动 insight（那是 LLM 的内容，代码不编造）。mode 非 multi 时本块不生效，行为不变。
      try {
        if (parsed.concept_map && parsed.concept_map.mode === 'multi'
          && parsed.concept_map.fusion && parsed.crystal) {
          const mapFusion = parsed.concept_map.fusion;
          if (!parsed.crystal.fusion || typeof parsed.crystal.fusion !== 'object') {
            parsed.crystal.fusion = {
              of: [],
              insight: ''
            };
          }
          // 代码权威补齐 of：of 与 name / line 同为代码权威，无条件用概念地图的值，避免 LLM 改写概念集合；
          // 地图 fusion.of 非数组 → 保持空数组 []，不编造
          parsed.crystal.fusion.of = Array.isArray(mapFusion.of) ? mapFusion.of : [];
          // 代码权威补齐 name：优先用地图 fusion.name；缺失则用 of 对应的概念名以 ' × ' 连接
          if (typeof mapFusion.name === 'string' && mapFusion.name.trim()) {
            parsed.crystal.fusion.name = mapFusion.name;
          } else {
            const ofIds = Array.isArray(mapFusion.of) ? mapFusion.of : [];
            const conceptList = Array.isArray(parsed.concept_map.concepts) ? parsed.concept_map.concepts : [];
            const names = ofIds
              .map(cid => conceptList.find(c => c && c.id === cid))
              .filter(c => c && typeof c.name === 'string')
              .map(c => c.name);
            parsed.crystal.fusion.name = names.join(' × ');
          }
          // 代码权威补齐 line：取地图 fusion.line，缺失置 null
          parsed.crystal.fusion.line = (typeof mapFusion.line === 'string') ? mapFusion.line : null;
        }
      } catch (fusionErr) {
        console.warn('[CrystallizeAgent] fusion normalize failed:', fusionErr.message);
      }

      // next_target 兜底：优先取 LLM 返回值，否则取本轮首题的 target_concept
      if (!parsed.next_target && Array.isArray(parsed.clarifying_questions) && parsed.clarifying_questions.length > 0) {
        parsed.next_target = parsed.clarifying_questions[0]?.target_concept || null;
      }

      // 保存到 per-inspiration/crystallize/ 文件存储
      // 修改（修复 0-5）：仅当本轮解析出 crystal 时才落盘；问题文件（initial/questioning/checkpoint 轮次）不再写文件
      // 落盘对象必须包含 crystal / concept_map / selected_dimensions / detected_capsule / inspiration_type / crystal_type / next_agent
      let saved = null;
      if (parsed.crystal) {
        try {
          const dataToSave = {
            ...parsed,
            crystal: parsed.crystal,
            concept_map: parsed.concept_map || null,
            selected_dimensions: parsed.selected_dimensions || [],
            detected_capsule: parsed.detected_capsule || (Array.isArray(detectedCapsules) ? detectedCapsules.map(c => c.key) : []),
            inspiration_type: inspirationType,
            crystal_type: crystalType,
            next_agent: parsed.next_agent || 'epitaxy'
          };
          // v2 新增：张力扫描留痕（仅当请求回显了「含 mode 字段的对象」时并入；缺失则不写该键）
          // 用途：区分"真没张力"与"模型偷懒"，供把关指标计算；前端不展示
          if (tensionScan && typeof tensionScan === 'object' && 'mode' in tensionScan) {
            dataToSave.tension_scan = tensionScan;
          }
          saved = await inspirationStorage.saveCrystallizeResult(inspirationId, dataToSave);
          this.log(`Saved crystallize result for ${inspirationId}`);
        } catch (saveErr) {
          console.warn('[CrystallizeAgent] Failed to save crystallize result to storage:', saveErr.message);
        }
      }

      // 写入 crystallize_results 表（含 inspiration_type/crystal_type，6 列不变）
      // 注意（回退 SubTask 8.5 的 INSERT 条件改动）：本表恢复为「每轮都插入」——initial / questioning /
      //   checkpoint / crystal 轮次均写行，与改造前既有行为一致。原因：archiveService 的结晶徽章依赖本表有行
      //   才判定 in_progress，若仅结晶轮插入，追问期间徽章会从 in_progress 退化为 none。
      //   与之相对，文件落盘 saveCrystallizeResult 仍只在 parsed.crystal 存在时执行（两者条件不同，勿一并回退）。
      // v2 修正（SubTask 7.1）：tension 阶段跳过本表 INSERT 与下方 inspirations UPDATE。
      //   原因：tension 请求按契约不带 inspirationType（类型此刻还没算出来，它与 sense 并排发出），
      //   若照跑这两张表，会用默认值 '产品想法' / 'prd' 写脏数据；用户若在勾选屏中止，灵感类型会被留成错值。
      //   该阶段是前置中间产物，两张表都等 initial 轮再写（其余阶段行为完全不变）。
      if (stage !== 'tension') {
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
          // SubTask 8.4：检查点阶段的"还想补充"占位文案（复用 SUPPLEMENT_QUESTION_TEXT，前端据此渲染次按钮）
          ...(parsed.stage === 'checkpoint'
            ? { checkpoint_hint: SUPPLEMENT_QUESTION_TEXT[inspirationType] || SUPPLEMENT_QUESTION_TEXT['其他'] }
            : {}),
          saved,
          dispatch: dispatchResult
        }
      };
    } catch (e) {
      this.log(`run failed: ${e.message}`);
      return { success: false, error: e.message };
    }
  }

  // 用代码把「被答概念」标记为已覆盖（SubTask 8.1）
  // 功能：不依赖 LLM 自觉更新状态，消除「答完 A 又重复问 A」与「融合题反复出现」的风险
  // 实现：answeredConcept 含 '×' 或等于 fusion.id → 置 fusion.status='covered'；
  //       否则在 concepts 中按 id 精确匹配 → 置 status='covered'、asked=true
  // 防御：answeredConcept 为空 / 地图结构无效 / 找不到节点 / 节点已是 covered|skipped → 静默跳过（不报错）
  // 返回：标记后的新地图（浅拷贝，不修改入参）；未做任何标记时原样返回入参
  _markAnsweredConcept(conceptMap, answeredConcept) {
    try {
      const target = typeof answeredConcept === 'string' ? answeredConcept.trim() : '';
      if (!target) return conceptMap;
      if (!conceptMap || typeof conceptMap !== 'object' || !Array.isArray(conceptMap.concepts)) return conceptMap;

      // 融合节点：id 形如 "A×B"（以 '×' 作为融合目标的标识）
      const fusion = conceptMap.fusion;
      if (fusion && (target.includes('×') || fusion.id === target)) {
        if (fusion.status === 'covered' || fusion.status === 'skipped') return conceptMap;  // 已终态
        return { ...conceptMap, fusion: { ...fusion, status: 'covered' } };
      }

      // 普通概念节点：按 id 精确匹配
      const idx = conceptMap.concepts.findIndex(c => c && c.id === target);
      if (idx < 0) return conceptMap;   // 找不到节点 → 静默跳过
      const node = conceptMap.concepts[idx];
      if (node.status === 'covered' || node.status === 'skipped') return conceptMap;  // 已终态
      const concepts = conceptMap.concepts.slice();
      concepts[idx] = { ...node, status: 'covered', asked: true };
      return { ...conceptMap, concepts };
    } catch (err) {
      console.warn('[CrystallizeAgent] mark answered concept failed:', err.message);
      return conceptMap;
    }
  }

  // 按 concepts 权威重算 coverage（SubTask 8.2）
  // 功能：覆盖 LLM 返回的 coverage（LLM 可能算错），保证前端进度与地图一致
  // 实现：total = concepts 数；covered/skipped 按 status 计数（partial 不计入 covered，保持"仍需追问"语义）；
  //       done = 所有概念均为 covered|skipped，且（mode 为 single 或 无 fusion 或 fusion 已完成）
  // 返回：重算后的新地图（浅拷贝）；地图结构无效时原样返回
  _recomputeCoverage(conceptMap) {
    try {
      if (!conceptMap || typeof conceptMap !== 'object' || !Array.isArray(conceptMap.concepts)) return conceptMap;
      const concepts = conceptMap.concepts;
      const covered = concepts.filter(c => c && c.status === 'covered').length;
      const skipped = concepts.filter(c => c && c.status === 'skipped').length;
      const allConceptsDone = concepts.every(c => c && (c.status === 'covered' || c.status === 'skipped'));
      const fusion = conceptMap.fusion;
      const fusionDone = conceptMap.mode === 'single' || !fusion
        || fusion.status === 'covered' || fusion.status === 'skipped';
      return {
        ...conceptMap,
        coverage: { total: concepts.length, covered, skipped, done: allConceptsDone && fusionDone }
      };
    } catch (err) {
      console.warn('[CrystallizeAgent] recompute coverage failed:', err.message);
      return conceptMap;
    }
  }

  // ========== v2 张力对改造：新增 helper ==========

  // 概念名原文校验（tension 端点 / 无张力路径的 concepts 通用）
  // 功能：保证 name 是灵感原文（target）的连续子串，绝不把模型自造的词透给前端
  // 实现：① name 本身是原文子串 → 保留；② 否则从 evidence（或 source_evidence）中找能在原文定位到的片段替换；
  //      ③ 仍定位不到 → 剔除该条
  // 参数：items = [{ name, evidence?/source_evidence?, ... }]；返回清洗后的新数组（元素为浅拷贝）
  _enforceVerbatimNames(items, target) {
    const src = typeof target === 'string' ? target : '';
    if (!Array.isArray(items)) return [];
    if (!src) return items;   // 无原文可比对 → 原样返回，不做误删
    const result = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      // ① 直接命中原文连续子串 → 保留
      if (name && src.includes(name)) {
        result.push({ ...item, name });
        continue;
      }
      // ② 回退：从 evidence / source_evidence 中找能定位到原文的片段
      const evidence = typeof item.evidence === 'string'
        ? item.evidence
        : (typeof item.source_evidence === 'string' ? item.source_evidence : '');
      const fragment = this._locateVerbatimFragment(evidence, src);
      if (fragment) result.push({ ...item, name: fragment });
      // ③ 定位不到 → 丢弃该条
    }
    return result;
  }

  // 从候选文本（evidence）中找出能在灵感原文中定位到的片段
  // 功能：为 name 校验失败时提供回退名，避免因模型引号/标点差异而误删整条
  // 实现：先整体匹配；不中再按标点/空白切分，取最长的、能在原文定位到的片段（≥2 字，避免取到无意义单字）
  // 说明：只用 String.includes 做包含判断，不做模糊匹配、不引入依赖
  _locateVerbatimFragment(evidence, src) {
    const ev = typeof evidence === 'string' ? evidence.trim() : '';
    if (!ev || !src) return '';
    if (src.includes(ev)) return ev;   // evidence 整体即原文片段
    const parts = ev.split(/[\s,，。、；;：:!！?？()（）【】「」『』“”"'…—\/-]+/).filter(p => p.length >= 2);
    let best = '';
    for (const p of parts) {
      if (p.length > best.length && src.includes(p)) best = p;
    }
    return best;
  }

  // 张力对清洗（tension 阶段后处理）
  // 功能：对 LLM 返回的 tension_pairs 做「概念名原文校验 + 端点形态兜底 + 结构兜底」
  // 实现：① 非数组 → []；② 单对缺 a/b 端点 → 丢弃该对；③ a/b 的 name 走 _enforceVerbatimNames，
  //      任一端被剔除 → 整对剔除；④ 端点形态校验（SubTask 9.4）：name 含句读标点 或 长度 > 16 →
  //      整对剔除（防"分句器"把长从句当端点名）；⑤ 其余展示字段（id/kind/line/note）缺失时补 null（id 缺失时补 T{n}）
  _cleanTensionPairs(pairs, target) {
    if (!Array.isArray(pairs)) return [];
    // 端点形态判据（SubTask 9.4，宽松阈值，避免误杀合法短词块）：
    //   句读标点 = 中英文逗号/顿号/句号/分号/冒号/问号/叹号（不含括号、引号，故 Riffgine(即兴引擎) 这类品牌名不会被误杀）
    const punctuationRe = /[，,。.、；;：:？?！!]/;
    //   长度上限 16：不误杀「认知增强或永生手段」(9)、「Riffgine(即兴引擎)」(14) 这类合法短词块
    const MAX_ENDPOINT_LEN = 16;
    const cleaned = [];
    for (const pair of pairs) {
      if (!pair || typeof pair !== 'object') continue;
      if (!pair.a || typeof pair.a !== 'object' || !pair.b || typeof pair.b !== 'object') continue;
      const keptA = this._enforceVerbatimNames([pair.a], target);
      const keptB = this._enforceVerbatimNames([pair.b], target);
      if (keptA.length === 0 || keptB.length === 0) continue;   // 任一端定位不到原文 → 整对剔除
      const a = keptA[0];
      const b = keptB[0];
      // SubTask 9.4：端点形态兜底——含句读标点 或 过长 → 整对剔除（与"端点无法定位"同口径，宁少勿凑）
      const badEndpoint = [a, b].find(ep => {
        const nm = typeof ep.name === 'string' ? ep.name : '';
        return punctuationRe.test(nm) || nm.length > MAX_ENDPOINT_LEN;
      });
      if (badEndpoint) {
        // 仅记日志便于排查，不透给前端、不抛异常
        this.log(`tension pair dropped (bad endpoint form): "${badEndpoint.name}"`);
        continue;
      }
      cleaned.push({
        id: (typeof pair.id === 'string' && pair.id.trim()) ? pair.id.trim() : `T${cleaned.length + 1}`,
        a: {
          name: a.name,
          evidence: (typeof a.evidence === 'string') ? a.evidence
            : ((typeof a.source_evidence === 'string') ? a.source_evidence : '')
        },
        b: {
          name: b.name,
          evidence: (typeof b.evidence === 'string') ? b.evidence
            : ((typeof b.source_evidence === 'string') ? b.source_evidence : '')
        },
        kind: (pair.kind === 'oppose' || pair.kind === 'gap') ? pair.kind : null,
        line: typeof pair.line === 'string' ? pair.line : null,
        note: typeof pair.note === 'string' ? pair.note : null
      });
    }
    return cleaned;
  }

  // 由「用户保留的张力对」构建概念地图（代码权威，不依赖 LLM）
  // 功能：把 1..N 对张力对映射为 concepts（id 按 A/B/C… 顺序分配、同一 name 复用同一 id、总数受 MAX_CONCEPTS 约束）
  //      与**单个** fusion 节点（id 形如 A×B×C×D、of 为全部参与概念 id）
  // 实现：逐对逐端登记概念；fusion 的 kind/line 取第一对的值（多对时可为 null，但字段必须存在）
  // 返回：合法的 concept_map；无法构建出任何概念时返回 null（由调用方降级）
  _buildMapFromTensionPairs(keptPairs, target) {
    const pairs = Array.isArray(keptPairs) ? keptPairs : [];
    const concepts = [];
    const idByName = new Map();   // name → id（同一 name 在多对中出现时复用同一 id，避免重复提问）
    let firstPair = null;         // fusion 的 kind/line 取第一对
    for (const pair of pairs) {
      if (!pair || typeof pair !== 'object' || !pair.a || !pair.b) continue;
      const keptA = this._enforceVerbatimNames([pair.a], target);
      const keptB = this._enforceVerbatimNames([pair.b], target);
      if (keptA.length === 0 || keptB.length === 0) continue;
      if (!firstPair) firstPair = pair;
      for (const ep of [keptA[0], keptB[0]]) {
        const name = typeof ep.name === 'string' ? ep.name.trim() : '';
        if (!name) continue;
        if (idByName.has(name)) continue;   // 同名复用同一 id，不重复建节点
        if (concepts.length >= CONCEPT_MAP_LIMITS.MAX_CONCEPTS) continue;   // 超出上限部分丢弃
        const id = String.fromCharCode(65 + concepts.length);   // 0→A, 1→B, 2→C ...
        idByName.set(name, id);
        concepts.push({
          id,
          name,
          source_evidence: (typeof ep.evidence === 'string') ? ep.evidence
            : ((typeof ep.source_evidence === 'string') ? ep.source_evidence : ''),
          status: 'uncovered',
          dimension: null,   // 由 LLM 填
          asked: false
        });
      }
    }
    if (concepts.length === 0) return null;   // 无任何可用概念 → 交由调用方降级
    return {
      mode: 'multi',
      concepts,
      fusion: {
        id: concepts.map(c => c.id).join('×'),
        of: concepts.map(c => c.id),
        kind: (firstPair && (firstPair.kind === 'oppose' || firstPair.kind === 'gap')) ? firstPair.kind : null,
        name: concepts.map(c => c.name).join(' × '),
        line: (firstPair && typeof firstPair.line === 'string') ? firstPair.line : null,
        status: 'uncovered'
      },
      coverage: { total: concepts.length, covered: 0, skipped: 0, done: false }
    };
  }

  // 权威覆盖（带张力对的 initial 响应）
  // 功能：以代码构建的地图为唯一事实来源覆盖 LLM 回显结果，只保留 LLM 提供的 dimension
  // 实现：① LLM 完全没回显可用地图 → 直接用代码地图（绝不回退为"照抄 LLM"）；
  //      ② 逐概念按 id 匹配，取 LLM 的 dimension（缺失/非法 → null，绝不编造），其余字段一律用代码值；
  //      ③ fusion 全部用代码值
  _applyAuthoritativeMap(parsed, builtMap) {
    if (!parsed || typeof parsed !== 'object' || !builtMap) return parsed;
    const llmMap = (parsed.concept_map && typeof parsed.concept_map === 'object') ? parsed.concept_map : null;
    const llmConcepts = (llmMap && Array.isArray(llmMap.concepts)) ? llmMap.concepts : null;
    if (!llmConcepts) {
      parsed.concept_map = builtMap;   // LLM 未回显 → 直接用代码地图
      return parsed;
    }
    const llmById = new Map();
    for (const c of llmConcepts) {
      if (c && typeof c === 'object' && typeof c.id === 'string') llmById.set(c.id, c);
    }
    const concepts = builtMap.concepts.map(bc => {
      const llm = llmById.get(bc.id);
      const dim = (llm && typeof llm.dimension === 'string' && llm.dimension.trim())
        ? llm.dimension.trim()
        : null;   // LLM 漏给 → null，不编造
      return { ...bc, dimension: dim };
    });
    parsed.concept_map = {
      mode: builtMap.mode,
      concepts,
      fusion: builtMap.fusion,
      coverage: { total: concepts.length, covered: 0, skipped: 0, done: false }
    };
    return parsed;
  }

  // 覆盖基类 _parseJSON（SubTask 9.1）
  // 功能：LLM 返回的 JSON 里，字符串值可能含**裸控制字符**（未转义的换行等），令基类的 JSON.parse 与贪婪匹配全部失败。
  //       这里在基类失败后，用 _repairJsonControlChars 修复控制字符再解析一次。
  // 实现：① 先调 super._parseJSON(content)；成功或非"解析失败"形态 → 原样返回；
  //      ② 失败（带 error）→ 修复后先整体 JSON.parse，再退回"提取 {...} 块"（与基类同策略，兼容 ```json 围栏）；
  //      ③ 仍失败 → 返回基类的失败形态（调用方据此判断），绝不抛异常。
  // 说明：只覆盖本 Agent 的解析入口，基类不动（其它 Agent 行为不受影响）；三处调用（run 主解析 / single 守卫二次解析 /
  //       tension 重试）共用本方法，成功时一律返回"对象"，失败时一律返回"带 error 的形态"，既有逻辑不依赖失败细节。
  _parseJSON(content) {
    const baseResult = super._parseJSON(content);
    // 解析成功，或不是"解析失败"形态（如空内容的 { raw: '' }）→ 原样返回
    if (!baseResult || typeof baseResult !== 'object' || typeof baseResult.error !== 'string') {
      return baseResult;
    }
    try {
      const repaired = this._repairJsonControlChars(content);
      if (repaired) {
        try {
          return JSON.parse(repaired);
        } catch { /* 退回花括号块提取 */ }
        const match = repaired.match(/\{[\s\S]*\}/);
        if (match) {
          try { return JSON.parse(match[0]); } catch { /* fallthrough */ }
        }
      }
    } catch (repairErr) {
      console.warn('[CrystallizeAgent] JSON repair failed:', repairErr.message);
    }
    return baseResult;   // 修复仍失败 → 保持基类失败形态
  }

  // 修复 JSON 文本中"字符串字面量内部的裸控制字符"（SubTask 9.1）
  // 功能：把字符串值里未转义的换行/回车/制表符替换成转义形式，让 JSON.parse 能通过
  // 实现：逐字符扫描；用 inString 标记当前是否处于字符串字面量内；用 escaped 标记上一个字符是否为未配对的转义反斜杠
  //       （正确处理 \\ 与 \"）；只在字符串内部替换裸控制字符，字符串外的结构字符与空白原样保留。
  // 说明：只解决"字符串内裸控制字符"这一个确定性问题，不做其它脆弱的正则清洗（如 /^\s*[A-Za-z_]/ 之类）
  _repairJsonControlChars(text) {
    const src = typeof text === 'string' ? text : '';
    if (!src) return src;
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inString) {
        if (escaped) {          // 当前字符已被前一个反斜杠转义 → 原样保留（覆盖 \\ 与 \"）
          out += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {      // 转义起始
          out += ch;
          escaped = true;
          continue;
        }
        if (ch === '"') {       // 字符串结束
          out += ch;
          inString = false;
          continue;
        }
        if (ch === '\n') {      // 字符串内裸换行 → 转义为 \n
          out += '\\n';
          continue;
        }
        if (ch === '\r') {      // 字符串内裸回车 → 转义为 \r
          out += '\\r';
          continue;
        }
        if (ch === '\t') {      // 字符串内裸制表符 → 转义为 \t
          out += '\\t';
          continue;
        }
        out += ch;
        continue;
      }
      if (ch === '"') {         // 进入字符串字面量
        out += ch;
        inString = true;
        escaped = false;
        continue;
      }
      out += ch;
    }
    return out;
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

  // 按 stage 构建不同 prompt（K4 改造版 + 概念地图引擎 + v2 张力对）
  // 功能：根据结晶阶段 + 灵感类型 + 胶囊决策 + 概念地图 + 张力对生成对应的 prompt 文本
  // 实现方式（v2）：
  //   - tension: 只做"找张力对"——返回 tension_pairs + no_tension_reason；不配维度、不出题、不产融合描述
  //   - initial: 概念地图由**代码**构建，LLM 只「为每个概念分配 1 个维度 + 生成首题」；
  //              请求带 tensionPairs 时直接给出代码构建好的地图并要求原样回显；
  //              不带 tensionPairs 时退回单概念路径（枚举 1 个原文原词概念，mode:'single'、fusion:null）
  //   - questioning: 沿回显的 concept_map 逐题推进（未覆盖概念出题 → 融合题 → 检查点）；无地图时降级旧行为
  //   - generate_crystal: 注入 concept_map，要求 crystal 产出 fusion 元字段（multi 模式，insight 写 2-3 句）
  //   - 默认 fallback: 当作 initial 处理
  // K4 改造：
  //   - 维度配置从 TYPE_DIMENSIONS 取用，options 从 DIMENSION_POOL 取用
  //   - 新增 capsuleDecision 参数，'use' 时走差异化提问（剔除胶囊已预填的维度）
  //   - crystal 字段结构从 TYPE_BRANCHES 的 baseFields/dynamicFields/metaFields/aiInferredFields 推导
  // 概念地图改造：
  //   - 新增 conceptMap / checkpointInput 参数
  //   - 问题 = 概念 × 维度；广度由概念地图静态规划，深度由「以上一次回答为材料改写问题文本」保证
  // Task 8 加固：
  //   - 新增 answeredConcept 参数：用于在提示词中准确告知「上一题针对的目标」（地图已被代码预先标记为 covered，
  //     若仍按"首个未覆盖概念"推断会错位到下一个概念）
  // v2 新增 tensionPairs 参数：用户保留的张力对（仅 stage='initial' 使用；代码据此构建概念地图并嵌进提示词）
  _buildPrompt(target, stage, draft, conversationHistory, inspirationType, branch, capsuleDecision = null, detectedCapsules = [], conceptMap = null, checkpointInput = null, answeredConcept = null, tensionPairs = null) {
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

    // tension 阶段（v2 新增）：只做一件事——从灵感原文里找出「互相拉扯」的点对
    // 功能：不分配维度、不出题、不产出融合描述；只返回 tension_pairs（可为空）+ no_tension_reason
    // 实现：写明两型判据（A 型「X 却 Y」/ B 型「可命名的整体 ↔ 具体机制」）+ 不可迁移门槛 + 反例清单
    //      反例清单是本项目经验：不给反例，模型一定会偷懒（逐句抄 + 造词）
    // SubTask 9.3 强化（实跑证明"找张力对"会被当成必须产出，决策 2 的 δ 出口在实机上不成立）：
    //   - 开篇明确"默认答案是空数组"（返回空是正常且被期待的结果，凑数才是失败）
    //   - 写入三条真实踩过的坑（同义反复 / 并列属性 / 同一句内前后件），逐条说明为什么不合格
    //   - 增加强制的"迁移自检"段落 + 每对 `migration` 留痕字段（想得出可迁移场景就必须删掉该对）
    // SubTask 9.4 形态约束（实跑出现端点变成带顿号的长从句，"分句器"气味）：
    //   - 提示词要求端点必须是**短词块**（≤12 字为宜、不含句读标点、不是整句/长从句），并附实跑反例与合格正例
    //   - 代码侧 _cleanTensionPairs 兜底：端点含句读标点 或 长度 > 16 → 整对剔除（仅记日志）
    if (stage === 'tension') {
      return `从下面这段灵感原文中，找出 2-${CONCEPT_MAP_LIMITS.MAX_FUSION_PAIRS} 个**互相拉扯**的点对。本轮你只做这一件事：不要分配维度，不要出题，不要写融合描述。

灵感原文：
${target}

## 先说清楚：默认答案是空数组
**大多数灵感里并不存在真正的张力对**。\`tension_pairs\` 返回空数组 \`[]\` 是本任务**正常且被期待**的结果，
不会被视为失败；反过来，为了"有产出"而凑数才是失败——凑出来的假张力会污染后续提问，比返回空更糟。
所以：找不到就返回空，并在 \`no_tension_reason\` 里一句话说明"这篇里没有互相拉扯的点"。

## 什么才算"真张力"（必须满足两型之一 + 通过不可迁移门槛）
两型（任一即可）：
- **A 型 · 对立拉扯**：两端方向相反、互相顶，能写成一句「X 却 Y」。
- **B 型 · 落差**：一端是**可被命名的整体**，另一端是**具体机制**，能写成一句「它叫 X，做的却是 Y」。
  · **自称名优先**：如果灵感里（尤其是标题）给了这个东西一个**自称的名字**（例如标题 \`Riffgine(即兴引擎)\` 里的「即兴引擎」），
    B 型的「可命名的整体」一端**优先取这个名字**，而不是取整句描述。

不可迁移门槛（必须通过）：
- 把两端任一端的词换掉，这句话就不成立；
- 如果这句话能原样套到另一个不相关的灵感上 → **不算张力**，不要输出。

## 反例清单（违反即视为失败）
1. **禁止逐句抄**：不要把原文相邻的句子各抄一条凑成平级列表。例如把 Riffgine 原文的 5 句话各抄成一个"概念"——那是复述，不是张力。
2. **禁止改写或自造原文没有的词**：例如把标题里的"即兴引擎"改写成"规则驱动的乐句生成引擎"，或造出原文中根本不存在的"极简"。
3. **凑不出就返回空数组**：如果原文里确实没有互相拉扯的点（例如只是一句线性陈述），\`tension_pairs\` 返回 \`[]\`，并在 \`no_tension_reason\` 里用一句话说明原因。**禁止硬凑**。

### 真实踩过的坑（下面三条是实跑中出现过的**不合格输出**，逐条说明了为什么不合格——不要重复它们）
1. **同义反复**：\`按钮 × 把当前页面导出成 PDF\` —— 不合格。任何按钮都在"做某事"，「它叫按钮，做的却是导出 PDF」套到任何按钮类产品都成立，两端并没有互相顶。
2. **并列属性**：\`墨绿色 × 米黄色\` —— 不合格。这只是两个平级的颜色属性，谁都不反对谁，仅仅是并列，不是拉扯。
3. **同一句内的前后件**：\`每天随手记的碎片 × 汇总成一份清单\` —— 不合格。两端取自同一句话，是顺承/同义关系，不是两个各自独立成立、互相拉扯的点。

## 输出前必须逐对做的"迁移自检"（强制，不得跳过）
对**每一个**候选对，先自问：**"我能想出一个不相关的灵感，让这句 line 也成立吗？"**
- 只要想得出 → **必须把这一对删掉**（在写进 JSON 之前就删，不要输出）；
- 想不出 → 保留，并在该对的 \`migration\` 字段写 \`"无：套不过去"\` + 一句"为什么套不过去"；
- 若所有候选都在自检中被删光 → \`tension_pairs\` 返回 \`[]\`，并在 \`no_tension_reason\` 里一句话说明"这篇里没有互相拉扯的点"。
（\`migration\` 是给你自己留的判断痕迹，前端不展示；但它是**强制项**，不许省略、不许空着。）

## 硬性要求
- a.name / b.name **必须是灵感原文的连续片段**（原文原词，不加工、不改写、不自造）；
- **端点必须是短词块**（不是一句描述）：
  · 每个端点（a.name / b.name）**≤ 12 字为宜**，且**不得含逗号 / 顿号 / 句号 / 分号 / 冒号 / 问号 / 叹号等句读标点**；
  · **不得是整句或带标点的长从句**；端点应当是"**能被独立命名、能被指着说的东西**"——一个东西、一种机制、一种角色、一个动作；
  · 原文里找不到这样的短词块来表达某一端 → **放弃这一对**（宁少勿凑，与上面的"默认答案是空"一致）；
  · 反例（实跑产出，不合格）：\`不保存事件的时间、地点、人物等原始信息\` —— 带顿号的长从句，是描述不是名字；
  · 正例（真实产出，合格）：\`即兴引擎\`、\`规则驱动\`、\`认知增强或永生手段\`、\`数字奴役机制\`。
- a.evidence / b.evidence 给出该端在原文中出现的原句或关键词；
- line 写成那句「X 却 Y」（要能直接读出来）；
- note 说明为什么它套不到别的灵感（不可迁移）；
- **每对必须带 \`migration\` 字段**：迁移自检想得出可套用的场景 → 该对已删除，不出现；能保留的写 \`"无：套不过去"\` + 一句为什么；
- kind 只能取 "oppose"（对立拉扯）或 "gap"（落差）；
- **所有字符串值必须是单行**：不得在字符串内部换行（\`note\` 写成长句即可，不要分段、不要用换行排版）；
- 对数上限 ${CONCEPT_MAP_LIMITS.MAX_FUSION_PAIRS} 对，宁少勿凑。

## 返回 JSON 格式（严格遵守）
{
  "stage": "tension",
  "tension_pairs": [
    {
      "id": "T1",
      "a": {"name": "原文原词", "evidence": "原文中该词所在的句子或关键词"},
      "b": {"name": "原文原词", "evidence": "原文中该词所在的句子或关键词"},
      "kind": "oppose",
      "line": "它叫 X，可背后是 Y",
      "note": "把 X 换成别的词，这句话就不成立了",
      "migration": "无：套不过去（换成别的灵感，这句话就散了）"
    }
  ],
  "no_tension_reason": null
}

注意：必须返回 stage="tension"；**返回空 tension_pairs 是合格且被期待的结果**（此时 no_tension_reason 为非空字符串）；
有张力对时 no_tension_reason 为 null，且每对必须带 migration 字段；**所有字符串值写成单行**、内部不得出现未转义的换行（否则无法被解析）；
不要返回 concept_map，不要返回题目，不要返回 crystal。`;
    }

    // initial 阶段（v2 张力对版）：概念地图由代码构建，LLM 只做「配维度 + 出首题」
    // 两个路径：
    //   路径 A（请求带 tensionPairs 且长度 ≥1）：代码用 _buildMapFromTensionPairs 构建整张地图并直接写进提示词，
    //          LLM 只分配维度 + 出首题，并原样回显地图；响应后由 _applyAuthoritativeMap 做权威覆盖（模型不得改写概念）
    //   路径 B（请求不带 tensionPairs）：退回单概念路径——枚举 1 个原文原词概念 + 分配维度 + 出首题，
    //          mode 必须为 "single"、fusion 必须为 null
    // 两个路径均保留既有约束：只生成 1 个问题、不生成补充题、复用维度池段落（buildDimensionSection）与选题规则
    if (stage === 'initial') {
      const requiredSections = activeRequiredDims.map(buildDimensionSection).join('\n\n');
      const optionalSections = activeOptionalDims.map(buildDimensionSection).join('\n\n');

      // 胶囊预填说明段落（K4：使用胶囊时只问差异点，不复述胶囊已给出的维度）
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

胶囊已承担了大部分具象化工作，用户只需补"差异点"。
`;
      }

      // 公共段落：维度池 + 选题规则（两路径复用，保证「维度池段落段与选题规则照旧」）
      const dimensionPoolSection = `## 维度池（分配维度的唯一来源）
### 必选维度
${requiredSections}

### 可选维度
${optionalSections}
`;

      // 路径 A：请求带张力对 → 概念地图已由代码构建，LLM 只配维度 + 出首题
      // 判定：tensionPairs 为数组且长度 ≥1；地图由 _buildMapFromTensionPairs 代码构建
      const hasTension = Array.isArray(tensionPairs) && tensionPairs.length >= 1;
      const presetMap = hasTension ? this._buildMapFromTensionPairs(tensionPairs, target) : null;
      if (presetMap && Array.isArray(presetMap.concepts) && presetMap.concepts.length > 0) {
        return `分析以下灵感。张力对已经由前置步骤确定，概念地图也已经由系统构建完成。
本轮你只做两件事：① 为地图中的每个概念分配 1 个最贴切的维度；② 生成第 1 题。不要增删或改写概念地图。

灵感内容：
${target}

## 当前灵感类型
${inspirationType}（目标结晶形态：${branch.crystalType}）
${capsuleSection}
## 已确定的概念地图（必须原样回显，id / name / source_evidence / status / asked 一个字都不能改）
${JSON.stringify(presetMap, null, 2)}

## 你必须完成的两件事
1. **分配维度**：为 concepts 中的每个概念，从下面的维度池中分配 **1 个**最贴切的"大维度名"，填进 concept_map.concepts[].dimension（与概念 id 一一对应，不得漏配）。
2. **生成第 1 题**：只为 concepts[0] 生成 1 个追问问题，带 target_concept="${presetMap.concepts[0].id}"。

## 机制说明
- 大维度是该类型追问的元层级（如"产品形态""核心价值"），每个大维度下有多个小维度，带【定义】与【判断信号】
- 概念轴已由张力对固定，你只负责"问什么角度"：每个概念只配 1 个维度

${dimensionPoolSection}
## 选题规则
1. 每个概念只分配 1 个维度，维度尽量不重复（概念数多于维度时，从可选维度中继续取）。
2. 概念与维度的匹配必须依据灵感原文与该维度的【定义】【判断信号】，不要随机分配。
3. 第 1 题针对 concepts[0]，问题文本必须锚定它的 source_evidence。

## 问题文本质量约束（必须严格遵守，违反将导致用户困惑）
1. **必须紧扣灵感原文**：问题文本要直接引用原文的具体表述或关键词（如"你提到 XX，这里想搞清楚……"）。
2. **禁止脱离原文空问**：不允许问"你希望它是什么样的？""你想要什么感觉？"这类脱离原文的空泛问题。
3. **选项要具体且与原文相关**：给 4-5 个基于原文可推断的具象选项，不要抽象的"是/否/其他"选项。
4. **只生成 1 个问题**：不要生成批量问题；不要生成补充题（选做补充题职能已由检查点机制承接，key 不得为 "_supplement"）。
5. **说得明白（重要）**：题干必须让一个完全没背景的人读懂——不许用定义不明的抽象词（如"机制""范式""张力"若不解释）；如果这题依赖某个概念，直接把那个概念的名字点出来；宁可多写半句，也不要让用户猜你在问什么。**简洁不等于含混**。

## 返回 JSON 格式（严格遵守）
{
  "stage": "A",
  "concept_mode": "multi",
  "concept_map": {
    "mode": "multi",
    "concepts": [
      {"id": "A", "name": "原样回显给定地图的 name", "source_evidence": "原样回显", "status": "uncovered", "dimension": "大维度名", "asked": false}
    ],
    "fusion": {"id": "A×B", "of": ["A", "B"], "kind": "oppose", "name": "原样回显", "line": "原样回显", "status": "uncovered"},
    "coverage": {"total": 2, "covered": 0, "skipped": 0, "done": false}
  },
  "selected_dimensions": [
    {"大维度": "维度名", "小维度": "选项 id + label", "理由": "为什么这个维度与该概念相关（一句话）", "concept": "A"}
  ],
  "clarifying_questions": [
    {
      "id": 1,
      "text": "问题文本（开头体现与灵感原文的连接，如'你提到 XX，这里想搞清楚...'）",
      "multi": false,
      "options": ["具象选项1（与原文相关）", "选项2", "选项3", "选项4"],
      "key": "对应 crystalField 名",
      "source_dimension": "A2 / B2 / C / ...",
      "target_concept": "${presetMap.concepts[0].id}"
    }
  ]
}

注意：必须返回 stage="A"；concept_map 必须原样回显上面给定的地图（id/name/source_evidence/status/asked 不得改动），只允许填 dimension；
clarifying_questions 长度必须为 1；不要返回 crystal，不要返回补充题。`;
      }

      // 路径 B：请求不带张力对 → 退回单概念（枚举 1 个原文原词概念 + 分配维度 + 出首题）
      return `分析以下灵感，只提炼出 1 个最能代表它的概念，为它分配 1 个追问维度，最后只生成第 1 题的最终文本。

灵感内容：
${target}

## 当前灵感类型
${inspirationType}（目标结晶形态：${branch.crystalType}）
${capsuleSection}
## 你必须完成三件事
1. **枚举 1 个概念**：从灵感中提炼出**唯一一个**最能代表它的概念。
   - name **必须是灵感原文中的连续片段**（原文原词或短语，不得改写、不得自造原文没有的词）。
   - 给出 source_evidence：灵感原文中支撑该概念的**一句原话或关键词**。
2. **分配维度**：为该概念从下面的维度池中分配 **1 个**最贴切的"大维度名"（填"大维度名"），作为它的追问角度。
3. **生成第 1 题**：为该概念生成 1 个追问问题，带 target_concept="A"。

## 机制说明
- 大维度是该类型追问的元层级（如"产品形态""核心价值"），每个大维度下有多个小维度，带【定义】与【判断信号】

${dimensionPoolSection}
## 选题规则
1. 该概念只分配 1 个维度。
2. 概念与维度的匹配必须依据灵感原文与该维度的【定义】【判断信号】，不要随机分配。
3. 第 1 题必须锚定该概念的 source_evidence。

## 问题文本质量约束（必须严格遵守，违反将导致用户困惑）
1. **必须紧扣灵感原文**：问题文本要直接引用原文的具体表述或关键词（如"你提到 XX，这里想搞清楚……"）。
2. **禁止脱离原文空问**：不允许问"你希望它是什么样的？""你想要什么感觉？"这类脱离原文的空泛问题。
3. **选项要具体且与原文相关**：给 4-5 个基于原文可推断的具象选项，不要抽象的"是/否/其他"选项。
4. **只生成 1 个问题**：不要生成批量问题；不要生成补充题（选做补充题职能已由检查点机制承接，key 不得为 "_supplement"）。
5. **说得明白（重要）**：题干必须让一个完全没背景的人读懂——不许用定义不明的抽象词（如"机制""范式""张力"若不解释）；如果这题依赖某个概念，直接把那个概念的名字点出来；宁可多写半句，也不要让用户猜你在问什么。**简洁不等于含混**。

## 返回 JSON 格式（严格遵守）
{
  "stage": "A",
  "concept_mode": "single",
  "concept_map": {
    "mode": "single",
    "concepts": [
      {"id": "A", "name": "原文原词", "source_evidence": "原文中支撑该概念的一句原话或关键词", "status": "uncovered", "dimension": "大维度名", "asked": false}
    ],
    "fusion": null,
    "coverage": {"total": 1, "covered": 0, "skipped": 0, "done": false}
  },
  "selected_dimensions": [
    {"大维度": "维度名", "小维度": "选项 id + label", "理由": "为什么这个维度与该概念相关（一句话）", "concept": "A"}
  ],
  "clarifying_questions": [
    {
      "id": 1,
      "text": "问题文本（开头体现与灵感原文的连接，如'你提到 XX，这里想搞清楚...'）",
      "multi": false,
      "options": ["具象选项1（与原文相关）", "选项2", "选项3", "选项4"],
      "key": "对应 crystalField 名",
      "source_dimension": "A2 / B2 / C / ...",
      "target_concept": "A"
    }
  ]
}

注意：必须返回 stage="A"；concept_mode 必须为 "single"；fusion 必须为 null；concepts 长度必须为 1；
所有 concept 的 asked 均为 false；name 必须是灵感原文的连续片段；clarifying_questions 长度必须为 1；
不要返回 crystal，不要返回补充题。`;
    }

    // questioning 阶段：沿概念地图逐题执行（概念地图版，Task 2.3 / 2.5）
    // 功能：① 更新被答概念的覆盖状态 ② 选下一个未覆盖概念出题（文本须以上一次回答为材料改写）
    //      ③ 概念全覆盖后出融合题（target_concept="A×B"）④ 概念与融合题都问完则返回 stage:"checkpoint"
    //      checkpointInput 非空时登记为新概念节点并出题（stage:"B"）；mode="single" 且已覆盖时直接生成晶体（stage:"C"，不出检查点）
    // 降级：无 conceptMap（旧数据 / 旧前端）时保留原「动态一题一答」提示词
    if (stage === 'questioning') {
      if (conceptMap && Array.isArray(conceptMap.concepts) && conceptMap.concepts.length > 0) {
        // 代码侧兜底：把检查点补充的方向登记为新概念节点（status="uncovered"）
        // 说明：节点登记由代码保证，LLM 只负责回显完整地图 + 分配维度 + 出题
        const checkpointText = typeof checkpointInput === 'string' ? checkpointInput.trim() : '';
        let workingMap = conceptMap;
        if (checkpointText && conceptMap.concepts.length < CONCEPT_MAP_LIMITS.MAX_CONCEPTS) {
          const usedIds = new Set(conceptMap.concepts.map(c => String((c && c.id) || '')));
          let newId = 'A';
          for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
            if (!usedIds.has(ch)) { newId = ch; break; }
          }
          const concepts = [
            ...conceptMap.concepts,
            {
              id: newId,
              name: checkpointText.slice(0, 40),
              source_evidence: '用户在检查点补充的方向',
              status: 'uncovered',
              dimension: null,
              asked: false
            }
          ];
          const prevCoverage = conceptMap.coverage || {};
          workingMap = {
            ...conceptMap,
            concepts,
            coverage: {
              total: concepts.length,
              covered: prevCoverage.covered || 0,
              skipped: prevCoverage.skipped || 0,
              done: false
            }
          };
        }

        // 推断「上一题针对的目标」：
        //   优先用代码传入的 answeredConcept（Task 8：地图已被代码预先标记为 covered，纯按"首个未覆盖者"推断会错位）
        //   回退推断：概念按数组顺序依次提问，第一个未被覆盖者即上一题目标；概念全部覆盖后，融合节点即上一题目标
        //   （融合节点在其「被回答」的那一轮才置 covered）
        const pending = workingMap.concepts.find(c => c && c.status !== 'covered' && c.status !== 'skipped') || null;
        const fusionNode = workingMap.fusion || null;
        const fusionFinished = !fusionNode || fusionNode.status === 'covered' || fusionNode.status === 'skipped';
        const inferredTarget = pending ? (pending.id || null) : (!fusionFinished ? (fusionNode.id || 'A×B') : null);
        const lastTarget = (typeof answeredConcept === 'string' && answeredConcept.trim())
          ? answeredConcept.trim()
          : inferredTarget;
        const isMulti = workingMap.mode === 'multi' || workingMap.concepts.length >= 2;

        // 上限判定：概念数已达 MAX_CONCEPTS 时，代码侧不再追加新节点，提示词措辞也必须改为"不可追加"
        const atConceptLimit = !!checkpointText && conceptMap.concepts.length >= CONCEPT_MAP_LIMITS.MAX_CONCEPTS;
        const checkpointSection = checkpointText
          ? (atConceptLimit
              ? `
## 用户在检查点补充的新方向
"${checkpointText}"
概念数已达上限（${CONCEPT_MAP_LIMITS.MAX_CONCEPTS} 个），**不可**再追加新的概念节点（代码已不再追加）。
请把该补充方向并入最相关的已有概念（不新增节点），并针对该概念出题（返回 stage:"B"）。
`
              : `
## 用户在检查点补充的新方向
"${checkpointText}"
该方向已作为新概念节点追加到概念地图末尾（source_evidence 固定为"用户在检查点补充的方向"，status 为 "uncovered"）。
请保留该节点、为它分配 1 个维度，并针对它出题（返回 stage:"B"）。
`)
          : '';

        return `沿"概念地图"推进追问。本轮你要完成：① 更新上一题针对目标的覆盖状态 ② 按地图顺序选下一个未覆盖概念出题 ③ 概念全覆盖后出融合题 ④ 概念与融合题都问完则返回检查点。

灵感原文：
${target}

当前灵感类型：${inspirationType}（目标结晶形态：${branch.crystalType}）

## 概念地图（本轮进度基准，更新后需原样回显）
${JSON.stringify(workingMap, null, 2)}

## 对话历史（含上一轮问题与用户最新回答）
${JSON.stringify(conversationHistory, null, 2)}
${checkpointSection}
## 上一题针对的目标
${lastTarget ? `"${lastTarget}"` : '（无：本轮为检查点补充新方向，或地图已走完）'}

## 执行规则（按顺序判断）
1. **更新状态**：读用户最新回答，把上一题针对的概念（或融合节点）状态更新为：
   - "covered"：回答已足够支撑结晶，同时把它的 asked 置为 true
   - "partial"：回答有价值但仍需再补一轮（下一轮继续问这个概念），asked 置为 true
   - 已经是 "covered" / "skipped" 的状态不要回退
2. **选下一个目标**（严格按 concepts 数组顺序，不得跳序，不得重复问已 covered 的概念）：
   - 若存在 status 不为 "covered"/"skipped" 的概念 → 出该概念的题
   - 否则若存在融合节点且其 status 不为 "covered" → 出融合题（target_concept 为融合节点 id，形如 "A×B"）
   - 否则 → 返回检查点（见下方 C 分支）
3. **单概念特例**：若 mode 为 "single" 且唯一概念已 covered → 直接生成结晶（返回 stage:"C" + crystal），**不得返回检查点**。
4. **融合节点状态**：融合节点在其被**回答**的那一轮才置 "covered"（仅被问出、用户尚未回答时保持 "uncovered"）。
5. 出题时把该题针对目标（概念或融合节点）的 asked 置为 true。

## 问题文本质量约束（必须严格遵守，违反将导致用户困惑）
1. **以上一次回答为材料改写**：本题文本必须引用用户上一轮回答中的具体内容（如"你刚才说 XX，那……"），**禁止套用固定模板**，禁止与上一题文本雷同。
2. **锚定目标概念**：本题必须围绕 target_concept 的 name 与 source_evidence 提问。
3. **禁止脱离原文空问**：不允许问"你希望它是什么样的？""你想要什么感觉？"这类脱离灵感原文的空泛问题。
4. **禁止揪着不放**：同一概念最多追问一轮（仅当判为 "partial" 时才允许再补一轮）。
5. **一次只问 1 个问题**，给 4-5 个具象选项（融合题同样给选项）。
6. 每题必须输出 target_concept（融合题为融合节点 id，形如 "A×B"）。
7. **说得明白（重要）**：题干必须让一个完全没背景的人读懂——不许用定义不明的抽象词（如"机制""范式""张力"若不解释）；如果这题依赖某个概念，直接把那个概念的名字点出来；宁可多写半句，也不要让用户猜你在问什么。**简洁不等于含混**。

## coverage 维护
- total = concepts 数量（不含融合节点）；covered = status 为 "covered" 的数量；skipped = status 为 "skipped" 的数量
- done = 概念与融合节点均已问完（均 covered/skipped）时为 true，否则 false

## 返回 JSON（三选一，严格遵守）

### A) 继续追问 → stage:"B"
{
  "stage": "B",
  "concept_map": { ...更新后的完整地图（含全部 concepts + fusion + coverage）... },
  "next_target": "下一题针对的目标 id（融合题为 A×B）",
  "clarifying_questions": [
    {
      "id": 2,
      "text": "以上一次回答为材料改写的问题文本",
      "multi": false,
      "options": ["具象选项1（与上下文相关）", "选项2", "选项3", "选项4"],
      "key": "field_name",
      "source_dimension": "A2 / B2 / C / ...",
      "target_concept": "目标 id"
    }
  ]
}

### B) 生成结晶 → stage:"C"（仅规则 3 命中时）
{
  "stage": "C",
  "concept_map": {...},
  "crystal": {
    ${branch.baseFields.map(f => `"${f}": "..."`).join(',\n    ')}
  },
  "selected_dimensions": [...],
  "detected_capsule": [...],
  "next_agent": "epitaxy"
}

### C) 检查点 → stage:"checkpoint"（概念与融合题均已问完）
{
  "stage": "checkpoint",
  "concept_map": {...coverage.done 置为 true...}
}

## crystal 生成规则（命中 B 分支时）
1. 基础字段必生成：${branch.baseFields.join(', ')}
2. 动态字段按 selected_dimensions 附加：${(branch.dynamicFields || []).join(', ')}
3. 元字段 LLM 主动推断：${(branch.metaFields || []).join(', ')}
4. AI 推断字段 LLM 主动判断：${(branch.aiInferredFields || []).join(', ')}
${isMulti
  ? '5. **必须产出 fusion 元字段**：{"of": ["概念id","概念id"], "insight": "2-3 句：两边各是什么 / 怎么共存 / 为什么有意思"}，of 取概念地图 fusion.of（name / line 由系统补齐，你只需写 insight）。\n6. 合并胶囊预填：如果 detected_capsule 非空，把胶囊预填的元素合并到 crystal（用户回答优先于胶囊预填）。'
  : '5. 本灵感为单概念（mode 非 multi），**不要产出 fusion 字段**。\n6. 合并胶囊预填：如果 detected_capsule 非空，把胶囊预填的元素合并到 crystal（用户回答优先于胶囊预填）。'}

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

      // ===== 降级路径：无 conceptMap（旧数据 / 旧前端）→ 保留原「动态一题一答」提示词 =====
      // SubTask 8.5：删除此处未使用的 supplementText 死变量（该降级提示词不引用补充题文案）
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
8. **说得明白（重要）**：题干必须让一个完全没背景的人读懂——不许用定义不明的抽象词（如"机制""范式""张力"若不解释）；如果这题依赖某个概念，直接把那个概念的名字点出来；宁可多写半句，也不要让用户猜你在问什么。**简洁不等于含混**。

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
    // 概念地图改造（Task 2.4）：注入 concept_map 信息，明确要求 crystal 产出 fusion 元字段
    //   - multi 模式：必须产出 fusion = { of: [概念id数组], insight: "融合结论" }
    //   - single 模式：不产出 fusion
    if (stage === 'generate_crystal' || stage === 'generate_prd') {
      // 概念地图是否有效且为多概念
      const validConcepts = (conceptMap && Array.isArray(conceptMap.concepts))
        ? conceptMap.concepts.filter(c => c && typeof c === 'object')
        : [];
      const isMulti = validConcepts.length >= 2;
      const conceptSection = validConcepts.length > 0
        ? `## 概念地图（结晶必须覆盖地图上的所有概念）
${JSON.stringify(conceptMap, null, 2)}

`
        : '';
      const fusionRule = isMulti
        ? `5. **融合元字段（必须产出）**：本灵感含多个概念，必须在 crystal 中增加元字段 fusion，结构为 {"of": [概念id数组], "insight": "2-3 句：两边各是什么 / 怎么共存 / 为什么有意思"}；of 取概念地图中 fusion.of（如 ["A","B"]）。name / line 由系统从地图补齐，你只需写 insight（2-3 句）。
6. 合并胶囊预填：如果 detected_capsule 非空，把胶囊预填的元素合并到 crystal（用户回答优先于胶囊预填）。`
        : `5. **不产出 fusion**：本灵感为单概念（mode 非 multi），不要输出 fusion 字段。
6. 合并胶囊预填：如果 detected_capsule 非空，把胶囊预填的元素合并到 crystal（用户回答优先于胶囊预填）。`;

      return `基于以下内容直接生成完整结晶体，跳过追问环节。

灵感内容：
${target}

当前灵感类型：${inspirationType}（目标结晶形态：${branch.crystalType}）

结晶草稿（参考）：
${JSON.stringify(draft, null, 2)}

${conceptSection}## 返回 JSON 格式（crystal 字段结构按类型 + 动态字段 + 元字段）
{
  "stage": "C",
  "crystal": {
    ${branch.baseFields.map(f => `"${f}": "..."`).join(',\n    ')}
  },
  "selected_dimensions": [...],
  "detected_capsule": [...],
  "concept_map": {...原样回显传入的概念地图...},
  "next_agent": "epitaxy"
}

## crystal 生成规则
1. 基础字段必生成：${branch.baseFields.join(', ')}
2. 动态字段按 selected_dimensions 附加：${(branch.dynamicFields || []).join(', ')}
3. 元字段 LLM 主动推断：${(branch.metaFields || []).join(', ')}
4. AI 推断字段 LLM 主动判断：${(branch.aiInferredFields || []).join(', ')}
${fusionRule}

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
