// 灵感控制器 — 处理 HTTP 请求并调用 Model/Service
// 统一响应格式：{ success, data } 或 { success, error }
// 所有方法使用 try/catch 包裹，异常返回 500

import { Inspiration } from '../models/Inspiration.js';
import inspirationStorage from '../services/inspirationStorage.js';
import TaskQueue, { TASK_KINDS } from '../services/taskQueue.js';

// 获取灵感列表（支持分页与搜索）
// 实现：解析 query 参数 → 调用 getAll + count → 返回列表与总数
export async function list(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;
    const search = req.query.search || undefined;
    const data = Inspiration.getAll({ limit, offset, search });
    const total = Inspiration.count();
    res.json({ success: true, data, total });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 获取单个灵感
// 实现：按 id 查询，不存在返回 404，存在返回数据
export async function get(req, res) {
  try {
    const inspiration = Inspiration.getById(req.params.id);
    if (!inspiration) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    res.json({ success: true, data: inspiration });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 创建灵感
// 实现：从 body 取字段 → 调用 Inspiration.create → 初始化 per-inspiration 存储 → 入队指纹生成任务 → 返回 201
// K3-b：fire-and-forget 入队 fingerprint 任务（架构 §6.1 流程一）
export async function create(req, res) {
  try {
    const { title, content, source_type, source_url, metadata } = req.body;
    const inspiration = Inspiration.create({ title, content, source_type, source_url, metadata });
    // 初始化灵感文件存储（含 metadata.json 与 panel-state.json）
    await inspirationStorage.initStorage(inspiration.id, {
      title: inspiration.title,
      source_type: inspiration.source_type,
    });
    // 入队后台指纹生成 + embedding 计算（fire-and-forget，不阻塞响应）
    TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, inspiration.id);
    res.status(201).json({ success: true, data: inspiration });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 更新灵感
// 实现：调用 Inspiration.update 动态更新字段 → 内容变化时入队指纹重算 → 返回更新后对象
// K3-b：title/content 变化时 markStale + 入队 fingerprint（架构 §6.2 + R1：仅产物变化时重算）
export async function update(req, res) {
  try {
    const inspirationId = req.params.id;
    const updated = Inspiration.update(inspirationId, req.body);
    // 仅当 title 或 content 变化时才触发指纹重算（避免无意义重算，R1）
    if (req.body.title !== undefined || req.body.content !== undefined) {
      TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, inspirationId);
    }
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 删除灵感
// 实现：调用 Inspiration.delete（含级联清理）→ 删除 per-inspiration 文件夹 → 返回成功
export async function remove(req, res) {
  try {
    Inspiration.delete(req.params.id);
    await inspirationStorage.removeStorage(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 搜索灵感
// 实现：解析 query.q → 调用 Inspiration.search → 返回匹配列表
export async function search(req, res) {
  try {
    const q = req.query.q || '';
    const data = Inspiration.search(q);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 初始化灵感存储（显式触发）
// 实现：调用 inspirationStorage.initStorage，metadata 从 body 传入
export async function initStorage(req, res) {
  try {
    await inspirationStorage.initStorage(req.params.id, req.body || {});
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 保存面板状态
// 实现：调用 inspirationStorage.savePanelState → 返回合并后的状态
export async function savePanelState(req, res) {
  try {
    const state = await inspirationStorage.savePanelState(req.params.id, req.body || {});
    res.json({ success: true, data: state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 获取面板状态
// 实现：调用 inspirationStorage.getPanelState → 返回状态对象（不存在时返回默认值）
export async function getPanelState(req, res) {
  try {
    const state = await inspirationStorage.getPanelState(req.params.id);
    res.json({ success: true, data: state });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// ========== v8 新增：文件夹相关 ==========

// 移动灵感到文件夹（或散出）
export async function moveToFolder(req, res) {
  try {
    const { folder_id, sort_order } = req.body || {};
    const updated = Inspiration.moveToFolder(req.params.id, folder_id ?? null, sort_order);
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 批量更新灵感排序
export async function reorder(req, res) {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'items must be an array' });
    }
    Inspiration.batchUpdateSortOrder(items);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
