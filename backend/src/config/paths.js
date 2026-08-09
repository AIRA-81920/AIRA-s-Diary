// paths.js — 集中路径管理（Electron 打包适配核心）
// 功能：统一解析数据目录 / 上传目录 / 数据库文件 / .env / sql.js-wasm 的所有路径，
//       消除后端散落在各文件里的 process.cwd() 相对路径依赖。
// 实现方式：
//   - 优先读环境变量（由 Electron 主进程注入绝对路径：DATA_DIR / DB_PATH / UPLOADS_DIR /
//     ENV_PATH / SQLJS_DIST_DIR / CACHE_DIR），保证打包后数据落到 %APPDATA%。
//   - 未设置环境变量时回退到相对 process.cwd() 的相对路径，Web 开发行为与现状完全一致。
// 注意：本模块必须在依赖路径的模块加载前被 import（ESM 顶层 const 读取 env）。

import path from 'path';
import fs from 'fs';

/**
 * 数据根目录（数据库 + inspirations/ 的父目录）
 * 优先 DATA_DIR（绝对），否则回退 cwd/./data
 * @returns {string} 绝对路径
 */
export function resolveDataRoot() {
  const env = process.env.DATA_DIR;
  if (env) return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
  return path.resolve(process.cwd(), './data');
}

/**
 * 数据库文件路径
 * 优先 DB_PATH（绝对），否则回退 cwd/./data/inspireflow.db（与 DB_PATH 默认值一致）
 * @returns {string} 绝对路径
 */
export function getDbPath() {
  const env = process.env.DB_PATH;
  if (env) return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
  return path.resolve(process.cwd(), './data/inspireflow.db');
}

/**
 * 上传根目录（uploads/，其下有 addenda/、neoidea/）
 * 优先 UPLOADS_DIR（绝对），否则回退 cwd/uploads
 * @returns {string} 绝对路径
 */
export function resolveUploadsRoot() {
  const env = process.env.UPLOADS_DIR;
  if (env) return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
  return path.resolve(process.cwd(), 'uploads');
}

/**
 * 追加条目上传目录（uploads/addenda）
 * @returns {string} 绝对路径
 */
export function resolveAddendaDir() {
  return path.join(resolveUploadsRoot(), 'addenda');
}

/**
 * 新建灵感源文件上传目录（uploads/neoidea）
 * @returns {string} 绝对路径
 */
export function resolveNeoideaDir() {
  return path.join(resolveUploadsRoot(), 'neoidea');
}

/**
 * per-inspiration 数据目录（{数据根}/inspirations）
 * @returns {string} 绝对路径
 */
export function resolveDataInspirationsDir() {
  return path.join(resolveDataRoot(), 'inspirations');
}

/**
 * .env 文件路径（用户可写配置）
 * 优先 ENV_PATH（绝对），否则回退 cwd/.env
 * @returns {string} 绝对路径
 */
export function resolveEnvPath() {
  const env = process.env.ENV_PATH;
  if (env) return env;
  return path.resolve(process.cwd(), '.env');
}

/**
 * .env.example 文件路径（模板）
 * 优先 ENV_EXAMPLE_PATH，否则回退 cwd/.env.example
 * @returns {string} 绝对路径
 */
export function resolveEnvExamplePath() {
  const env = process.env.ENV_EXAMPLE_PATH;
  if (env) return env;
  return path.resolve(process.cwd(), '.env.example');
}

/**
 * sql.js 运行时 dist 目录（含 sql-wasm.wasm）
 * 优先 SQLJS_DIST_DIR（Electron 可指向 asarUnpack 解包后的外部目录），
 * 否则回退：从 cwd 逐级向上查找 node_modules/sql.js/dist（兼容依赖 hoist 到根 node_modules 的场合）。
 * @returns {string} 绝对路径
 */
export function resolveSqlJsDist() {
  const env = process.env.SQLJS_DIST_DIR;
  if (env) return env;
  // 逐级向上查找：Web 开发依赖可能 hoist 到根 node_modules（backend/node_modules 里不再存在）
  // 从 cwd 开始逐级向文件系统根查找 node_modules/sql.js/dist，返回第一个实际存在的候选
  let dir = process.cwd();
  const candidates = [];
  while (true) {
    candidates.push(path.join(dir, 'node_modules', 'sql.js', 'dist'));
    const parent = path.dirname(dir);
    if (parent === dir) break;   // 已到文件系统根
    dir = parent;
  }
  const existing = candidates.find((c) => fs.existsSync(c));
  // 都不存在则回退到 cwd 下的默认（让 sql.js 自行报错）
  return existing || candidates[0];
}