// 迁移 v12：灵感快照（软删除/回收站）字段
// 功能：为 inspirations 表新增软删除相关列，支撑"快照"机制
//   1. inspirations.deleted_at   DATETIME NULL   —— 进入快照（软删除）的时间；NULL = 正常灵感
//   2. inspirations.deleted_until DATETIME NULL   —— 快照过期时间（deleted_at + 30 天）；过期后被后台任务物理清理
//
// 设计说明：
//   - 采用软删除而非独立快照表：灵感目录、词块、结晶、外延、桥梁等关联数据全部保留，
//     恢复时 100% 复原（避免硬删除后只能靠外部备份重建的损失）。
//   - 所有"活跃灵感"查询（列表/搜索/统计）统一追加 WHERE deleted_at IS NULL，
//     快照区查询追加 WHERE deleted_at IS NOT NULL，两条查询路径互不可见。
//   - deleted_until 允许未来扩展为"用户自定义保留期"（当前固定 30 天）。
//
// 实现方式：PRAGMA table_info 检查列是否存在 → ALTER TABLE ADD COLUMN（幂等）
// 兼容性：旧数据两列均为 NULL，行为与新增前完全一致。

/**
 * 执行 v12 迁移
 * 功能：为 inspirations 表添加 deleted_at / deleted_until 列
 * 实现方式：PRAGMA table_info 检查列存在性 → ALTER TABLE ADD COLUMN（幂等）
 * @param {import('sql.js').Database} database - sql.js 数据库实例
 */
export function migrateV12(database) {
  console.log('[Migration v12] Starting snapshot (soft-delete) fields migration...');

  try {
    const colsResult = database.exec('PRAGMA table_info(inspirations)');
    if (colsResult.length === 0) {
      throw new Error('inspirations table not found — schema.sql may not have been applied');
    }
    const existingCols = colsResult[0].values.map((row) => row[1]);

    // 1.1 deleted_at：进入快照的时间（可空，NULL = 正常灵感）
    if (!existingCols.includes('deleted_at')) {
      database.exec('ALTER TABLE inspirations ADD COLUMN deleted_at DATETIME');
      console.log('[DB] Migration v12: added deleted_at column to inspirations');
    } else {
      console.log('[DB] Migration v12: deleted_at already exists in inspirations, skipping');
    }

    // 1.2 deleted_until：快照过期时间（可空，NULL = 正常灵感）
    if (!existingCols.includes('deleted_until')) {
      database.exec('ALTER TABLE inspirations ADD COLUMN deleted_until DATETIME');
      console.log('[DB] Migration v12: added deleted_until column to inspirations');
    } else {
      console.log('[DB] Migration v12: deleted_until already exists in inspirations, skipping');
    }
  } catch (err) {
    // ALTER 失败必须抛错，阻止服务器启动（遵循 spec：迁移失败显式抛出）
    console.error('[DB] Migration v12: failed to add columns to inspirations:', err.message);
    throw new Error(`Migration v12 failed: ${err.message}`);
  }

  console.log('[Migration v12] Migration completed successfully — snapshot fields ready');
}
