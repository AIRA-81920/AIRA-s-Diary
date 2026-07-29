// Epitaxy 控制器
// 功能：处理 Epitaxy 相关 HTTP 请求，调用 EpitaxyAgent 和数据库操作
// 实现方式：每个方法 try/catch，成功返回 { success:true, data }，失败返回 500
//
// 端点：
//   POST /epitaxy/propose     — 生成方向卡片
//   GET  /epitaxy/proposals   — 获取所有提案
//   POST /epitaxy/excavate    — 深挖某方向
//   GET  /epitaxy/excavation/:proposalId — 获取深挖结果
//   POST /epitaxy/distill     — 保存提炼词块
//   GET  /epitaxy/chunks      — 获取所有词块
//   POST /epitaxy/chunk-to-inspiration — 词块转新灵感

import EpitaxyAgent from '../agents/epitaxyAgent.js';
import { db, saveDb } from '../database/db.js';
import { v4 as uuidv4 } from 'uuid';
import autoTagService from '../services/autoTagService.js';
import TaskQueue, { TASK_KINDS } from '../services/taskQueue.js';
import FingerprintService from '../services/fingerprintService.js';

// 生成方向提案
// 功能：调用 EpitaxyAgent.propose，基于结晶体生成 3-5 个方向
export async function propose(req, res) {
  try {
    const { id } = req.params;
    const { crystal } = req.body;
    // 从数据库获取灵感内容
    const rows = db.exec(`SELECT title, content, inspiration_type FROM inspirations WHERE id = '${id}'`);
    if (rows.length === 0 || rows[0].values.length === 0) {
      return res.status(404).json({ success: false, error: 'Inspiration not found' });
    }
    const [title, content, inspirationType] = rows[0].values[0];
    const inspirationContent = content || title;
    // 调用 Agent
    const result = await EpitaxyAgent.propose(id, crystal, inspirationContent, inspirationType);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 获取所有提案
// 功能：从 epitaxy_proposals 表查询指定灵感的所有提案
export async function getProposals(req, res) {
  try {
    const { id } = req.params;
    const rows = db.exec(`SELECT * FROM epitaxy_proposals WHERE inspiration_id = '${id}' ORDER BY created_at DESC`);
    const proposals = rows.length > 0 ? rows[0].values.map(row => ({
      id: row[0], inspiration_id: row[1], direction: row[2], reasoning: row[3],
      expected_yield: row[4], status: row[5], created_at: row[6]
    })) : [];
    res.json({ success: true, data: proposals });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 深挖某方向
// 功能：调用 EpitaxyAgent.excavate，生成含词块的研究笔记片段
// K3-g：从数据库读 inspiration_type 透传给 Agent（决定 fragment_type 取值集合）
export async function excavate(req, res) {
  try {
    const { id } = req.params;
    const { proposalId } = req.body;
    // 从数据库获取 proposal 信息
    const propRows = db.exec(`SELECT * FROM epitaxy_proposals WHERE id = '${proposalId}'`);
    if (propRows.length === 0 || propRows[0].values.length === 0) {
      return res.status(404).json({ success: false, error: 'Proposal not found' });
    }
    const propRow = propRows[0].values[0];
    const proposal = {
      id: propRow[0], direction: propRow[2], reasoning: propRow[3], expected_yield: propRow[4]
    };
    // 获取灵感（含 inspiration_type）和结晶体
    const inspRows = db.exec(`SELECT title, content, inspiration_type FROM inspirations WHERE id = '${id}'`);
    const [title, content, inspirationType] = inspRows[0].values[0];
    const inspirationContent = content || title;
    // 获取最新结晶体
    const crystalRows = db.exec(`SELECT * FROM crystallize_results WHERE inspiration_id = '${id}' ORDER BY saved_at DESC LIMIT 1`);
    let crystal = {};
    if (crystalRows.length > 0 && crystalRows[0].values.length > 0) {
      // 从文件存储获取更完整的 crystal 数据
      try {
        const { default: storage } = await import('../services/inspirationStorage.js');
        crystal = (await storage.getCrystallizeLatest(id))?.crystal || {};
      } catch { crystal = {}; }
    }
    // 调用 Agent（K3-g：透传 inspirationType）
    const result = await EpitaxyAgent.excavate(id, proposalId, proposal, crystal, inspirationContent, inspirationType);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 获取某方向的深挖结果
// 功能：从 epitaxy_fragments 表查询指定 proposal 的所有片段
export async function getExcavation(req, res) {
  try {
    const { id, proposalId } = req.params;
    const rows = db.exec(`SELECT * FROM epitaxy_fragments WHERE inspiration_id = '${id}' AND proposal_id = '${proposalId}' ORDER BY created_at`);
    const fragments = rows.length > 0 ? rows[0].values.map(row => ({
      id: row[0], inspiration_id: row[1], proposal_id: row[2], fragment_type: row[3],
      title: row[4], full_text: row[5], chunks: JSON.parse(row[6] || '[]'), created_at: row[7]
    })) : [];
    res.json({ success: true, data: fragments });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 保存提炼词块（Distill 阶段）
// 功能：将用户选中的词块存入 knowledge_chunks 表
// 实现方式：遍历 chunks 数组逐条插入
export async function distill(req, res) {
  try {
    const { id } = req.params;
    const { chunks } = req.body;
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ success: false, error: 'No chunks provided' });
    }
    const savedChunks = [];
    for (const chunk of chunks) {
      const chunkId = uuidv4();
      try {
        db.run(
          'INSERT INTO knowledge_chunks (id, inspiration_id, fragment_id, original_text, chunk_text, chunk_kind, chunk_subkind, user_note, selected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [chunkId, id, chunk.fragmentId || null, chunk.originalText || '', chunk.chunkText || chunk.originalText || '',
           chunk.kind || 'concept', chunk.subkind || '', chunk.userNote || '', new Date().toISOString()]
        );
        savedChunks.push({ id: chunkId, ...chunk });
      } catch (dbErr) {
        console.warn('[Epitaxy] Failed to insert chunk:', dbErr.message);
      }
    }
    saveDb();

    // 更新 proposal 状态为 distilled
    if (chunks[0]?.fragmentId) {
      try {
        db.run(`UPDATE epitaxy_proposals SET status = 'distilled' WHERE id = (SELECT proposal_id FROM epitaxy_fragments WHERE id = '${chunks[0].fragmentId}')`);
        saveDb();
      } catch { /* 静默处理 */ }
    }

    // K3 架构改造：词块入库后触发指纹重算 + 增量扫描
    // - chunks 是指纹的输入之一（FingerprintService 三源合并），distill 后必须重算
    // - 入队 FINGERPRINT 任务：内部会先重算指纹，再算 embedding，再入队 INCREMENTAL_SCAN
    // - autoTag 仍保留（M3 既有功能）
    ;(async () => {
      try {
        // 获取灵感数据用于 autoTag
        const inspRows = db.exec(`SELECT title, content FROM inspirations WHERE id = '${id}'`);
        if (inspRows.length > 0 && inspRows[0].values.length > 0) {
          const [title, content] = inspRows[0].values[0];
          await autoTagService.autoTag(id, { title, content });
        }
        // 标记指纹 stale（chunks 变化），并入队重算
        // taskQueue 内部串行：FINGERPRINT → 自动 enqueue INCREMENTAL_SCAN
        await FingerprintService.markStale(id);
        TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, id);
      } catch (e) {
        console.warn('[Epitaxy] Background autoTag/fingerprint refresh failed:', e.message);
      }
    })();

    res.json({ success: true, data: { chunks: savedChunks } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 获取所有词块
// 功能：从 knowledge_chunks 表查询指定灵感的所有词块
export async function getChunks(req, res) {
  try {
    const { id } = req.params;
    const rows = db.exec(`SELECT * FROM knowledge_chunks WHERE inspiration_id = '${id}' ORDER BY selected_at DESC`);
    const chunks = rows.length > 0 ? rows[0].values.map(row => ({
      id: row[0], inspiration_id: row[1], fragment_id: row[2], original_text: row[3],
      chunk_text: row[4], chunk_kind: row[5], chunk_subkind: row[6], user_note: row[7], selected_at: row[8]
    })) : [];
    res.json({ success: true, data: chunks });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 词块转新灵感
// 功能：将选中的词块组合为内容，创建新灵感
export async function chunkToInspiration(req, res) {
  try {
    const { id } = req.params;
    const { chunkIds } = req.body;
    if (!Array.isArray(chunkIds) || chunkIds.length === 0) {
      return res.status(400).json({ success: false, error: 'No chunk IDs provided' });
    }
    // 查询选中的词块
    const idList = chunkIds.map(cid => `'${cid}'`).join(',');
    const rows = db.exec(`SELECT chunk_text, chunk_kind, chunk_subkind FROM knowledge_chunks WHERE id IN (${idList})`);
    if (rows.length === 0 || rows[0].values.length === 0) {
      return res.status(404).json({ success: false, error: 'No chunks found' });
    }
    // 组合词块为新灵感内容
    const chunks = rows[0].values.map(row => ({ text: row[0], kind: row[1], subkind: row[2] }));
    const content = chunks.map(c => `[${c.kind}] ${c.text}`).join('\n');
    const title = `词块提炼：${chunks[0]?.text?.slice(0, 20) || '新灵感'}...`;

    // 创建新灵感（通过 Inspiration model）
    const Inspiration = (await import('../models/Inspiration.js')).default;
    const newInspiration = await Inspiration.create({
      title,
      content,
      source_type: 'epitaxy_distill',
      source_url: null
    });

    res.json({ success: true, data: newInspiration });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
