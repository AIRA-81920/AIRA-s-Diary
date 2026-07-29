// Folder 数据模型 — 封装文件夹表的 CRUD 操作
// 基于 SQL.js 的 prepared statement 实现，使用静态方法对象模式（Folder.create()）
// 所有写操作后调用 saveDb() 持久化到磁盘

import { v4 as uuidv4 } from 'uuid';
import { db, saveDb } from '../database/db.js';

// 执行查询并返回所有匹配行（作为对象数组）
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
function queryOne(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

// Folder 模型对象：包含所有 CRUD 静态方法
export const Folder = {
  /**
   * 创建文件夹
   * @param {{ name?: string, color?: string }} data
   * @returns {object} 完整文件夹对象
   */
  create({ name, color } = {}) {
    const id = uuidv4();
    const now = new Date().toISOString();
    // sort_order 取当前最大值 +1，确保新文件夹排在末尾
    const maxRow = queryOne('SELECT MAX(sort_order) as max_order FROM folders');
    const sortOrder = (maxRow?.max_order ?? -1) + 1;

    db.run(
      `INSERT INTO folders (id, name, color, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name || '未命名文件夹', color || '#60a5fa', sortOrder, now, now]
    );
    saveDb();
    return this.getById(id);
  },

  /**
   * 获取所有文件夹（含每个文件夹的灵感计数）
   * @returns {Array<object>} 文件夹列表，按 sort_order ASC 排序
   */
  getAll() {
    return queryAll(`
      SELECT f.*, COUNT(i.id) as inspiration_count
      FROM folders f
      LEFT JOIN inspirations i ON i.folder_id = f.id
      GROUP BY f.id
      ORDER BY f.sort_order ASC
    `);
  },

  /**
   * 按 ID 获取单个文件夹
   * @param {string} id
   * @returns {object|null}
   */
  getById(id) {
    return queryOne('SELECT * FROM folders WHERE id = ?', [id]);
  },

  /**
   * 更新文件夹（动态构建 UPDATE 语句）
   * @param {string} id
   * @param {{ name?: string, color?: string, sort_order?: number }} data
   * @returns {object} 更新后的文件夹对象
   */
  update(id, data = {}) {
    const allowedFields = ['name', 'color', 'sort_order'];
    const setParts = [];
    const params = [];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        setParts.push(`${field} = ?`);
        params.push(data[field]);
      }
    }

    if (setParts.length === 0) {
      return this.getById(id);
    }

    setParts.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    db.run(`UPDATE folders SET ${setParts.join(', ')} WHERE id = ?`, params);
    saveDb();
    return this.getById(id);
  },

  /**
   * 删除文件夹
   * 功能：删除文件夹记录，同时将该文件夹下所有灵感的 folder_id 设为 NULL（散出）
   * @param {string} id
   */
  delete(id) {
    // 先将该文件夹下的灵感散出
    db.run('UPDATE inspirations SET folder_id = NULL WHERE folder_id = ?', [id]);
    // 再删除文件夹记录
    db.run('DELETE FROM folders WHERE id = ?', [id]);
    saveDb();
  },

  /**
   * 获取文件夹内灵感数量
   * @param {string} id
   * @returns {number}
   */
  getInspirationCount(id) {
    const row = queryOne('SELECT COUNT(*) as count FROM inspirations WHERE folder_id = ?', [id]);
    return row ? row.count : 0;
  },

  /**
   * 批量更新文件夹排序
   * @param {Array<{id: string, sort_order: number}>} items
   */
  batchUpdateSortOrder(items) {
    for (const item of items) {
      db.run('UPDATE folders SET sort_order = ?, updated_at = ? WHERE id = ?',
        [item.sort_order, new Date().toISOString(), item.id]);
    }
    saveDb();
  }
};

export default Folder;
