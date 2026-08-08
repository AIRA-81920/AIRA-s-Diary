// 迁移 v13：embedding 多源加权字段
// 功能：为 inspiration_embeddings 表新增标题/正文向量列，支撑召回按「标题 + 正文 + 指纹」三源加权合成相似度
//   1. embedding_title   BLOB —— 标题向量的 384 维 float32 序列化（可空）
//   2. embedding_content BLOB —— 正文向量的 384 维 float32 序列化（可空）
//
// 设计说明：
//   - 原 embedding 列即「指纹向量」，保持列名不变以兼容旧代码与旧数据。
//   - 新增两列用于多源加权；旧数据两列均为 NULL，召回时按「该源缺失」跳过，
//     只回退到指纹相似度（等于旧行为），由 reaper 增量任务回填补齐。
//
// 实现方式：PRAGMA table_info 检查列是否存在 → ALTER TABLE ADD COLUMN（幂等）
// 兼容性：旧数据新增列为 NULL，行为与新增前完全一致（不阻塞、不崩）。

/**
 * 执行 v13 迁移
 * 功能：为 inspiration_embeddings 添加 embedding_title / embedding_content 列
 * 实现方式：PRAGMA table_info 检查列存在性 → ALTER TABLE ADD COLUMN（幂等）
 * @param {import('sql.js').Database} database - sql.js 数据库实例
 */
export function migrateV13(database) {
  console.log('[Migration v13] Starting embedding multi-source fields migration...');

  try {
    const colsResult = database.exec('PRAGMA table_info(inspiration_embeddings)');
    if (colsResult.length === 0) {
      throw new Error('inspiration_embeddings table not found — schema.sql may not have been applied');
    }
    const existingCols = colsResult[0].values.map((row) => row[1]);

    // 1.1 embedding_title：标题向量（可空，NULL = 旧数据未回填）
    if (!existingCols.includes('embedding_title')) {
      database.exec('ALTER TABLE inspiration_embeddings ADD COLUMN embedding_title BLOB');
      console.log('[DB] Migration v13: added embedding_title column to inspiration_embeddings');
    } else {
      console.log('[DB] Migration v13: embedding_title already exists, skipping');
    }

    // 1.2 embedding_content：正文向量（可空，NULL = 旧数据未回填）
    if (!existingCols.includes('embedding_content')) {
      database.exec('ALTER TABLE inspiration_embeddings ADD COLUMN embedding_content BLOB');
      console.log('[DB] Migration v13: added embedding_content column to inspiration_embeddings');
    } else {
      console.log('[DB] Migration v13: embedding_content already exists, skipping');
    }
  } catch (err) {
    // ALTER 失败必须抛错，阻止服务器启动（遵循 spec：迁移失败显式抛出）
    console.error('[DB] Migration v13: failed to add columns to inspiration_embeddings:', err.message);
    throw new Error(`Migration v13 failed: ${err.message}`);
  }

  console.log('[Migration v13] Migration completed successfully — embedding multi-source fields ready');
}