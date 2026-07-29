// 文件夹控制器 — 处理 HTTP 请求并调用 Folder Model
// 统一响应格式：{ success, data } 或 { success, error }

import { Folder } from '../models/Folder.js';

// 获取所有文件夹（含灵感计数）
export async function list(req, res) {
  try {
    const data = Folder.getAll();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 创建文件夹
export async function create(req, res) {
  try {
    const { name, color } = req.body || {};
    const folder = Folder.create({ name, color });
    res.status(201).json({ success: true, data: folder });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 更新文件夹（名称/颜色/排序）
export async function update(req, res) {
  try {
    const { name, color, sort_order } = req.body || {};
    const folder = Folder.update(req.params.id, { name, color, sort_order });
    if (!folder) {
      return res.status(404).json({ success: false, error: 'Folder not found' });
    }
    res.json({ success: true, data: folder });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 删除文件夹（灵感散出，不删灵感）
export async function remove(req, res) {
  try {
    Folder.delete(req.params.id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 批量更新文件夹排序
export async function reorder(req, res) {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items)) {
      return res.status(400).json({ success: false, error: 'items must be an array' });
    }
    Folder.batchUpdateSortOrder(items);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
