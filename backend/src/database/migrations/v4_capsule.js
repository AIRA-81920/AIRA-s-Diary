// v4 迁移脚本：capsule_and_new_fields
// 功能：为 crystallize_results 表新增 K4 字段，迁移"方法流程"类型
// 实现方式：ALTER TABLE ADD COLUMN + UPDATE 老数据
//
// 关键约束：
//   - 幂等性：可重复执行（ALTER TABLE 用 try/catch 包裹，已存在则跳过）
//   - 老数据兼容：新增字段默认为 null
//   - "方法流程"类型废弃：相关数据迁移到"其他"类型

/**
 * 执行 v4 迁移
 * 功能：
 *   1. crystallize_results 表新增 selected_dimensions/detected_capsule/capsule_preset/concept_orientation 字段
 *   2. 将 inspiration_type='方法流程' 的数据迁移到'其他'类型
 *   3. 在 __migrations 表中记录 v4 迁移
 * 实现方式：ALTER TABLE ADD COLUMN（带 try/catch 幂等保护） + UPDATE 数据迁移
 * @param {import('sql.js').Database} db - SQLite 数据库实例
 */
export function migrateV4(db) {
  console.log('[Migration v4] Starting capsule_and_new_fields migration...');

  // 1. crystallize_results 表新增字段（用 try/catch 包裹，已存在则跳过）
  const newColumns = [
    { name: 'selected_dimensions', type: 'TEXT' },   // K4：LLM 选择的维度路径（JSON 字符串）
    { name: 'detected_capsule',    type: 'TEXT' },   // K4：识别到的设定胶囊（JSON 字符串）
    { name: 'capsule_preset',      type: 'TEXT' },   // K4：胶囊预填字段（JSON 字符串）
    { name: 'concept_orientation', type: 'TEXT' }    // K4：概念命题指向（understanding/action/creation）
  ];

  for (const col of newColumns) {
    try {
      db.run(`ALTER TABLE crystallize_results ADD COLUMN ${col.name} ${col.type}`);
      console.log(`[Migration v4] Added column: ${col.name}`);
    } catch (e) {
      // 字段已存在则跳过（幂等保护）
      if (e.message.includes('duplicate column name')) {
        console.log(`[Migration v4] Column already exists, skipping: ${col.name}`);
      } else {
        console.error(`[Migration v4] Failed to add column ${col.name}:`, e.message);
        throw e;
      }
    }
  }

  // 2. "方法流程"类型迁移：K4 废弃该类型，将相关数据标记为"其他"
  try {
    db.run(`UPDATE inspirations SET inspiration_type = '其他', crystal_type = 'free_note' WHERE inspiration_type = '方法流程'`);
    console.log('[Migration v4] Migrated 方法流程 → 其他 in inspirations table');
  } catch (e) {
    console.error('[Migration v4] Failed to migrate inspirations:', e.message);
    throw e;
  }

  try {
    db.run(`UPDATE crystallize_results SET inspiration_type = '其他', crystal_type = 'free_note' WHERE inspiration_type = '方法流程'`);
    console.log('[Migration v4] Migrated 方法流程 → 其他 in crystallize_results table');
  } catch (e) {
    console.error('[Migration v4] Failed to migrate crystallize_results:', e.message);
    throw e;
  }

  // 3. 迁移版本记录由 db.js 的 runAllMigrations 统一处理（INSERT INTO __migrations）
  // 此处不再重复 INSERT，避免与 runAllMigrations 的 UNIQUE 约束冲突

  console.log('[Migration v4] Migration completed successfully');
}
