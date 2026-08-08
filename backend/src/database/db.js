// SQL.js 数据库初始化与迁移机制
// 使用 sql.js（浏览器端 SQLite 的 Node 版本）在内存中操作 SQLite，并定期持久化到磁盘
// 启动流程：加载 wasm → 读取已有 db 文件（或新建）→ 执行 schema.sql → 执行迁移

import initSqlJs from 'sql.js';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { BRIDGE_TYPE_KEY_MAP } from '../config/constants.js';

// 获取当前模块所在目录（ESM 下没有 __dirname，需手动构造）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据库配置（从环境变量读取，提供默认值）
const DB_PATH = process.env.DB_PATH || './data/inspireflow.db';
// schema.sql 文件路径（与 db.js 同目录）
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// 当前数据库迁移版本；新增迁移时递增此值并在 migrations 数组中添加对应 SQL
// M3：版本从 1 升到 2，处理 clarify → crystallize 重命名 + 新增 epitaxy/coalesce 表 + inspirations 表新字段
// K3：版本从 2 升到 3，新增 embedding 相关表 + 重塑 coalesce_bridges 字段 + bridge_type key 映射
// K4：版本从 3 升到 4，crystallize_results 新增 capsule/selected_dimensions/concept_orientation 字段 + 废弃"方法流程"类型
// K4-a：版本从 4 升到 5，新增"美学提案"类型支持（无 schema 变更，仅版本号占位 + 类型分布日志）
// fix6：版本从 5 升到 6，删除"概念命题"（argument_card），新增"概念"（concept_card）
//       迁移历史数据：'概念命题' → '概念'，'argument_card' → 'concept_card'
// v7：版本从 6 升到 7，新增追加条目功能（inspiration_addenda / addendum_comments / saved_ai_replies）
// v8：版本从 7 升到 8，新增文件夹分组功能（folders 表 + inspirations.folder_id / sort_order）
// v9：版本从 8 升到 9，新增评论分层字段（addendum_comments.context + saved_ai_replies.core/context）
//      支持 AI 回复"核心观点 + 折叠展开"分层展示，旧数据 NULL 兼容
// v10：版本从 9 升到 10，新增 saved_ai_replies.converted 字段
//      标记已保存回答是否已被"转为评论"，用于"接着想"过滤与对话窗口折叠历史区
// v11：版本从 10 升到 11，多模态输入扩展
//      inspirations 新增 source_files_json / title_ai_generated / content_ai_generated
//      inspiration_addenda 新增 files_json；images_json 语义升级在读取层兼容，迁移不写数据
// v13：版本从 12 升到 13，embedding 多源加权
//      inspiration_embeddings 新增 embedding_title / embedding_content 两列
//      支撑召回按「标题 + 正文 + 指纹」三源加权合成相似度
export const CURRENT_VERSION = 13;

// 数据库单例（initDb 完成后赋值）
export let db = null;

// 迁移定义：版本号 → 迁移 SQL 与名称
// CURRENT_VERSION=2 时，迁移 v2 完成以下任务：
//   1. 不重建 crystallize_results（schema.sql 已用 IF NOT EXISTS 创建）
//   2. 将旧 clarify_results 表的数据复制到 crystallize_results（如果旧表存在且新表为空）
//   3. 给 inspirations 表添加 inspiration_type / crystal_type 字段（如果不存在）
//   4. 旧 clarify_results 表保留（不删，作为兜底数据备份）
// CURRENT_VERSION=3 时，迁移 v3 完成以下任务（架构文档 §8.3）：
//   1. 备份数据库文件（sqlite.db → sqlite.db.v2.bak）
//   2. 新表 inspiration_embeddings / chunk_embeddings 由 schema.sql IF NOT EXISTS 创建
//   3. coalesce_bridges 追加字段：inspiration_b_id / reason / vector_score / llm_score / status
//   4. 旧数据回填：inspiration_b_id 从 candidate_id 反查；connection → reason；bridge_type key 映射
//   5. 标记 coalesce_candidates.chunk_id_a/b 为废弃（物理列保留以便回滚）
const migrations = [
  { version: 1, name: 'initial_schema', sql: '-- 初始 schema 通过 schema.sql 创建，此处无需额外操作' },
  {
    version: 2,
    name: 'm3_crystallize_rename_and_epitaxy_coalesce',
    // 迁移 v2 SQL：包含 M3 重命名 + 新表 + 字段添加
    // 注意：sql.js 的 exec 不支持 IF NOT EXISTS 用于 ALTER，需用 try/catch 容错
    sql: `
-- 1. 复制旧 clarify_results 数据到 crystallize_results
-- SQLite 不支持 IF EXISTS，用 INSERT OR IGNORE + 子查询方式（旧表不存在时子查询报错会被外层 try 捕获）
-- 这里改为在 db.js 的 runMigrationV2 函数中用 JS 逻辑处理，SQL 部分留空（仅记录版本号）
-- 实际数据迁移由 runMigrationV2 函数处理（见下方）
-- 新表已在 schema.sql 中创建，此处无需重复创建
SELECT 1;
    `
  },
  {
    version: 3,
    name: 'k3_embedding_tables_and_bridges_reshape',
    // v3 SQL 部分仅记录版本号；实际数据迁移由 runMigrationV3Data 函数处理
    // 原因：coalesce_bridges 字段追加需用 PRAGMA table_info 检查后 ALTER，
    //       旧数据回填需 JS 逻辑（反查 candidate_id、key 映射），SQL 难以表达
    sql: 'SELECT 1;'
  },
  {
    version: 4,
    name: 'k4_capsule_and_new_fields',
    // v4 SQL 部分仅记录版本号；实际数据迁移由 migrateV4 函数处理（见 migrations/v4_capsule.js）
    // 原因：ALTER TABLE ADD COLUMN 需用 try/catch 容错（sql.js 不支持 IF NOT EXISTS），
    //       "方法流程"类型迁移需 JS 逻辑 + INSERT OR IGNORE 幂等保护
    sql: 'SELECT 1;'
  },
  {
    version: 5,
    name: 'k4a_aesthetic_proposal_type',
    // v5 SQL 部分仅记录版本号；实际数据迁移由 migrateV5 函数处理（见 migrations/v5_aesthetic_proposal.js）
    // 原因：v5 是无 schema 变更的迁移，仅记录版本号 + 日志统计类型分布
    sql: 'SELECT 1;'
  },
  {
    version: 6,
    name: 'fix6_concept_card_type',
    // v6 SQL 部分仅记录版本号；实际数据迁移由 migrateV6 函数处理（见 migrations/v6_concept_card.js）
    // 原因：UPDATE 语句需在 JS 中执行以便日志统计，sql.js 直接 run 也行但 JS 更可控
    sql: 'SELECT 1;'
  },
  {
    version: 7,
    name: 'v7_addenda',
    // v7 SQL 部分仅记录版本号；实际建表由 migrateV7 函数处理（见 migrations/v7_addenda.js）
    // 原因：CREATE TABLE IF NOT EXISTS 需分步执行 + try/catch 容错 + 日志，JS 更可控
    sql: 'SELECT 1;'
  },
  {
    version: 8,
    name: 'v8_folders',
    // v8 SQL 部分仅记录版本号；实际建表 + ALTER 由 migrateV8 函数处理（见 migrations/v8_folders.js）
    sql: 'SELECT 1;'
  },
  {
    version: 9,
    name: 'v9_core_context',
    // v9 SQL 部分仅记录版本号；实际 ALTER 由 migrateV9 函数处理（见 migrations/v9_core_context.js）
    // 新增 addendum_comments.context、saved_ai_replies.core、saved_ai_replies.context 三列
    sql: 'SELECT 1;'
  },
  {
    version: 10,
    name: 'v10_converted',
    // v10 SQL 部分仅记录版本号；实际 ALTER 由 migrateV10 函数处理（见 migrations/v10_converted.js）
    // 新增 saved_ai_replies.converted INTEGER NOT NULL DEFAULT 0
    sql: 'SELECT 1;'
  },
  {
    version: 11,
    name: 'v11_multimodal',
    // v11 SQL 部分仅记录版本号；实际 ALTER 由 migrateV11 函数处理（见 migrations/v11_multimodal.js）
    // 新增 inspirations.source_files_json / title_ai_generated / content_ai_generated
    // 新增 inspiration_addenda.files_json；images_json 语义升级在读取层兼容
    sql: 'SELECT 1;'
  },
  {
    version: 12,
    name: 'v12_snapshots',
    // v12 SQL 部分仅记录版本号；实际 ALTER 由 migrateV12 函数处理（见 migrations/v12_snapshots.js）
    // 快照机制（软删除/回收站）：inspirations 新增 deleted_at / deleted_until 两列
    sql: 'SELECT 1;'
  },
  {
    version: 13,
    name: 'v13_embedding_multi_source',
    // v13 SQL 部分仅记录版本号；实际 ALTER 由 migrateV13 函数处理（见 migrations/v13_embedding_multi_source.js）
    // 多源加权：inspiration_embeddings 新增 embedding_title / embedding_content 两列
    sql: 'SELECT 1;'
  }
];

/**
 * 迁移 v2 数据处理函数
 * 功能：完成 clarify → crystallize 的数据迁移，以及 inspirations 表新字段添加
 * 实现方式：
 *   1. 检查旧 clarify_results 表是否存在，存在则复制数据到 crystallize_results
 *   2. 检查 inspirations 表是否已有 inspiration_type / crystal_type 字段，无则 ALTER ADD
 *   3. 重命名 data/inspirations/{id}/clarify/ → crystallize/
 * 注意：sql.js 不支持 PRAGMA table_info 的某些用法，需要用 try/catch 容错
 * @param {import('sql.js').Database} database - sql.js 数据库实例
 */
async function runMigrationV2Data(database) {
  // ===== 1. 检查并复制旧 clarify_results 数据 =====
  try {
    // 检查旧 clarify_results 表是否存在
    const tablesResult = database.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='clarify_results'");
    if (tablesResult.length > 0 && tablesResult[0].values.length > 0) {
      // 旧表存在：查询所有旧数据
      const oldRowsResult = database.exec('SELECT id, inspiration_id, auto_run, saved_at FROM clarify_results');
      if (oldRowsResult.length > 0) {
        const oldRows = oldRowsResult[0].values;
        console.log(`[DB] Migration v2: copying ${oldRows.length} rows from clarify_results to crystallize_results`);
        // 复制每行到 crystallize_results（旧数据 inspiration_type='产品想法', crystal_type='prd'）
        for (const row of oldRows) {
          const [id, inspirationId, autoRun, savedAt] = row;
          database.run(
            `INSERT OR IGNORE INTO crystallize_results (id, inspiration_id, inspiration_type, crystal_type, auto_run, saved_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, inspirationId, '产品想法', 'prd', autoRun, savedAt]
          );
        }
        console.log('[DB] Migration v2: clarify_results data copied to crystallize_results');
      } else {
        console.log('[DB] Migration v2: clarify_results table is empty, no data to copy');
      }
    } else {
      console.log('[DB] Migration v2: clarify_results table not found, skipping data copy');
    }
  } catch (err) {
    console.warn('[DB] Migration v2: failed to copy clarify_results data:', err.message);
  }

  // ===== 2. 给 inspirations 表添加新字段（如不存在） =====
  // sql.js 不支持 IF NOT EXISTS 用于 ALTER，用 PRAGMA table_info 检查
  try {
    const columnsResult = database.exec('PRAGMA table_info(inspirations)');
    if (columnsResult.length > 0) {
      const existingColumns = columnsResult[0].values.map((row) => row[1]); // row[1] 是 column name
      if (!existingColumns.includes('inspiration_type')) {
        database.exec('ALTER TABLE inspirations ADD COLUMN inspiration_type TEXT');
        console.log('[DB] Migration v2: added inspiration_type column to inspirations');
      }
      if (!existingColumns.includes('crystal_type')) {
        database.exec('ALTER TABLE inspirations ADD COLUMN crystal_type TEXT');
        console.log('[DB] Migration v2: added crystal_type column to inspirations');
      }
    }
  } catch (err) {
    console.warn('[DB] Migration v2: failed to add columns to inspirations:', err.message);
  }

  // ===== 3. 重命名 data/inspirations/{id}/clarify/ → crystallize/ =====
  try {
    const dataDir = process.env.DATA_DIR || './data';
    const inspirationsDir = path.isAbsolute(dataDir)
      ? path.join(dataDir, 'inspirations')
      : path.resolve(process.cwd(), dataDir, 'inspirations');
    if (fs.existsSync(inspirationsDir)) {
      const entries = await fsp.readdir(inspirationsDir, { withFileTypes: true });
      let renamedCount = 0;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const clarifyDir = path.join(inspirationsDir, entry.name, 'clarify');
        const crystallizeDir = path.join(inspirationsDir, entry.name, 'crystallize');
        if (fs.existsSync(clarifyDir) && !fs.existsSync(crystallizeDir)) {
          await fsp.rename(clarifyDir, crystallizeDir);
          renamedCount++;
        }
      }
      if (renamedCount > 0) {
        console.log(`[DB] Migration v2: renamed ${renamedCount} clarify/ dirs to crystallize/`);
      }
    }
  } catch (err) {
    console.warn('[DB] Migration v2: failed to rename clarify/ dirs:', err.message);
  }
}

/**
 * 迁移 v3 数据处理函数（K3 架构改造）
 * 功能：按架构文档 §8.3 完成 embedding 基础设施表 + coalesce_bridges 重塑
 * 实现方式：
 *   1. 备份数据库文件（sqlite.db → sqlite.db.v2.bak），迁移前自动备份
 *   2. 新表 inspiration_embeddings / chunk_embeddings 已由 schema.sql 创建（幂等），此处仅校验
 *   3. coalesce_bridges 追加字段：inspiration_b_id / reason / vector_score / llm_score / status
 *      使用 PRAGMA table_info 检查后 ALTER ADD（防重）
 *   4. 旧数据回填：
 *      a. inspiration_b_id：通过 candidate_id 反查 coalesce_candidates 获取另一端灵感 id
 *      b. reason：从旧 connection 字段复制（旧列保留不删）
 *      c. bridge_type：用 BRIDGE_TYPE_KEY_MAP 映射旧 key → 新 key
 *      d. status：默认 'confirmed'（旧数据视为已确认）
 *   5. 标记 coalesce_candidates.chunk_id_a/b 为废弃（物理列保留以便回滚，ADR-5）
 * @param {import('sql.js').Database} database - sql.js 数据库实例
 */
async function runMigrationV3Data(database) {
  // ===== 1. 迁移前自动备份 =====
  try {
    const absPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.resolve(process.cwd(), DB_PATH);
    const bakPath = `${absPath}.v2.bak`;
    if (fs.existsSync(absPath) && !fs.existsSync(bakPath)) {
      // 仅在备份不存在时创建，避免重复迁移时覆盖原始备份
      fs.copyFileSync(absPath, bakPath);
      console.log(`[DB] Migration v3: backup created at ${bakPath}`);
    }
  } catch (err) {
    console.warn('[DB] Migration v3: failed to create backup:', err.message);
    // 备份失败不中断迁移（开发环境容忍），但记日志
  }

  // ===== 2. 校验新表存在（由 schema.sql 创建，此处幂等检查） =====
  try {
    const newTables = database.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('inspiration_embeddings', 'chunk_embeddings')"
    );
    const existingNames = newTables.length > 0 ? newTables[0].values.map((r) => r[0]) : [];
    if (!existingNames.includes('inspiration_embeddings')) {
      // 极端情况：schema.sql 未执行，手动创建
      database.exec(`
        CREATE TABLE IF NOT EXISTS inspiration_embeddings (
          inspiration_id TEXT PRIMARY KEY,
          embedding BLOB,
          fingerprint TEXT,
          fingerprint_model TEXT,
          model_name TEXT,
          stale INTEGER DEFAULT 1,
          fingerprint_updated_at DATETIME,
          embedding_updated_at DATETIME
        );
      `);
      console.log('[DB] Migration v3: manually created inspiration_embeddings');
    }
    if (!existingNames.includes('chunk_embeddings')) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS chunk_embeddings (
          chunk_id TEXT PRIMARY KEY,
          embedding BLOB,
          model_name TEXT,
          updated_at DATETIME
        );
      `);
      console.log('[DB] Migration v3: manually created chunk_embeddings');
    }
  } catch (err) {
    console.warn('[DB] Migration v3: failed to verify new tables:', err.message);
  }

  // ===== 3. coalesce_bridges 追加字段 =====
  // 现状字段：id / candidate_id / inspiration_id / bridge_type / connection / new_idea_seed / saved_at
  // 目标态追加：inspiration_b_id / reason / vector_score / llm_score / status
  try {
    const bridgesColumns = database.exec('PRAGMA table_info(coalesce_bridges)');
    if (bridgesColumns.length > 0) {
      const existingColumns = bridgesColumns[0].values.map((row) => row[1]);
      const columnsToAdd = [
        { name: 'inspiration_b_id', type: 'TEXT' },
        { name: 'reason', type: 'TEXT' },
        { name: 'vector_score', type: 'REAL' },
        { name: 'llm_score', type: 'REAL' },
        { name: 'status', type: "TEXT DEFAULT 'confirmed'" }
      ];
      for (const col of columnsToAdd) {
        if (!existingColumns.includes(col.name)) {
          database.exec(`ALTER TABLE coalesce_bridges ADD COLUMN ${col.name} ${col.type}`);
          console.log(`[DB] Migration v3: added column ${col.name} to coalesce_bridges`);
        }
      }
    }
  } catch (err) {
    console.warn('[DB] Migration v3: failed to add columns to coalesce_bridges:', err.message);
  }

  // ===== 4. 旧数据回填 =====
  // a. inspiration_b_id：通过 candidate_id 反查 coalesce_candidates
  // b. reason：从 connection 复制
  // c. bridge_type：用 BRIDGE_TYPE_KEY_MAP 映射
  // d. status：默认 'confirmed'
  try {
    // 查询所有需要回填的行（inspiration_b_id 为 NULL 的行）
    const rowsResult = database.exec(
      'SELECT id, candidate_id, inspiration_id, bridge_type, connection FROM coalesce_bridges WHERE inspiration_b_id IS NULL'
    );
    if (rowsResult.length > 0) {
      const rows = rowsResult[0].values;
      console.log(`[DB] Migration v3: backfilling ${rows.length} rows in coalesce_bridges`);
      for (const row of rows) {
        const [bridgeId, candidateId, inspirationId, bridgeType, connection] = row;

        // a. 通过 candidate_id 反查 coalesce_candidates 获取另一端灵感 id
        let inspirationBId = null;
        if (candidateId) {
          const candResult = database.exec(
            'SELECT inspiration_id_a, inspiration_id_b FROM coalesce_candidates WHERE id = ?',
            [candidateId]
          );
          if (candResult.length > 0 && candResult[0].values.length > 0) {
            const [aId, bId] = candResult[0].values[0];
            // 取与 inspiration_id 不同的那一端
            inspirationBId = (aId === inspirationId) ? bId : aId;
          }
        }

        // b. reason ← connection（保留原列不删）
        const reason = connection || null;

        // c. bridge_type key 映射（structural_resonance → structure_resonance 等）
        const mappedType = BRIDGE_TYPE_KEY_MAP[bridgeType] || bridgeType;

        // d. status 默认 'confirmed'（由 ALTER DEFAULT 已设置，此处显式更新以确保）
        database.run(
          `UPDATE coalesce_bridges
           SET inspiration_b_id = ?, reason = ?, bridge_type = ?, status = COALESCE(status, 'confirmed')
           WHERE id = ?`,
          [inspirationBId, reason, mappedType, bridgeId]
        );
      }
      console.log('[DB] Migration v3: coalesce_bridges backfill complete');
    } else {
      console.log('[DB] Migration v3: no rows need backfilling in coalesce_bridges');
    }
  } catch (err) {
    console.warn('[DB] Migration v3: failed to backfill coalesce_bridges:', err.message);
  }

  // ===== 5. 标记 coalesce_candidates.chunk_id_a/b 为废弃 =====
  // ADR-5：废弃 chunk 级候选粒度，物理列保留以便回滚，新代码不读写
  // 此处仅记日志，不做物理变更
  try {
    const candColumns = database.exec('PRAGMA table_info(coalesce_candidates)');
    if (candColumns.length > 0) {
      const existingColumns = candColumns[0].values.map((row) => row[1]);
      if (existingColumns.includes('chunk_id_a') && existingColumns.includes('chunk_id_b')) {
        console.log('[DB] Migration v3: coalesce_candidates.chunk_id_a/b marked as deprecated (columns retained)');
      }
    }
  } catch (err) {
    console.warn('[DB] Migration v3: failed to check coalesce_candidates columns:', err.message);
  }
}

// 加载 sql.js 的 wasm 文件
// locateFile 返回 wasm 文件在 node_modules 中的绝对路径，确保 sql.js 能正确加载
async function loadSqlJs() {
  const SQL = await initSqlJs({
    // locateFile：sql.js 内部请求 wasm 文件时回调，返回完整路径
    locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  });
  return SQL;
}

// 从磁盘读取已有数据库文件，返回 Uint8Array；文件不存在返回 null
function readDbFile() {
  // 将相对路径解析为绝对路径（基于 cwd，即 backend 目录）
  const absPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.resolve(process.cwd(), DB_PATH);
  if (fs.existsSync(absPath)) {
    // 读取二进制文件并返回 Buffer，sql.js 可直接接受 Uint8Array
    const buffer = fs.readFileSync(absPath);
    return new Uint8Array(buffer);
  }
  return null;
}

// 将内存中的数据库导出并写回磁盘
// 实现：db.export() 返回 Uint8Array → 转 Buffer → 写入文件
export function saveDb() {
  if (!db) {
    console.warn('[DB] saveDb called but db is not initialized');
    return;
  }
  const absPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.resolve(process.cwd(), DB_PATH);
  // 确保目标目录存在
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // 导出为 Uint8Array 并写入
  const data = db.export();
  fs.writeFileSync(absPath, Buffer.from(data));
}

// ========== app_meta 键值元数据工具函数 ==========
// 功能：供后台服务（如 CoalesceReaperService）读写运行状态时间戳等元数据
// 实现方式：基于 app_meta 表（key TEXT PRIMARY KEY, value TEXT），UPSERT 语义
// 注意：setMeta 会同步 saveDb 落盘，调用方无需额外保存

/**
 * 读取 app_meta 中的指定键值
 * 功能：按 key 查询 app_meta 表，返回 value 字符串；不存在返回 null
 * 实现方式：prepare → bind → step → getAsObject → free
 * @param {string} key - 元数据键名
 * @returns {string|null} 元数据值（字符串），不存在时返回 null
 */
export function getMeta(key) {
  if (!db) return null;
  const stmt = db.prepare('SELECT value FROM app_meta WHERE key = ?');
  stmt.bind([key]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row ? row.value : null;
}

/**
 * 写入 app_meta 中的指定键值（UPSERT 语义，幂等）
 * 功能：向 app_meta 表写入键值对，已存在则更新，不存在则插入，写后立即落盘
 * 实现方式：INSERT OR REPLACE INTO app_meta + saveDb
 * @param {string} key - 元数据键名
 * @param {string|number} value - 元数据值（自动转字符串存储）
 * @returns {void}
 */
export function setMeta(key, value) {
  if (!db) {
    console.warn('[DB] setMeta called but db is not initialized');
    return;
  }
  db.run(
    'INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)',
    [key, String(value)]
  );
  saveDb();
}

// 执行 schema.sql，创建所有表（使用 IF NOT EXISTS 保证幂等）
function applySchema(SQL, database) {
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  // exec 可执行多条 SQL 语句（不含参数绑定）
  database.exec(schemaSql);
}

// 执行未应用的迁移
// 实现：查询 __migrations 表已记录的版本 → 与 migrations 列表对比 → 顺序执行未应用的
async function runAllMigrations(database) {
  // 读取已应用的最大版本号；__migrations 表在 schema.sql 中已创建
  const result = database.exec('SELECT MAX(version) as max_version FROM __migrations');
  let appliedVersion = 0;
  if (result.length > 0 && result[0].values.length > 0 && result[0].values[0][0] !== null) {
    appliedVersion = result[0].values[0][0];
  }

  // 过滤出未应用的迁移并按版本号升序执行
  const pendingMigrations = migrations
    .filter((m) => m.version > appliedVersion)
    .sort((a, b) => a.version - b.version);

  for (const migration of pendingMigrations) {
    console.log(`[DB] Applying migration v${migration.version}: ${migration.name}`);
    try {
      // 执行迁移 SQL（非空时）
      if (migration.sql && migration.sql.trim()) {
        database.exec(migration.sql);
      }
      // v2 特殊处理：执行数据迁移逻辑
      if (migration.version === 2) {
        await runMigrationV2Data(database);
      }
      // v3 特殊处理：K3 架构改造的数据迁移
      if (migration.version === 3) {
        await runMigrationV3Data(database);
      }
      // v4 特殊处理：K4 胶囊字段 + "方法流程"类型废弃
      if (migration.version === 4) {
        const { migrateV4 } = await import('./migrations/v4_capsule.js');
        migrateV4(database);
      }
      // v5 特殊处理：K4-a 新增"美学提案"类型（无 schema 变更，仅日志）
      if (migration.version === 5) {
        const { migrateV5 } = await import('./migrations/v5_aesthetic_proposal.js');
        migrateV5(database);
      }
      // fix6 v6 特殊处理：删除"概念命题"，新增"概念"类型，迁移历史数据
      if (migration.version === 6) {
        const { migrateV6 } = await import('./migrations/v6_concept_card.js');
        migrateV6(database);
      }
      // v7 特殊处理：追加条目功能，创建三张新表
      if (migration.version === 7) {
        const { migrateV7 } = await import('./migrations/v7_addenda.js');
        migrateV7(database);
      }
      // v8 特殊处理：文件夹分组功能，创建 folders 表 + inspirations 加列
      if (migration.version === 8) {
        const { migrateV8 } = await import('./migrations/v8_folders.js');
        migrateV8(database);
      }
      // v9 特殊处理：评论分层字段，为 addendum_comments 加 context，为 saved_ai_replies 加 core/context
      if (migration.version === 9) {
        const { migrateV9 } = await import('./migrations/v9_core_context.js');
        migrateV9(database);
      }
      // v10 特殊处理：saved_ai_replies 加 converted 列，标记已转化为评论的对话
      if (migration.version === 10) {
        const { migrateV10 } = await import('./migrations/v10_converted.js');
        migrateV10(database);
      }
      // v11 特殊处理：多模态输入扩展
      // inspirations 加 source_files_json / title_ai_generated / content_ai_generated
      // inspiration_addenda 加 files_json
      if (migration.version === 11) {
        const { migrateV11 } = await import('./migrations/v11_multimodal.js');
        migrateV11(database);
      }
      // v12 特殊处理：快照机制（软删除）字段
      // inspirations 加 deleted_at / deleted_until
      if (migration.version === 12) {
        const { migrateV12 } = await import('./migrations/v12_snapshots.js');
        migrateV12(database);
      }
      // v13 特殊处理：embedding 多源加权
      // inspiration_embeddings 加 embedding_title / embedding_content
      if (migration.version === 13) {
        const { migrateV13 } = await import('./migrations/v13_embedding_multi_source.js');
        migrateV13(database);
      }
      // 记录迁移版本（使用参数绑定防止注入）
      database.run(
        'INSERT INTO __migrations (version, name, applied_at) VALUES (?, ?, ?)',
        [migration.version, migration.name, new Date().toISOString()]
      );
    } catch (err) {
      // 迁移失败时抛出，阻止服务器启动（遵循 spec：失败时回滚并抛出错误）
      console.error(`[DB] Migration v${migration.version} failed:`, err.message);
      throw new Error(`Migration v${migration.version} failed: ${err.message}`);
    }
  }

  // 提示当前数据库版本
  if (pendingMigrations.length > 0) {
    console.log(`[DB] Migrations complete. Current version: ${CURRENT_VERSION}`);
  } else {
    console.log(`[DB] Database up to date. Version: ${appliedVersion}`);
  }
}

// 初始化数据库：加载 wasm → 读取或新建数据库 → 应用 schema → 执行迁移
// 调用方：server.js 启动时 await initDb()
export async function initDb() {
  console.log('[DB] Initializing SQL.js...');
  const SQL = await loadSqlJs();

  const existingData = readDbFile();
  if (existingData) {
    // 已有数据库文件：加载到内存
    db = new SQL.Database(existingData);
    console.log(`[DB] Loaded existing database from ${DB_PATH}`);
  } else {
    // 新建空数据库
    db = new SQL.Database();
    console.log(`[DB] Created new database (will persist to ${DB_PATH})`);
  }

  // 应用 schema（幂等，已存在的表不会被重复创建）
  applySchema(SQL, db);

  // 执行迁移
  await runAllMigrations(db);

  // 若有迁移或新建数据库，立即持久化到磁盘
  if (!existingData) {
    saveDb();
    console.log('[DB] New database persisted to disk');
  } else {
    // 已有数据库但有迁移执行后也需保存（迁移可能修改了数据）
    // 检查是否有 pending 迁移，有则保存
    const result = db.exec('SELECT MAX(version) as max_version FROM __migrations');
    if (result.length > 0 && result[0].values.length > 0) {
      const maxVersion = result[0].values[0][0];
      if (maxVersion >= CURRENT_VERSION) {
        saveDb();
        console.log('[DB] Database persisted after migrations');
      }
    }
  }

  return db;
}
