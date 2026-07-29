// Inspiration 数据模型 — 封装灵感表的 CRUD 操作
// 基于 SQL.js 的 prepared statement 实现，使用静态方法对象模式（Inspiration.create()）
// 所有写操作后调用 saveDb() 持久化到磁盘

import { v4 as uuidv4 } from 'uuid';
import { db, saveDb } from '../database/db.js';

// 执行查询并返回所有匹配行（作为对象数组）
// 实现：prepare → bind → step 循环收集 getAsObject() → free 释放
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

// 执行查询并返回第一行（作为对象），无结果返回 null
// 实现：prepare → bind → 单次 step + getAsObject → free
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

// Inspiration 模型对象：包含所有 CRUD 静态方法
export const Inspiration = {
  // 创建灵感
  // 实现：生成 UUID → 设置时间戳 → 插入记录 → saveDb → 返回完整对象
  create({ title, content, source_type = 'manual', source_url, metadata } = {}) {
    const id = uuidv4();
    const now = new Date().toISOString();
    // metadata 序列化为 JSON 字符串存储
    const metadataStr = metadata ? JSON.stringify(metadata) : null;

    db.run(
      `INSERT INTO inspirations
        (id, title, content, summary, source_type, source_url, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, content, null, source_type, source_url || null, now, now, metadataStr]
    );
    saveDb();
    // 返回完整对象（统一字段格式）
    return this.getById(id);
  },

  // 获取灵感列表（分页 + 搜索 + 文件夹过滤）
  // 实现：按 sort_order ASC, created_at DESC 排序，支持 limit/offset 分页，search 匹配 title 或 content
  // v8 新增：folderId 参数，传入时只返回该文件夹内的灵感；'none' 表示只返回散灵感
  getAll({ limit = 100, offset = 0, search, folderId } = {}) {
    let sql = 'SELECT * FROM inspirations';
    const conditions = [];
    const params = [];
    // 有搜索关键词时追加 WHERE 条件（参数化绑定防止 SQL 注入）
    if (search) {
      conditions.push('(title LIKE ? OR content LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    // v8：文件夹过滤
    if (folderId === 'none') {
      conditions.push('folder_id IS NULL');
    } else if (folderId) {
      conditions.push('folder_id = ?');
      params.push(folderId);
    }
    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY sort_order ASC, created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);
    return queryAll(sql, params);
  },

  // 按 ID 获取单个灵感，不存在返回 null
  getById(id) {
    return queryOne('SELECT * FROM inspirations WHERE id = ?', [id]);
  },

  // 更新灵感（动态构建 UPDATE 语句，只更新提供的字段）
  // 实现：遍历允许更新的字段，收集非 undefined 字段构建 SET 子句，自动更新 updated_at
  update(id, data = {}) {
    const allowedFields = ['title', 'content', 'summary', 'source_type', 'source_url', 'metadata', 'folder_id', 'sort_order'];
    const setParts = [];
    const params = [];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        setParts.push(`${field} = ?`);
        // metadata 字段：对象需序列化为 JSON 字符串
        if (field === 'metadata' && data[field] !== null && typeof data[field] === 'object') {
          params.push(JSON.stringify(data[field]));
        } else {
          params.push(data[field]);
        }
      }
    }

    // 无可更新字段时直接返回当前记录
    if (setParts.length === 0) {
      return this.getById(id);
    }

    // 自动更新 updated_at
    setParts.push('updated_at = ?');
    params.push(new Date().toISOString());
    // WHERE 条件参数追加在末尾
    params.push(id);

    db.run(`UPDATE inspirations SET ${setParts.join(', ')} WHERE id = ?`, params);
    saveDb();
    // 返回更新后的对象
    return this.getById(id);
  },

  // 删除灵感 + 级联清理关联表
  // 实现：删除 inspirations 主记录，同时清理所有关联表（架构 §13 R11：删除灵感后图/候选/embeddings 残留脏数据）
  // K3-b：补全 inspiration_embeddings / chunk_embeddings / coalesce_* / epitaxy_* / crystallize_* / knowledge_chunks 级联清理
  delete(id) {
    db.run('DELETE FROM inspirations WHERE id = ?', [id]);
    // 级联清理灵感-标签关联
    db.run('DELETE FROM inspiration_tags WHERE inspiration_id = ?', [id]);
    // 级联清理语义关联（双向：作为源 inspiration_id 或目标 related_id）
    db.run('DELETE FROM links WHERE inspiration_id = ? OR related_id = ?', [id, id]);
    // 级联清理语义分析结果
    db.run('DELETE FROM semantic_link_analysis WHERE inspiration_id = ?', [id]);
    // K3-b 新增级联清理
    // 结晶结果
    db.run('DELETE FROM crystallize_results WHERE inspiration_id = ?', [id]);
    // Epitaxy 提案与片段（先 fragments 再 proposals，逻辑顺序）
    db.run('DELETE FROM epitaxy_fragments WHERE inspiration_id = ?', [id]);
    db.run('DELETE FROM epitaxy_proposals WHERE inspiration_id = ?', [id]);
    // 词块 + chunk embeddings（chunk_embeddings 需要先查 chunk_id 列表，或用子查询）
    db.run('DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE inspiration_id = ?)', [id]);
    db.run('DELETE FROM knowledge_chunks WHERE inspiration_id = ?', [id]);
    // 语义指纹 + embedding（K3 新表）
    db.run('DELETE FROM inspiration_embeddings WHERE inspiration_id = ?', [id]);
    // Coalesce 候选对（双向：作为 A 或 B）
    db.run('DELETE FROM coalesce_candidates WHERE inspiration_id_a = ? OR inspiration_id_b = ?', [id, id]);
    // Coalesce 桥梁（双向：bridges 表的 inspiration_id 与 inspiration_b_id）
    db.run('DELETE FROM coalesce_bridges WHERE inspiration_id = ? OR inspiration_b_id = ?', [id, id]);
    saveDb();
  },

  // 关键词搜索灵感（匹配 title 或 content）
  // 实现：参数化 LIKE 查询，按 created_at DESC 排序
  search(q) {
    if (!q) return [];
    return queryAll(
      'SELECT * FROM inspirations WHERE title LIKE ? OR content LIKE ? ORDER BY created_at DESC',
      [`%${q}%`, `%${q}%`]
    );
  },

  // 获取最近 N 天的灵感（为后续里程碑的重复检测/相似查找铺路）
  // 实现：计算截止时间 ISO 字符串，按 created_at 筛选
  getRecent(days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString();
    return queryAll(
      'SELECT * FROM inspirations WHERE created_at >= ? ORDER BY created_at DESC',
      [cutoffStr]
    );
  },

  // 返回灵感总数
  // 实现：COUNT 聚合查询，取出 total 字段
  count() {
    const row = queryOne('SELECT COUNT(*) as total FROM inspirations');
    return row ? row.total : 0;
  },

  // ========== v8 新增：文件夹相关方法 ==========

  /**
   * 移动灵感到文件夹（或散出）
   * @param {string} id - 灵感 ID
   * @param {string|null} folderId - 目标文件夹 ID，null 表示散出
   * @param {number} [sortOrder] - 可选排序序号，不传则放到目标位置末尾
   * @returns {object} 更新后的灵感对象
   */
  moveToFolder(id, folderId, sortOrder) {
    if (sortOrder === undefined || sortOrder === null) {
      // 放到目标位置末尾：取该文件夹下最大 sort_order + 1
      const maxRow = folderId
        ? queryOne('SELECT MAX(sort_order) as max_order FROM inspirations WHERE folder_id = ?', [folderId])
        : queryOne('SELECT MAX(sort_order) as max_order FROM inspirations WHERE folder_id IS NULL');
      sortOrder = (maxRow?.max_order ?? -1) + 1;
    }
    db.run(
      'UPDATE inspirations SET folder_id = ?, sort_order = ?, updated_at = ? WHERE id = ?',
      [folderId, sortOrder, new Date().toISOString(), id]
    );
    saveDb();
    return this.getById(id);
  },

  /**
   * 更新单个灵感的排序序号
   * @param {string} id
   * @param {number} sortOrder
   */
  updateSortOrder(id, sortOrder) {
    db.run('UPDATE inspirations SET sort_order = ?, updated_at = ? WHERE id = ?',
      [sortOrder, new Date().toISOString(), id]);
    saveDb();
  },

  /**
   * 批量更新灵感排序（拖拽排序后一次性提交）
   * @param {Array<{id: string, sort_order: number, folder_id?: string|null}>} items
   */
  batchUpdateSortOrder(items) {
    for (const item of items) {
      if (item.folder_id !== undefined) {
        db.run('UPDATE inspirations SET sort_order = ?, folder_id = ?, updated_at = ? WHERE id = ?',
          [item.sort_order, item.folder_id, new Date().toISOString(), item.id]);
      } else {
        db.run('UPDATE inspirations SET sort_order = ?, updated_at = ? WHERE id = ?',
          [item.sort_order, new Date().toISOString(), item.id]);
      }
    }
    saveDb();
  },
};

export default Inspiration;
