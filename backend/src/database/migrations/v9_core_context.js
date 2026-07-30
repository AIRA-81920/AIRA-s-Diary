// 迁移 v9：评论与已保存 AI 回复新增 core/context 字段
// 功能：为 addendum_comments 表加 context 列，为 saved_ai_replies 表加 core/context 列
// 实现方式：PRAGMA table_info 检查列是否存在 → ALTER TABLE ADD COLUMN（幂等）
// 兼容性：新列允许 NULL，旧数据行为不变（context 为空时不显示"展开更多"）

/**
 * 执行 v9 迁移
 * @param {import('sql.js').Database} database - sql.js 数据库实例
 */
export function migrateV9(database) {
  // ===== 1. addendum_comments 表新增 context 列（存折叠的展开内容） =====
  try {
    const commentsCols = database.exec('PRAGMA table_info(addendum_comments)');
    if (commentsCols.length > 0) {
      const existingCommentsCols = commentsCols[0].values.map((row) => row[1]);
      if (!existingCommentsCols.includes('context')) {
        database.exec('ALTER TABLE addendum_comments ADD COLUMN context TEXT');
        console.log('[DB] Migration v9: added context column to addendum_comments');
      }
    }
  } catch (err) {
    console.warn('[DB] Migration v9: failed to add context to addendum_comments:', err.message);
  }

  // ===== 2. saved_ai_replies 表新增 core / context 列 =====
  try {
    const repliesCols = database.exec('PRAGMA table_info(saved_ai_replies)');
    if (repliesCols.length > 0) {
      const existingRepliesCols = repliesCols[0].values.map((row) => row[1]);
      if (!existingRepliesCols.includes('core')) {
        database.exec('ALTER TABLE saved_ai_replies ADD COLUMN core TEXT');
        console.log('[DB] Migration v9: added core column to saved_ai_replies');
      }
      if (!existingRepliesCols.includes('context')) {
        database.exec('ALTER TABLE saved_ai_replies ADD COLUMN context TEXT');
        console.log('[DB] Migration v9: added context column to saved_ai_replies');
      }
    }
  } catch (err) {
    console.warn('[DB] Migration v9: failed to add columns to saved_ai_replies:', err.message);
  }

  console.log('[DB] Migration v9: core/context columns migration complete');
}
