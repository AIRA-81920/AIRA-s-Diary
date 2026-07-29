// autoTagService — 隐式自动打标签服务
// 功能：灵感入库或结晶完成时，自动提取关键词标签，存入 inspirations.tags 字段
// 实现方式：
//   - 层 1（当前实现）：基于词频统计的轻量关键词提取
//   - 层 2（未来扩展）：接入 LLM 提取语义标签
//
// 不消耗 LLM（当前实现），纯算法

import { db, saveDb } from '../database/db.js';

// 停用词表（中文常见无意义词）
const STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '那', '它', '他', '她', '们', '这个', '那个', '什么', '怎么',
  '可以', '可能', '应该', '需要', '觉得', '感觉', '想', '认为', '知道', '问题',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'on', 'at',
  'for', 'with', 'by', 'from', 'about', 'as', 'into', 'through', 'during',
  'and', 'or', 'but', 'if', 'then', 'so', 'because', 'as', 'until',
  'while', 'of', 'about', 'against', 'between', 'into', 'through'
]);

/**
 * 从文本提取关键词标签
 * 功能：基于词频统计，提取出现频率最高的词作为标签
 * 实现方式：分词 → 过滤停用词 → 统计词频 → 取 top N
 * @param {string} text - 文本内容
 * @param {number} maxTags - 最多提取几个标签（默认 5）
 * @returns {Array<string>} 标签列表
 */
export function extractTags(text, maxTags = 5) {
  if (!text || text.length < 2) return [];

  // 分词：按空格/标点分割，取长度 ≥ 2 的词
  const tokens = text.toLowerCase().split(/[\s,，。.、；;！!？?（）()\[\]【】""''《》<>]+/)
    .filter(t => t.length >= 2 && !STOP_WORDS.has(t));

  if (tokens.length === 0) return [];

  // 统计词频
  const freq = {};
  for (const token of tokens) {
    freq[token] = (freq[token] || 0) + 1;
  }

  // 按频率降序排序，取 top N
  const sorted = Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxTags)
    .map(([word]) => word);

  return sorted;
}

/**
 * 为灵感自动打标签
 * 功能：提取灵感内容 + 结晶体中的关键词，更新 inspirations.tags 字段
 * 实现方式：组合 title/content/crystal 文本 → extractTags → UPDATE 数据库
 * @param {string} inspirationId - 灵感 ID
 * @param {object} inspirationData - 灵感数据（含 title, content）
 * @param {object} crystal - 可选的结晶体数据
 * @returns {Array<string>} 生成的标签列表
 */
export async function autoTag(inspirationId, inspirationData, crystal = null) {
  try {
    // 组合所有可用文本
    const texts = [inspirationData?.title || '', inspirationData?.content || ''];
    if (crystal) {
      // 把结晶体所有字段值拼起来
      texts.push(Object.values(crystal).filter(v => typeof v === 'string').join(' '));
    }
    const combinedText = texts.join(' ');

    // 提取标签
    const tags = extractTags(combinedText, 5);
    if (tags.length === 0) return [];

    // 更新 inspirations 表的 tags 字段（JSON 数组字符串）
    const tagsJson = JSON.stringify(tags);
    try {
      db.run(`UPDATE inspirations SET tags = '${tagsJson.replace(/'/g, "''")}' WHERE id = '${inspirationId}'`);
      saveDb();
    } catch (dbErr) {
      console.warn('[autoTagService] Failed to update tags:', dbErr.message);
    }

    return tags;
  } catch (e) {
    console.error('[autoTagService] autoTag error:', e.message);
    return [];
  }
}

export default { extractTags, autoTag };
