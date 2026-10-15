// inspirationStorage 服务 — per-inspiration JSON 文件存储
// 为每个灵感在 data/inspirations/{id}/ 下创建独立文件夹，存储 metadata.json、panel-state.json 等文件
// 后续里程碑可在该文件夹下扩展 epitaxy/、coalesce/、knowledge_chunks/ 等子目录
//
// M3 变更：原 clarify 相关方法全部重命名为 crystallize
//   - DEFAULT_PANEL_STATE.clarifyCollapsed → crystallizeCollapsed
//   - getClarifyDir → getCrystallizeDir
//   - listClarifyFiles → listCrystallizeFiles
//   - saveClarifyResult → saveCrystallizeResult
//   - getClarifyLatest → getCrystallizeLatest
//   - getClarifyHistory → getCrystallizeHistory
//   - updateClarifyPRD → updateCrystallizePRD
//   - 子目录 clarify/ → crystallize/（迁移 v2 会重命名旧目录）

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
// Electron 打包路径适配：数据根统一走 paths
import { resolveDataInspirationsDir } from '../config/paths.js';
// 安全加固（SEC-006）：id 白名单 + 路径前缀断言，杜绝 ../../ 任意目录创建/写入/删除
import { assertUuid, safeJoin } from '../utils/security.js';

// 默认面板收起状态：三面板布局初始均为展开
// M3 重命名：clarifyCollapsed → crystallizeCollapsed
const DEFAULT_PANEL_STATE = {
  crystallizeCollapsed: false,  // 最左侧结晶面板（原 clarifyCollapsed）
  leftCollapsed: false,         // 左侧外延面板（M3-c 后启用）
  rightCollapsed: false,        // 右侧融合面板（M3-e 后启用）
};

// 返回指定灵感的存储文件夹路径
// 实现：UUID 白名单校验 → safeJoin 拼接 {数据根}/inspirations/{id}
// 安全（SEC-006）：非 UUID id（如 ../../escape）直接抛 400，resolve 后强制断言仍在数据根之下
export function getStoragePath(inspirationId) {
  assertUuid(inspirationId, 'inspiration id');
  return safeJoin(resolveDataInspirationsDir(), inspirationId);
}

// 初始化灵感存储
// 实现：创建文件夹 → 写入 metadata.json（含 id、created_at 及传入的元数据）→ 写入默认 panel-state.json
export async function initStorage(inspirationId, metadata = {}) {
  const dir = getStoragePath(inspirationId);
  // recursive: true 确保父目录也存在，已存在时不报错
  await fs.mkdir(dir, { recursive: true });

  // 写入 metadata.json：合并 id、创建时间与传入的元数据
  const meta = {
    id: inspirationId,
    created_at: new Date().toISOString(),
    ...metadata,
  };
  await fs.writeFile(
    path.join(dir, 'metadata.json'),
    JSON.stringify(meta, null, 2),
    'utf-8'
  );

  // 写入默认 panel-state.json
  await fs.writeFile(
    path.join(dir, 'panel-state.json'),
    JSON.stringify(DEFAULT_PANEL_STATE, null, 2),
    'utf-8'
  );

  return meta;
}

// 保存面板状态（合并写入）
// 实现：读取现有 panel-state.json → 与传入 state 浅合并 → 写回文件；文件不存在则从默认值开始
export async function savePanelState(inspirationId, state) {
  const filePath = path.join(getStoragePath(inspirationId), 'panel-state.json');
  let current = { ...DEFAULT_PANEL_STATE };
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    current = JSON.parse(content);
  } catch (err) {
    // 文件不存在或解析失败时使用默认值（不抛出错误，保证写入流程继续）
  }
  // 浅合并：传入的字段覆盖现有值
  const merged = { ...current, ...state };
  await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

// 读取面板状态
// 实现：读取 panel-state.json 并解析；文件不存在时返回默认值
export async function getPanelState(inspirationId) {
  const filePath = path.join(getStoragePath(inspirationId), 'panel-state.json');
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    // 文件不存在返回默认值（不抛出错误）
    return { ...DEFAULT_PANEL_STATE };
  }
}

// 删除整个灵感存储文件夹
// 实现：UUID 白名单校验（校验失败直接抛 400，不允许静默吞掉）→ fs.rm recursive + force
export async function removeStorage(inspirationId) {
  // 先校验后删除（SEC-006）：非法 id 必须抛错，让调用方返回 400 而非假装成功
  const dir = getStoragePath(inspirationId);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    // force: true 已处理不存在的情况；其他错误记录但不抛出（删除操作应尽力而为）
    console.warn(`[Storage] Failed to remove ${dir}:`, err.message);
  }
}

// ===== Crystallize 子目录相关方法（M3 重命名：原 Clarify） =====
// 结晶结果存放在 inspirations/{id}/crystallize/ 子目录下，文件名格式 {ISO-timestamp}_{uuid}.json
// 文件名前缀为时间戳，因此按文件名字符串排序即可按时间排序
// 旧数据目录 clarify/ 由 db.js 迁移 v2 自动重命名为 crystallize/

// 返回指定灵感的 crystallize 子目录路径
// 实现：getStoragePath 已含 UUID 白名单 + safeJoin 双重校验，此处直接在其下拼接子目录
function getCrystallizeDir(inspirationId) {
  return path.join(getStoragePath(inspirationId), 'crystallize');
}

// 列出 crystallize 目录下所有 .json 文件名（降序，最新在前）
// 实现：fs.readdir 失败时返回空数组（目录不存在视为无记录）
async function listCrystallizeFiles(inspirationId) {
  const dir = getCrystallizeDir(inspirationId);
  try {
    const entries = await fs.readdir(dir);
    // 仅保留 .json 文件并按文件名降序排序（时间戳前缀保证降序即最新在前）
    return entries.filter(f => f.endsWith('.json')).sort().reverse();
  } catch (err) {
    // 目录不存在或其他错误：返回空数组，调用方按需处理
    return [];
  }
}

// 保存结晶结果到 per-inspiration/crystallize/ 子目录
// 功能：写入 {timestamp}_{uuid}.json，返回文件名
// 实现方式：fs.mkdir recursive 创建子目录，文件名含时间戳与短 uuid 保证唯一性
export async function saveCrystallizeResult(inspirationId, result) {
  const dir = getCrystallizeDir(inspirationId);
  await fs.mkdir(dir, { recursive: true });
  // 时间戳中的 : 与 . 替换为 -，保证文件名合法且可按字符串排序
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${timestamp}_${uuidv4().slice(0, 8)}.json`;
  const filePath = path.join(dir, fileName);
  const content = {
    ...result,
    inspiration_id: inspirationId,
    saved_at: new Date().toISOString(),
  };
  await fs.writeFile(filePath, JSON.stringify(content, null, 2), 'utf-8');
  return { file: fileName, saved_at: content.saved_at };
}

// 获取最新结晶结果
// 功能：读取 crystallize/ 目录最新文件
// 实现：列出文件降序排序后取第一个；无文件返回 null
export async function getCrystallizeLatest(inspirationId) {
  const files = await listCrystallizeFiles(inspirationId);
  if (files.length === 0) return null;
  const filePath = path.join(getCrystallizeDir(inspirationId), files[0]);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    // 读取或解析失败返回 null，避免阻塞调用方
    console.warn(`[Storage] Failed to read crystallize latest for ${inspirationId}:`, err.message);
    return null;
  }
}

// 获取结晶历史
// 功能：返回所有结晶记录列表（按时间降序）
// 实现：列出所有文件（已降序），逐个读取并解析，单条失败跳过不阻塞其他记录
export async function getCrystallizeHistory(inspirationId) {
  const files = await listCrystallizeFiles(inspirationId);
  const dir = getCrystallizeDir(inspirationId);
  const history = [];
  for (const fileName of files) {
    try {
      const content = await fs.readFile(path.join(dir, fileName), 'utf-8');
      history.push(JSON.parse(content));
    } catch (err) {
      // 单条记录读取失败时跳过，不影响其他记录
      console.warn(`[Storage] Failed to read crystallize file ${fileName}:`, err.message);
    }
  }
  return history;
}

// 更新最新结晶记录的 PRD / crystal
// 功能：读取最新文件 → 同时更新 crystal（权威键）与 prd（旧读取方兼容）→ 写回文件
// 实现：无最新文件时抛错（调用方应先确保有结晶记录）；写回时保留原文件名
// 修复 0-1（内联编辑写入丢失）：读取侧（archiveService / 前端 store）优先读 crystal 键，
//   因此写回时必须同时写 crystal 与 prd，否则用户编辑刷新后被旧 crystal 覆盖
export async function updateCrystallizePRD(inspirationId, prd) {
  const files = await listCrystallizeFiles(inspirationId);
  if (files.length === 0) {
    throw new Error(`No crystallize result found for inspiration ${inspirationId}`);
  }
  const dir = getCrystallizeDir(inspirationId);
  const latestFile = files[0];
  const filePath = path.join(dir, latestFile);
  const content = await fs.readFile(filePath, 'utf-8');
  const data = JSON.parse(content);
  const now = new Date().toISOString();
  // 同时写 crystal（权威键，值等于传入内容）与 prd（旧读取方兼容），并记录 crystal_updated_at
  data.crystal = prd;
  data.prd = prd;
  data.crystal_updated_at = now;
  // 保留原有 prd_updated_at 行为（不强制，但保留以免旧读取方依赖断裂）
  data.prd_updated_at = now;
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return { file: latestFile, updated: true };
}

// 保存消化结果：写新版本 crystal 文件（不覆盖旧文件，保留版本历史）
// 功能：读取最新 crystal → 应用用户确认的改写 + 挂载证据 → 写新文件
// 实现：复用 saveCrystallizeResult 的文件名规则（timestamp_uuid），
//   新文件额外记录 assimilated_from（来源内容 ID 列表）与 assimilated_fields（改了哪些字段）
export async function saveAssimilation(inspirationId, { crystal, evidence, assimilatedFrom, assimilatedFields }) {
  // 读取最新 crystal 文件作为基底（保留 stage / concept_map / 等已有字段）
  const latest = await getCrystallizeLatest(inspirationId);
  if (!latest) {
    throw new Error(`No crystallize result found for inspiration ${inspirationId}`);
  }
  // 构建新版本内容：旧基底 → 更新 crystal → 追加 evidence → 记录消化来源
  const now = new Date().toISOString();
  const newContent = {
    ...latest,                           // 保留 stage / concept_map / inspiration_type / crystal_type 等
    crystal: crystal || latest.crystal,   // 用户确认改写后的新 crystal（拒绝的条目不改）
    prd: crystal || latest.crystal,       // 旧读取方兼容
    evidence: evidence || latest.evidence || [],  // 材料性内容挂载到此处
    assimilated_from: assimilatedFrom || [],       // 来源内容 ID 列表
    assimilated_fields: assimilatedFields || [],   // 本次改了哪些 crystal 字段
    assimilated_at: now,                          // 消化时间戳
    crystal_updated_at: now,
    prd_updated_at: now,
    saved_at: now,
    inspiration_id: inspirationId,
  };
  return await saveCrystallizeResult(inspirationId, newContent);
}

export default {
  initStorage,
  savePanelState,
  getPanelState,
  removeStorage,
  getStoragePath,
  saveCrystallizeResult,
  getCrystallizeLatest,
  getCrystallizeHistory,
  updateCrystallizePRD,
  saveAssimilation,
};
