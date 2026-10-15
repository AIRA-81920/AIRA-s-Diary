// 迁移 v14：消化（Assimilate）机制字段
// 功能：为三张"新内容"表各加 digested_at 列，标记已被消化回 crystal 的内容，防止重复消化
//   1. inspiration_addenda  加 digested_at —— 追加条目被消化后写入时间戳
//   2. knowledge_chunks     加 digested_at —— 外延词块被消化后写入时间戳
//   3. saved_ai_replies     加 digested_at —— 对话产物被消化后写入时间戳
//
// 设计说明：
//   - digested_at 为 NULL 表示尚未消化；消化确认后写入 ISO 时间戳
//   - 消化 Agent 只查询 digested_at IS NULL 的记录作为"待消化"输入
//   - 用户拒绝消化某条内容时也写入时间戳（同时写 rejected 标记，见 digested_status 列）
//
// 实现方式：PRAGMA table_info 检查列是否存在 → ALTER TABLE ADD COLUMN（幂等）
// 兼容性：旧数据新增列为 NULL，行为与新增前完全一致（不阻塞、不崩）。

/**
 * 执行 v14 迁移
 * 功能：为 inspiration_addenda / knowledge_chunks / saved_ai_replies 各添加 digested_at 列
 * 实现方式：PRAGMA table_info 检查列存在性 → ALTER TABLE ADD COLUMN（幂等）
 * @param {import('sql.js').Database} database - sql.js 数据库实例
 */
export function migrateV14(database) {
  console.log('[Migration v14] Starting assimilate (digested_at) fields migration...');

  // 需要加 digested_at 的三张表
  const targets = [
    { table: 'inspiration_addenda', col: 'digested_at' },
    { table: 'knowledge_chunks',    col: 'digested_at' },
    { table: 'saved_ai_replies',    col: 'digested_at' },
  ];

  for (const { table, col } of targets) {
    try {
      const colsResult = database.exec(`PRAGMA table_info(${table})`);
      if (colsResult.length === 0) {
        // 表不存在（理论上 schema.sql 已建表，兜底跳过不崩）
        console.warn(`[DB] Migration v14: table ${table} not found, skipping`);
        continue;
      }
      const existingCols = colsResult[0].values.map((row) => row[1]);

      if (!existingCols.includes(col)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${col} DATETIME`);
        console.log(`[DB] Migration v14: added ${col} column to ${table}`);
      } else {
        console.log(`[DB] Migration v14: ${table}.${col} already exists, skipping`);
      }
    } catch (err) {
      console.error(`[DB] Migration v14: failed to add ${col} to ${table}:`, err.message);
      throw new Error(`Migration v14 failed: ${err.message}`);
    }
  }

  console.log('[Migration v14] Migration completed successfully — digested_at fields ready');
}
