// 迁移 v8：文件夹分组功能
// 功能：创建 folders 表 + inspirations 表新增 folder_id / sort_order 列
// 实现方式：PRAGMA table_info 检查列是否存在 → ALTER TABLE ADD COLUMN（幂等）

/**
 * 执行 v8 迁移
 * @param {import('sql.js').Database} database - sql.js 数据库实例
 */
export function migrateV8(database) {
  // ===== 1. 创建 folders 表（schema.sql 已含 IF NOT EXISTS，此处兜底） =====
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '未命名文件夹',
        color TEXT NOT NULL DEFAULT '#60a5fa',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT (datetime('now')),
        updated_at DATETIME NOT NULL DEFAULT (datetime('now'))
      );
    `);
    console.log('[DB] Migration v8: folders table ensured');
  } catch (err) {
    console.warn('[DB] Migration v8: failed to create folders table:', err.message);
  }

  // ===== 2. inspirations 表新增 folder_id / sort_order 列 =====
  try {
    const columnsResult = database.exec('PRAGMA table_info(inspirations)');
    if (columnsResult.length > 0) {
      const existingColumns = columnsResult[0].values.map((row) => row[1]);
      if (!existingColumns.includes('folder_id')) {
        database.exec('ALTER TABLE inspirations ADD COLUMN folder_id TEXT');
        console.log('[DB] Migration v8: added folder_id column to inspirations');
      }
      if (!existingColumns.includes('sort_order')) {
        database.exec('ALTER TABLE inspirations ADD COLUMN sort_order INTEGER DEFAULT 0');
        console.log('[DB] Migration v8: added sort_order column to inspirations');
      }
    }
  } catch (err) {
    console.warn('[DB] Migration v8: failed to add columns to inspirations:', err.message);
  }

  console.log('[DB] Migration v8: folders feature migration complete');
}
