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

// 感知灵感类型（Sense 阶段）
// 功能：调用 CrystallizeAgent.sense 分析灵感文本，返回类型 + 置信度 + 备选 + 推理
// 实现方式：从 body 或 inspiration 记录取 text，调用静态 sense 方法
export async function sense(req, res) {
  try {
    const { id } = req.params;
    // 优先用 body.text，否则从数据库读 inspiration
    let text = req.body?.text;
    if (!text) {
      const { db } = await import('../database/db.js');
      const rows = db.exec(`SELECT title, content FROM inspirations WHERE id = '${id}'`);
      if (rows.length === 0 || rows[0].values.length === 0) {
        return res.status(404).json({ success: false, error: 'Inspiration not found' });
      }
      const [title, content] = rows[0].values[0];
      text = content || title;
    }
    const result = await CrystallizeAgent.sense(id, text);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 运行结晶流程
// 功能：从 body 取参数，调用 CrystallizeAgent.run，返回 Agent 结果
// 实现方式：解构 stage/userInput/crystalDraft/prdDraft/conversationHistory/autoRun/inspirationType
// M3-b：透传 inspirationType 给 Agent，支持按类型分支
export async function run(req, res) {
  try {
    const { id } = req.params;
    const { stage, userInput, crystalDraft, prdDraft, conversationHistory, autoRun, inspirationType } = req.body;
    const result = await CrystallizeAgent.run({
      inspirationId: id,
      stage: stage || 'initial',
      userInput,
      crystalDraft: crystalDraft || prdDraft || {},
      conversationHistory: conversationHistory || [],
      autoRun: autoRun !== false,
      inspirationType
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 获取最新结晶结果
export async function latest(req, res) {
  try {
    const data = await inspirationStorage.getCrystallizeLatest(req.params.id);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 获取结晶历史
export async function history(req, res) {
  try {
    const data = await inspirationStorage.getCrystallizeHistory(req.params.id);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
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
    res.status(500).json({ success: false, error: e.message });
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
    res.status(500).json({ success: false, error: e.message });
  }
}
