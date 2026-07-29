// v7 迁移脚本：追加条目功能（Addenda）
// 功能：创建三张新表，支撑灵感级的"带线程思考日志"
//   1. inspiration_addenda —— 追加主帖（文本+链接+图片），灵感级时间线日志
//   2. addendum_comments —— 追加主帖下的评论（纯文本），用户手写成果
//   3. saved_ai_replies —— 对话窗口中用户主动保存的 AI 回答，"待消化的中间态"
//
// 实现方式：
//   - CREATE TABLE IF NOT EXISTS 保证幂等（重复执行不出错）
//   - CREATE INDEX IF NOT EXISTS 同理
//   - 外键 ON DELETE CASCADE 确保删除灵感/主帖时级联清理子数据
//
// 关键约束：
//   - 三张表均在 schema.sql 中有对应定义，此处迁移脚本负责"已存在的旧库"升级
//   - 新库（首次创建）会通过 schema.sql 的 IF NOT EXISTS 自动建表，此脚本同样安全
//   - saved_ai_replies.inspiration_id 是冗余字段，支撑"继续思考"全局列表免二次 JOIN
//
// 设计说明：
//   v7 是纯 schema 新增型 migration，不涉及历史数据迁移。
//   三张表相互独立于现有 epitaxy/coalesce/chunks 体系，不触碰任何既有表结构。
//   唯一的跨功能影响是指纹第五源（fingerprintService 读取 inspiration_addenda）。

/**
 * 执行 v7 迁移
 * 功能：创建追加条目功能所需的三张新表
 * 实现方式：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS（幂等）
 * @param {import('sql.js').Database} db - SQLite 数据库实例
 */
export function migrateV7(db) {
  console.log('[Migration v7] Starting addenda tables creation...');

  // 1. 创建 inspiration_addenda 表（追加主帖）
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS inspiration_addenda (
        id TEXT PRIMARY KEY,
        inspiration_id TEXT NOT NULL,
        content TEXT NOT NULL,
        links_json TEXT,
        images_json TEXT,
        created_at DATETIME NOT NULL,
        updated_at DATETIME,
        FOREIGN KEY (inspiration_id) REFERENCES inspirations(id) ON DELETE CASCADE
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_addenda_inspiration ON inspiration_addenda(inspiration_id, created_at)');
    console.log('[Migration v7] Table inspiration_addenda created (or already exists)');
  } catch (err) {
    console.error('[Migration v7] Failed to create inspiration_addenda:', err.message);
    throw new Error(`v7 inspiration_addenda creation failed: ${err.message}`);
  }

  // 2. 创建 addendum_comments 表（评论）
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS addendum_comments (
        id TEXT PRIMARY KEY,
        addendum_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME,
        FOREIGN KEY (addendum_id) REFERENCES inspiration_addenda(id) ON DELETE CASCADE
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_comments_addendum ON addendum_comments(addendum_id, created_at)');
    console.log('[Migration v7] Table addendum_comments created (or already exists)');
  } catch (err) {
    console.error('[Migration v7] Failed to create addendum_comments:', err.message);
    throw new Error(`v7 addendum_comments creation failed: ${err.message}`);
  }

  // 3. 创建 saved_ai_replies 表（已保存 AI 回答）
  try {
    db.run(`
      CREATE TABLE IF NOT EXISTS saved_ai_replies (
        id TEXT PRIMARY KEY,
        addendum_id TEXT NOT NULL,
        inspiration_id TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        saved_at DATETIME NOT NULL,
        FOREIGN KEY (addendum_id) REFERENCES inspiration_addenda(id) ON DELETE CASCADE
      )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_saved_replies_addendum ON saved_ai_replies(addendum_id, saved_at)');
    db.run('CREATE INDEX IF NOT EXISTS idx_saved_replies_inspiration ON saved_ai_replies(inspiration_id, saved_at)');
    console.log('[Migration v7] Table saved_ai_replies created (or already exists)');
  } catch (err) {
    console.error('[Migration v7] Failed to create saved_ai_replies:', err.message);
    throw new Error(`v7 saved_ai_replies creation failed: ${err.message}`);
  }

  console.log('[Migration v7] Migration completed successfully — 3 tables ready');
}
