// 结晶流程控制器（M3-b 改造版）
// 功能：处理 HTTP 请求，调用 CrystallizeAgent 和 inspirationStorage，统一响应格式
// 实现方式：每个方法 try/catch，成功返回 { success:true, data }，失败返回 500 { success:false, error }
//
// M3-b 变更：
//   - 新增 sense 方法：感知灵感类型
//   - run 方法接受 inspirationType 参数透传给 Agent
//   - updatePRD 改名为 updateCrystal（保留 updatePRD 别名兼容旧前端）

import CrystallizeAgent from '../agents/crystallizeAgent.js';
import agentHub from '../agents/agentHub.js';
import inspirationStorage from '../services/inspirationStorage.js';
import { get } from '../database/db.js';
import { assertUuid } from '../utils/security.js';

// 感知灵感类型（Sense 阶段）
// 功能：调用 CrystallizeAgent.sense 分析灵感文本，返回类型 + 置信度 + 备选 + 推理
// 实现方式：从 body 或 inspiration 记录取 text，调用静态 sense 方法
// 安全加固（SEC-004）：参数化查询 + UUID 白名单
export async function sense(req, res) {
  try {
    const { id } = req.params;
    assertUuid(id, 'inspiration id');
    // 优先用 body.text，否则从数据库读 inspiration
    let text = req.body?.text;
    if (!text) {
      const row = get('SELECT title, content FROM inspirations WHERE id = ?', [id]);
      if (!row) {
        return res.status(404).json({ success: false, error: 'Inspiration not found' });
      }
      text = row.content || row.title;
    }
    const result = await CrystallizeAgent.sense(id, text);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ success: false, error: e.expose || e.status < 500 ? e.message : '服务器内部错误' });
  }
}

// 运行结晶流程
// 功能：从 body 取参数，调用 CrystallizeAgent.run，返回 Agent 结果
// 实现方式：解构 stage/userInput/crystalDraft/prdDraft/conversationHistory/autoRun/inspirationType
//          + detectedCapsules / capsuleDecision / conceptMap / checkpointInput
// M3-b：透传 inspirationType 给 Agent，支持按类型分支
// 修复 0-2：补解构并透传 detectedCapsules / capsuleDecision（否则 K4 胶囊差异化提问恒收默认值、静默失效）
// 概念地图改造：透传 conceptMap（上一轮地图）与 checkpointInput（检查点补充方向）
// Task 8：透传 answeredConcept（本轮被答的概念 id，供 Agent 代码侧标记已覆盖）
// v2 张力对改造：透传 tensionPairs（用户保留的张力对，initial 用）与 tensionScan（张力扫描留痕，结晶轮回显）
export async function run(req, res) {
  try {
    const { id } = req.params;
    assertUuid(id, 'inspiration id');
    const {
      stage, userInput, crystalDraft, prdDraft, conversationHistory, autoRun, inspirationType,
      detectedCapsules, capsuleDecision, conceptMap, checkpointInput, answeredConcept,
      tensionPairs, tensionScan   // v2 新增：用户保留的张力对 / 张力扫描留痕（结晶轮回显）
    } = req.body;
    const result = await CrystallizeAgent.run({
      inspirationId: id,
      stage: stage || 'initial',
      userInput,
      crystalDraft: crystalDraft || prdDraft || {},
      conversationHistory: conversationHistory || [],
      autoRun: autoRun !== false,
      inspirationType,
      detectedCapsules: detectedCapsules || [],
      capsuleDecision: capsuleDecision || null,
      conceptMap: conceptMap || null,
      checkpointInput: checkpointInput || null,
      answeredConcept: answeredConcept || null,
      tensionPairs: tensionPairs || null,
      tensionScan: tensionScan || null
    });
    res.json(result);
  } catch (e) {
    console.error("[API] 内部错误:", e.message); res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

// 获取最新结晶结果
export async function latest(req, res) {
  try {
    const data = await inspirationStorage.getCrystallizeLatest(req.params.id);
    res.json({ success: true, data });
  } catch (e) {
    console.error("[API] 内部错误:", e.message); res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

// 获取结晶历史
export async function history(req, res) {
  try {
    const data = await inspirationStorage.getCrystallizeHistory(req.params.id);
    res.json({ success: true, data });
  } catch (e) {
    console.error("[API] 内部错误:", e.message); res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

// 更新结晶（M3-b 新名称）
// 功能：更新最新结晶记录的 crystal 字段
// 实现方式：从 body 取 crystal，调用 inspirationStorage.updateCrystallizePRD（方法名保留，字段改为 crystal）
export async function updateCrystal(req, res) {
  try {
    const crystal = req.body.crystal || req.body.prd;
    await inspirationStorage.updateCrystallizePRD(req.params.id, crystal);
    res.json({ success: true });
  } catch (e) {
    console.error("[API] 内部错误:", e.message); res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

// 更新 PRD（保留别名，兼容旧前端）
export async function updatePRD(req, res) {
  return updateCrystal(req, res);
}

// 手动分流
export async function dispatch(req, res) {
  try {
    const { id } = req.params;
    const { targetAgent, crystal, prd } = req.body;
    const result = await agentHub.dispatch(targetAgent, {
      inspirationId: id,
      crystal: crystal || prd
    });
    res.json({ success: true, data: { next_agent: targetAgent, result } });
  } catch (e) {
    console.error("[API] 内部错误:", e.message); res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}
