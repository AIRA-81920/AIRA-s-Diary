// v5 迁移脚本：aesthetic_proposal_type
// 功能：为新增的"美学提案"类型做准备，无需新建表或字段（crystal JSON 中自然会包含 extensions 字段）
// 实现方式：仅在 __migrations 表中记录 v5 迁移，作为版本号占位
//
// 关键约束：
//   - 幂等性：可重复执行（无任何 schema 变更）
//   - 老数据兼容：crystal JSON 中 extensions 字段可选，老数据读取时判断是否存在
//   - 历史数据中"概念命题"类型里被误判为"美学提案"的灵感可手动重新归类（不在迁移脚本中自动处理，避免误判）
//
// 设计说明：
//   "美学提案"类型本身不需要 schema 变更，因为：
//   1. inspiration_type / crystal_type 已在 v2 迁移中添加，支持任意字符串值
//   2. crystal / extensions 都是 JSON 字段，存放在文件存储（per-inspiration/crystallize/）
//      和 crystallize_results 表中（如需查询可解析 JSON）
//   3. 老数据兼容：读取 crystal 时判断 extensions 是否存在，不存在则视为 null
//
//   v5 迁移脚本存在的意义：
//   1. 标记数据库版本号，便于追踪
//   2. 为未来可能的 schema 变更预留位置（如需为美学提案新增索引或视图）

/**
 * 执行 v5 迁移
 * 功能：仅记录 v5 迁移版本号（无 schema 变更）
 * 实现方式：在 __migrations 表中插入版本号（由 db.js 的 runAllMigrations 统一处理）
 * @param {import('sql.js').Database} db - SQLite 数据库实例
 */
export function migrateV5(db) {
  console.log('[Migration v5] Starting aesthetic_proposal_type migration...');

  // 1. 检查是否需要将历史"概念命题"中被误判的"美学提案"灵感重新归类
  //    设计决策：不自动迁移，避免误判。用户可在 UI 中手动修正类型
  //    （crystallize_results 表的 inspiration_type 字段支持 UPDATE）
  try {
    // 统计当前各类型数量（仅日志，不做变更）
    const result = db.exec(
      "SELECT inspiration_type, COUNT(*) as count FROM crystallize_results GROUP BY inspiration_type"
    );
    if (result.length > 0) {
      const typeCounts = result[0].values.map((row) => `${row[0] || 'NULL'}: ${row[1]}`);
      console.log('[Migration v5] Current type distribution:', typeCounts.join(', '));
    } else {
      console.log('[Migration v5] crystallize_results table is empty or not exists');
    }
  } catch (err) {
    console.warn('[Migration v5] Failed to query type distribution:', err.message);
  }

  // 2. 验证 inspiration_type='美学提案' 可正常写入（不实际写入，仅日志提示）
  console.log('[Migration v5] "美学提案" type is now supported (no schema change needed)');

  // 3. 验证 crystal JSON 中 extensions 字段可正常存储
  //    （crystal 是 TEXT 字段，存 JSON 字符串，无需 schema 变更）
  console.log('[Migration v5] crystal.extensions field is supported via JSON storage');

  console.log('[Migration v5] Migration completed successfully (no-op migration)');
}
