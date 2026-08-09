// 灵感控制器 — 处理 HTTP 请求并调用 Model/Service
// 统一响应格式：{ success, data } 或 { success, error }
// 所有方法使用 try/catch 包裹，异常返回 500

import fs from 'fs';
import path from 'path';
import { Inspiration } from '../models/Inspiration.js';
import inspirationStorage from '../services/inspirationStorage.js';
import TaskQueue, { TASK_KINDS } from '../services/taskQueue.js';
import { db, saveDb } from '../database/db.js';
import { computeDistillMode } from '../services/distillService.js';
// Electron 打包路径适配：新建灵感源文件目录统一走 paths
import { resolveNeoideaDir } from '../config/paths.js';

// 新建灵感源文件的物理存储目录（与 addendumController uploadFiles storage 一致）
const NEOIDEA_DIR = resolveNeoideaDir();

// 塑形灵感响应对象（v11 多模态扩展）
// 功能：解析 source_files_json → source_files 字段，整型字段强制转 Number（SQL.js 可能返回字符串）
// 实现：解构剔除冗余的 source_files_json；source_files 解析失败降级为 null；
//      title_ai_generated/content_ai_generated 为 null 时保持 null，否则转 Number
function shapeInspiration(row) {
  if (!row) return row;
  const { source_files_json, ...rest } = row;
  let sourceFiles = null;
  if (source_files_json) {
    try { sourceFiles = JSON.parse(source_files_json); } catch { sourceFiles = null; }
  }
  const toNum = v => (v === null || v === undefined ? v : Number(v));
  return {
    ...rest,
    source_files: sourceFiles,
    title_ai_generated: toNum(row.title_ai_generated),
    content_ai_generated: toNum(row.content_ai_generated),
  };
}

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
// v11：响应经 shapeInspiration 塑形，含 source_files/title_ai_generated/content_ai_generated
export async function get(req, res) {
  try {
    const inspiration = Inspiration.getById(req.params.id);
    if (!inspiration) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    res.json({ success: true, data: shapeInspiration(inspiration) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 创建灵感
// 实现：从 body 取字段 → 调用 Inspiration.create → 初始化 per-inspiration 存储 → 入队指纹生成任务 → 返回 201
// K3-b：fire-and-forget 入队 fingerprint 任务（架构 §6.1 流程一）
// v11 多模态扩展：source_files 存入 source_files_json；distill=true 时改入队 DISTILL（后台回填 title+content）
export async function create(req, res) {
  try {
    // 多模态扩展字段：source_files（文件元信息数组）、distill（是否后台提炼 title+content）
    const { title, content, source_type, source_url, metadata, source_files, distill } = req.body;
    let inspiration = Inspiration.create({ title, content, source_type, source_url, metadata });
    // source_files 非空时序列化存入 source_files_json（供后续 distill 读取文件清单）
    if (Array.isArray(source_files) && source_files.length > 0) {
      inspiration = Inspiration.update(inspiration.id, {
        source_files_json: JSON.stringify(source_files),
      });
    }
    // 初始化灵感文件存储（含 metadata.json 与 panel-state.json）
    await inspirationStorage.initStorage(inspiration.id, {
      title: inspiration.title,
      source_type: inspiration.source_type,
    });
    // 后台任务入队（fire-and-forget，不阻塞响应）
    if (distill) {
      // distill=true：灵感已立即创建（title 可为空或 'Loading'），DISTILL 任务后台按需回填缺失字段；
      // v12：标记"提炼中(3)"让前端轮询感知；_handleDistill 完成后会自行入队 FINGERPRINT，
      //      故此处不再重复入队（避免对占位内容空算一次指纹）
      const mode = computeDistillMode(title, content);
      const sets = [];
      const params = [];
      if (mode === 'both' || mode === 'title') sets.push('title_ai_generated = 3');
      if (mode === 'both' || mode === 'content') sets.push('content_ai_generated = 3');
      if (sets.length > 0) {
        params.push(inspiration.id);
        db.run(`UPDATE inspirations SET ${sets.join(', ')} WHERE id = ?`, params);
        saveDb();
      }
      TaskQueue.enqueue(TASK_KINDS.DISTILL, inspiration.id);
    } else {
      // 默认流程：入队指纹生成 + embedding 计算（架构 §6.1 流程一）
      TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, inspiration.id);
    }
    // 返回塑形对象（含 source_files/title_ai_generated/content_ai_generated）
    res.status(201).json({ success: true, data: shapeInspiration(inspiration) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 更新灵感
// 实现：调用 Inspiration.update 动态更新字段 → 内容变化时入队指纹重算 → 返回更新后对象
// K3-b：title/content 变化时 markStale + 入队 fingerprint（架构 §6.2 + R1：仅产物变化时重算）
// v11：title_ai_generated/content_ai_generated 经 Inspiration.update allowedFields 透传；
//      重要——ai_generated 翻转不触发 FINGERPRINT（仅 title/content 内容变化才触发，避免无意义重算）
export async function update(req, res) {
  try {
    const inspirationId = req.params.id;
    // v11 多模态扩展：前端传 source_files（数组），后端映射为 source_files_json（JSON 字符串）存储
    // 功能：兼容前端语义字段名，避免前端感知后端存储细节
    // 实现：若 req.body.source_files 存在，序列化为 source_files_json 后透传给 Inspiration.update
    const updateData = { ...req.body };
    if (Array.isArray(updateData.source_files)) {
      updateData.source_files_json = JSON.stringify(updateData.source_files);
      delete updateData.source_files;
    }
    // Inspiration.update 的 allowedFields 已含 title_ai_generated/content_ai_generated（多模态扩展）
    const updated = Inspiration.update(inspirationId, updateData);
    // 仅当 title 或 content 内容变化时才触发指纹重算（ai_generated 翻转不触发，R1）
    if (req.body.title !== undefined || req.body.content !== undefined) {
      TaskQueue.enqueue(TASK_KINDS.FINGERPRINT, inspirationId);
    }
    res.json({ success: true, data: shapeInspiration(updated) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 手动触发 DISTILL 任务（v11 多模态扩展 + v12 按需提炼）
// 实现：校验灵感存在 → 按需标记"提炼中(3)" → 入队 DISTILL 任务（后台回填缺失字段）→ 返回 queued: true
// 路由：POST /inspirations/:id/distill（任务 11 接入）
// v12：根据当前 title/content 计算提炼模式（both/title/content），只把需要生成的字段标记为"提炼中(3)"，
//      前端 Detail 检测到 3 时开启轮询；提炼完成后由 taskQueue 置 1（待确认）或 2（失败）
export async function triggerDistill(req, res) {
  try {
    const inspiration = Inspiration.getById(req.params.id);
    if (!inspiration) {
      return res.status(404).json({ success: false, error: 'Inspiration not found' });
    }
    // 按需提炼：只标记需要生成的字段为"提炼中(3)"（用户已有字段不标记，保持 0）
    const mode = computeDistillMode(inspiration.title, inspiration.content);
    const sets = [];
    const params = [];
    if (mode === 'both' || mode === 'title') sets.push('title_ai_generated = 3');
    if (mode === 'both' || mode === 'content') sets.push('content_ai_generated = 3');
    if (sets.length > 0) {
      params.push(req.params.id);
      db.run(`UPDATE inspirations SET ${sets.join(', ')} WHERE id = ?`, params);
      saveDb();
    }
    // 入队 DISTILL（fire-and-forget）：distillService 读 source_files_json + 已有字段 → LLM 按需提炼 → 回填 DB + 入队 FINGERPRINT
    TaskQueue.enqueue(TASK_KINDS.DISTILL, req.params.id);
    res.json({ success: true, data: { queued: true, mode } });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 删除灵感（v12 改造：软删除进入快照区）
// 实现：调用 Inspiration.softDelete（设置 deleted_at/deleted_until）→ 灵感目录与关联数据全部保留
// 说明：快照默认保留 30 天，到期由后台定时任务物理清理；用户可在设置面板恢复或手动物理删除
export async function remove(req, res) {
  try {
    const updated = Inspiration.softDelete(req.params.id, SNAPSHOT_RETENTION_DAYS);
    if (!updated) {
      return res.status(404).json({ success: false, error: '灵感不存在' });
    }
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// ========== v12 快照（软删除/回收站）端点 ==========

// 快照保留天数：默认 30 天（deleted_until = deleted_at + 30d，到期自动物理清理）
const SNAPSHOT_RETENTION_DAYS = 30;

// 快照列表：所有软删除的灵感，按删除时间倒序
export async function listSnapshots(req, res) {
  try {
    const data = Inspiration.listSnapshots({ limit: 100, offset: 0 });
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 恢复快照：清除软删除标记，灵感回到删除前的文件夹
export async function restoreSnapshot(req, res) {
  try {
    const updated = Inspiration.restore(req.params.id);
    if (!updated) {
      return res.status(404).json({ success: false, error: '快照不存在' });
    }
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}

// 物理删除快照：数据库级联清理 + 删除灵感目录（不可恢复，需用户确认）
export async function purgeSnapshot(req, res) {
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

// 读取灵感的某个源文件原文内容（v11 多模态扩展：原文浮窗功能依赖）
// 功能：按 inspirationId 查 DB 的 source_files_json，校验请求的 filename 属于该灵感，
//       然后从 uploads/neoidea/<filename> 读取文本内容返回
// 路由：GET /inspirations/:id/files/:filename
// 安全要点：
//   1. 必须先从 DB 取 source_files 列表，校验 filename 在列表中（防止路径遍历/越权读取他人文件）
//   2. path.basename 防止 filename 含路径分隔符（如 ../）
//   3. 仅允许 .md/.txt 等文本文件（与上传时的 fileFilter 一致）
export async function getFileContent(req, res) {
  try {
    const { id, filename } = req.params;
    // 防 path traversal：只取 basename
    const safeName = path.basename(filename);
    if (safeName !== filename) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }

    // 从 DB 取灵感记录，解析 source_files_json
    const inspiration = Inspiration.getById(id);
    if (!inspiration) {
      return res.status(404).json({ success: false, error: 'Inspiration not found' });
    }

    // 解析 source_files 列表，校验请求的 filename 在其中
    let sourceFiles = [];
    if (inspiration.source_files_json) {
      try {
        sourceFiles = JSON.parse(inspiration.source_files_json) || [];
      } catch {
        sourceFiles = [];
      }
    }
    const matched = sourceFiles.find((f) => f && f.filename === safeName);
    if (!matched) {
      return res.status(404).json({ success: false, error: 'File not found in this inspiration' });
    }

    // 物理文件路径
    const filePath = path.join(NEOIDEA_DIR, safeName);
    // 二次校验：filePath 必须仍在 NEOIDEA_DIR 之下（防止符号链接等绕过）
    if (!filePath.startsWith(NEOIDEA_DIR + path.sep) && filePath !== NEOIDEA_DIR) {
      return res.status(400).json({ success: false, error: 'Invalid file path' });
    }
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'File not found on disk' });
    }

    // 读取文本内容（utf-8）
    const content = fs.readFileSync(filePath, 'utf-8');
    // 返回原文 + 文件元信息（前端浮窗展示用）
    res.json({
      success: true,
      data: {
        filename: safeName,
        original_name: matched.original_name || matched.originalName || safeName,
        size: matched.size || 0,
        format: matched.format || (matched.original_name ? matched.original_name.split('.').pop().toLowerCase() : ''),
        content,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
