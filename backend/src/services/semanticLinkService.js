// semanticLinkService — 【已废弃】隐式语义链接服务
// 功能（历史）：当新 chunk 入库时，计算与已有 chunk 的相似度，找出候选对存入 coalesce_candidates
// 实现方式（历史）：
//   - 层 1：基于关键词重叠 + Jaccard 系数的轻量相似度计算
//   - 层 2：接入 Embedding API 计算真实向量相似度（未实现）
//
// @deprecated K3 架构改造后由 CoalesceScanService 替代
//   - 召回引擎：Jaccard 字面相似度 → embedding + LLM 深挖双引擎（ADR-1）
//   - 触发方式：隐式触发 → 显式扫描 + 后台增量（ADR-2）
//   - 候选粒度：chunk 级 → 灵感级（ADR-5）
//   - 新代码不应 import 本文件，所有调用已迁移至 CoalesceScanService
//
// 保留本文件仅用于：
//   1. 向后兼容（万一有遗漏的引用）
//   2. 历史代码追溯
//   3. 作为 Jaccard 实现的参考（未来若需轻量预筛可复用 computeTextSimilarity）

import { db, saveDb } from '../database/db.js';
import { v4 as uuidv4 } from 'uuid';

// 相似度阈值：超过此值才存入候选对
const SIMILARITY_THRESHOLD = 0.3;

/**
 * 计算两个文本的轻量相似度（保留供未来轻量预筛参考）
 * 功能：基于关键词重叠 + Jaccard 系数
 * 实现方式：分词 → 取交集 → Jaccard = 交集/并集
 * @param {string} textA - 文本 A
 * @param {string} textB - 文本 B
 * @returns {number} 0-1 的相似度
 */
function computeTextSimilarity(textA, textB) {
  if (!textA || !textB) return 0;
  // 简单分词：按空格/标点分割，取长度 ≥ 2 的词
  const tokensA = new Set(textA.toLowerCase().split(/[\s,，。.、；;！!？?]+/).filter(t => t.length >= 2));
  const tokensB = new Set(textB.toLowerCase().split(/[\s,，。.、；;！!？?]+/).filter(t => t.length >= 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  // Jaccard 系数
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * 【已废弃】扫描候选对（层 1：关键词相似度）
 * 功能（历史）：为指定灵感找出与其他灵感的 chunk 之间的相似候选对
 * 实现方式（历史）：查询当前灵感的 chunks → 查询其他灵感的 chunks → 两两计算相似度 → 存入候选表
 * @deprecated 新代码应使用 CoalesceScanService.incrementalUpdate（embedding 双引擎）
 * @param {string} inspirationId - 当前灵感 ID
 * @returns {Array} 候选对列表（始终返回空数组，仅保留函数签名防引用断裂）
 */
export async function scanCandidates(inspirationId) {
  console.warn('[semanticLinkService] scanCandidates is deprecated, use CoalesceScanService.incrementalUpdate instead');
  return [];
}

/**
 * 【已废弃】获取候选对（含两端灵感标题）
 * 功能（历史）：从 coalesce_candidates 表查询，并 JOIN 灵感标题和词块文本
 * @deprecated 新代码应使用 CoalesceScanService.getGraph 或新的 coalesceController.getCandidates
 * @param {string} inspirationId - 当前灵感 ID
 * @returns {Array} 候选对列表
 */
export async function getCandidates(inspirationId) {
  console.warn('[semanticLinkService] getCandidates is deprecated, use coalesceController.getCandidates instead');
  return [];
}

export default { scanCandidates, getCandidates };
