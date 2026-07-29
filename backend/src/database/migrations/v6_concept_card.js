// v6 迁移脚本：concept_card_type
// 功能：将历史"概念命题"（argument_card）类型的灵感迁移为"概念"（concept_card）类型
// 实现方式：
//   1. 更新 inspirations 表中 inspiration_type='概念命题' 的记录为 '概念'
//   2. 更新 crystallize_results 表中 inspiration_type='概念命题' 的记录为 '概念'
//   3. 更新 crystallize_results 表中 crystal_type='argument_card' 的记录为 'concept_card'
//   4. 同时更新文件存储中 crystal JSON 的 crystal_type 字段（由 crystallizeAgent 读取时处理）
//
// 关键约束：
//   - 幂等性：可重复执行（WHERE 条件确保只更新未迁移的记录）
//   - 老数据兼容：crystallizeAgent.js 中 TYPE_TO_CRYSTAL 保留 '概念命题' → 'argument_card' 兼容映射
//   - concept_orientation 字段保留但不再使用（向后兼容）
//
// 设计说明：
//   v6 是数据迁移型 migration，需要把历史"概念命题"数据转为"概念"。
//   历史已结晶的 argument_card 数据中 claim/evidence/counter_argument/scope 等字段
//   在新的 concept_card schema 下不再有效，但保留在 crystal JSON 中不删除——
//   用户可手动重新结晶生成符合 concept_card schema 的新 crystal。
//
//   fragment_type 中的 support_arg/counter_arg/analogy 也会被新的
//   concept_precedent/distinction_case/application_case/evolution_case 取代，
//   但历史 fragment 数据保留（fragmentMeta.js 中保留旧 type 的 label 映射以便读取）。

/**
 * 执行 v6 迁移
 * 功能：将历史"概念命题"类型迁移为"概念"类型
 * 实现方式：UPDATE 语句 + 日志统计
 * @param {import('sql.js').Database} db - SQLite 数据库实例
 */
export function migrateV6(db) {
  console.log('[Migration v6] Starting concept_card_type migration...');

  // 1. 统计迁移前的"概念命题"数量
  let beforeCount = 0;
  try {
    const result = db.exec(
      "SELECT COUNT(*) as count FROM crystallize_results WHERE inspiration_type = '概念命题'"
    );
    if (result.length > 0) {
      beforeCount = result[0].values[0][0];
      console.log(`[Migration v6] Found ${beforeCount} crystallize_results with inspiration_type='概念命题'`);
    }
  } catch (err) {
    console.warn('[Migration v6] Failed to query before count:', err.message);
  }

  // 2. 更新 crystallize_results 表：'概念命题' → '概念'，argument_card → concept_card
  try {
    db.run("UPDATE crystallize_results SET inspiration_type = '概念' WHERE inspiration_type = '概念命题'");
    console.log('[Migration v6] Updated crystallize_results.inspiration_type: 概念命题 → 概念');

    db.run("UPDATE crystallize_results SET crystal_type = 'concept_card' WHERE crystal_type = 'argument_card'");
    console.log('[Migration v6] Updated crystallize_results.crystal_type: argument_card → concept_card');
  } catch (err) {
    console.warn('[Migration v6] Failed to update crystallize_results:', err.message);
  }

  // 3. 更新 inspirations 表（如果有 inspiration_type 字段）
  try {
    db.run("UPDATE inspirations SET inspiration_type = '概念' WHERE inspiration_type = '概念命题'");
    console.log('[Migration v6] Updated inspirations.inspiration_type: 概念命题 → 概念');
  } catch (err) {
    // inspirations 表可能没有 inspiration_type 字段（类型存储在 crystallize_results 中）
    console.warn('[Migration v6] inspirations table update skipped:', err.message);
  }

  // 4. 统计迁移后的"概念"数量
  try {
    const result = db.exec(
      "SELECT COUNT(*) as count FROM crystallize_results WHERE inspiration_type = '概念'"
    );
    if (result.length > 0) {
      const afterCount = result[0].values[0][0];
      console.log(`[Migration v6] After migration: ${afterCount} crystallize_results with inspiration_type='概念'`);
    }
  } catch (err) {
    console.warn('[Migration v6] Failed to query after count:', err.message);
  }

  // 5. 提示用户：历史 argument_card 的 crystal JSON 字段（claim/evidence 等）不再使用
  //    但保留在文件存储中，用户可手动重新结晶生成符合 concept_card schema 的新 crystal
  console.log('[Migration v6] Note: Historical argument_card crystal JSON fields (claim/evidence/counter_argument/scope) are deprecated');
  console.log('[Migration v6] Note: Users can manually re-crystallize to generate concept_card schema crystals');

  console.log('[Migration v6] Migration completed successfully');
}
