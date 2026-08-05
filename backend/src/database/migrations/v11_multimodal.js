// 迁移 v11：多模态输入扩展所需字段
// 功能：为 inspirations / inspiration_addenda 表新增多模态输入相关的列
//   1. inspirations.source_files_json      TEXT NULL                 —— 新建灵感拖入的原文文件 JSON
//        结构示例：[{ "filename": "xxx.md", "original_name": "笔记.md", "size": 1234 }]
//        语义：仅记录元数据，文件本体存 uploads/neoidea/，由 distillService 读取并提炼
//   2. inspirations.title_ai_generated     INTEGER DEFAULT 0         —— title 是否 AI 生成待确认
//        0 = 用户手写或已接受（默认值，旧数据兼容）
//        1 = AI 生成待用户确认（详情页显示"AI"小标，接受/编辑后置 0）
//   3. inspirations.content_ai_generated   INTEGER DEFAULT 0         —— content 是否 AI 生成待确认（语义同上）
//   4. inspiration_addenda.files_json      TEXT NULL                 —— 追加条目携带的文本文件 JSON
//        结构示例：[{ "filename": "xxx.md", "original_name": "参考.md", "size": 1234 }]
//        语义：仅记录元数据，文件本体存 uploads/addenda/，对话注入时由 conversationController 读取
//
// 实现方式：PRAGMA table_info 检查列是否存在 → ALTER TABLE ADD COLUMN（幂等）
// 兼容性：
//   - source_files_json / files_json 为可空列，旧数据保持 NULL，读取层 JSON.parse(null) → null 兼容
//   - title_ai_generated / content_ai_generated DEFAULT 0，旧数据自动获得 0 值，行为与新增前一致
//   - images_json 列不变：v7 已存在的 images_json 语义升级（字符串数组 → 对象数组）在读取层
//     （addendumService.parseImageArray）兼容处理，迁移层不写数据、不改 schema
//
// 设计说明：
//   v11 是纯 ALTER ADD COLUMN 型 migration，不涉及历史数据回填。
//   schema.sql 已同步新增列定义（项目惯例：全新初始化走 schema.sql，老库走 migrations/）。

/**
 * 执行 v11 迁移
 * 功能：为 inspirations 表添加 source_files_json / title_ai_generated / content_ai_generated；
 *       为 inspiration_addenda 表添加 files_json
 * 实现方式：PRAGMA table_info 检查列存在性 → ALTER TABLE ADD COLUMN（幂等）
 * @param {import('sql.js').Database} database - sql.js 数据库实例
 */
export function migrateV11(database) {
  console.log('[Migration v11] Starting multimodal input fields migration...');

  // ===== 1. inspirations 表新增 3 列 =====
  try {
    const inspirationsCols = database.exec('PRAGMA table_info(inspirations)');
    if (inspirationsCols.length > 0) {
      // row[1] 是列名
      const existingCols = inspirationsCols[0].values.map((row) => row[1]);

      // 1.1 source_files_json：新建灵感拖入的原文文件 JSON（可空）
      if (!existingCols.includes('source_files_json')) {
        database.exec('ALTER TABLE inspirations ADD COLUMN source_files_json TEXT');
        console.log('[DB] Migration v11: added source_files_json column to inspirations');
      } else {
        console.log('[DB] Migration v11: source_files_json already exists in inspirations, skipping');
      }

      // 1.2 title_ai_generated：title 是否 AI 生成待确认（默认 0）
      if (!existingCols.includes('title_ai_generated')) {
        database.exec('ALTER TABLE inspirations ADD COLUMN title_ai_generated INTEGER DEFAULT 0');
        console.log('[DB] Migration v11: added title_ai_generated column to inspirations');
      } else {
        console.log('[DB] Migration v11: title_ai_generated already exists in inspirations, skipping');
      }

      // 1.3 content_ai_generated：content 是否 AI 生成待确认（默认 0）
      if (!existingCols.includes('content_ai_generated')) {
        database.exec('ALTER TABLE inspirations ADD COLUMN content_ai_generated INTEGER DEFAULT 0');
        console.log('[DB] Migration v11: added content_ai_generated column to inspirations');
      } else {
        console.log('[DB] Migration v11: content_ai_generated already exists in inspirations, skipping');
      }
    } else {
      // 极端情况：inspirations 表不存在（schema.sql 未执行），抛错阻止启动
      throw new Error('inspirations table not found — schema.sql may not have been applied');
    }
  } catch (err) {
    // ALTER 失败必须抛错，阻止服务器启动（遵循 spec：迁移失败显式抛出）
    console.error('[DB] Migration v11: failed to add columns to inspirations:', err.message);
    throw new Error(`Migration v11 failed (inspirations): ${err.message}`);
  }

  // ===== 2. inspiration_addenda 表新增 files_json 列 =====
  try {
    const addendaCols = database.exec('PRAGMA table_info(inspiration_addenda)');
    if (addendaCols.length > 0) {
      const existingCols = addendaCols[0].values.map((row) => row[1]);

      // 2.1 files_json：追加条目携带的文本文件 JSON（可空）
      if (!existingCols.includes('files_json')) {
        database.exec('ALTER TABLE inspiration_addenda ADD COLUMN files_json TEXT');
        console.log('[DB] Migration v11: added files_json column to inspiration_addenda');
      } else {
        console.log('[DB] Migration v11: files_json already exists in inspiration_addenda, skipping');
      }
    } else {
      // 极端情况：inspiration_addenda 表不存在（v7 迁移未执行），抛错阻止启动
      throw new Error('inspiration_addenda table not found — v7 migration may not have been applied');
    }
  } catch (err) {
    console.error('[DB] Migration v11: failed to add column to inspiration_addenda:', err.message);
    throw new Error(`Migration v11 failed (inspiration_addenda): ${err.message}`);
  }

  console.log('[Migration v11] Migration completed successfully — multimodal fields ready');
}
