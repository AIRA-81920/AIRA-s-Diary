// 迁移 v10：已保存 AI 回答新增 converted 字段
// 功能：为 saved_ai_replies 表加 converted INTEGER NOT NULL DEFAULT 0 列
//   用途：标记某条已保存回答是否已被"转为评论"
//   - 0 = 未转化（默认值，旧数据兼容）
//   - 1 = 已转化（从"接着想"面板移除；对话窗口中折叠到"已处理历史"区）
// 实现方式：PRAGMA table_info 检查列是否存在 → ALTER TABLE ADD COLUMN（幂等）
// 兼容性：新列 NOT NULL DEFAULT 0，旧数据自动获得 0 值，行为与新增前一致

/**
 * 执行 v10 迁移
 * @param {import('sql.js').Database} database - sql.js 数据库实例
 */
export function migrateV10(database) {
  // ===== saved_ai_replies 表新增 converted 列 =====
  try {
    const repliesCols = database.exec('PRAGMA table_info(saved_ai_replies)');
    if (repliesCols.length > 0) {
      // row[1] 是列名
      const existingRepliesCols = repliesCols[0].values.map((row) => row[1]);
      if (!existingRepliesCols.includes('converted')) {
        // INTEGER NOT NULL DEFAULT 0：保证旧数据自动为 0，且未来不允许 NULL
        database.exec('ALTER TABLE saved_ai_replies ADD COLUMN converted INTEGER NOT NULL DEFAULT 0');
        console.log('[DB] Migration v10: added converted column to saved_ai_replies');
      } else {
        // 极端情况：列已存在（可能是手动加的或迁移重跑），跳过
        console.log('[DB] Migration v10: converted column already exists, skipping');
      }
    }
  } catch (err) {
    // ALTER 失败必须抛错，阻止服务器启动（遵循 spec：迁移失败显式抛出）
    console.error('[DB] Migration v10: failed to add converted column:', err.message);
    throw new Error(`Migration v10 failed: ${err.message}`);
  }

  console.log('[DB] Migration v10: converted column migration complete');
}
