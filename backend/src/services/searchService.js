// SearchService — Serper 联网搜索服务（v7 追加条目对话专用）
// 功能：封装 Serper API 调用，为 ConversationAgent 提供实时联网搜索能力
// 实现方式：
//   1. 从环境变量读取 SERPER_API_KEY（缺失时返回空结果，不阻塞对话）
//   2. POST https://google.serper.dev/search，返回结构化搜索结果
//   3. 结果裁剪为前 N 条，每条含 title/url/snippet，避免 prompt 膨胀
//   4. 带超时控制（10s），失败静默降级返回空数组
//
// 设计原则：
//   - 搜索是"增强"而非"必需"——无 key 或请求失败时对话照常进行
//   - 结果精简化——只取 title+url+snippet，不返回完整页面内容
//   - 对调用方透明——返回 { results, used } 供 Agent 标记 searchUsed

const SERPER_ENDPOINT = 'https://google.serper.dev/search';
const SERPER_TIMEOUT_MS = 10000; // 10 秒超时
const SERPER_MAX_RESULTS = 5;    // 每次搜索最多返回 5 条

/**
 * 执行 Serper 搜索
 * 功能：调用 Serper API 获取搜索结果，返回精简化结果数组
 * 实现方式：fetch POST + AbortController 超时控制 + 结果裁剪
 * @param {string} query - 搜索查询词
 * @returns {Promise<Array<{title:string, url:string, snippet:string}>>}
 */
export async function searchWeb(query) {
  const apiKey = process.env.SERPER_API_KEY;
  // 无 API key 时静默返回空数组，不阻塞对话流程
  if (!apiKey || !apiKey.trim()) {
    console.warn('[SearchService] SERPER_API_KEY not configured, skipping search');
    return [];
  }

  if (!query || !query.trim()) {
    return [];
  }

  // AbortController 实现超时控制
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);

  try {
    const response = await fetch(SERPER_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey.trim(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        q: query,
        num: SERPER_MAX_RESULTS
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      console.warn(`[SearchService] Serper API returned ${response.status}: ${response.statusText}`);
      return [];
    }

    const data = await response.json();
    // Serper 返回 organic 数组，每条含 title/link/snippet
    const organic = Array.isArray(data.organic) ? data.organic : [];
    // 裁剪为标准结构，字段重命名 link → url
    return organic.slice(0, SERPER_MAX_RESULTS).map((item) => ({
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || ''
    }));
  } catch (err) {
    // 超时或网络错误时静默降级
    if (err.name === 'AbortError') {
      console.warn('[SearchService] Search timed out, skipping');
    } else {
      console.warn(`[SearchService] Search failed: ${err.message}`);
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 将搜索结果格式化为 prompt 可读文本
 * 功能：把搜索结果数组转为 LLM 可消费的文本块
 * 实现方式：遍历结果，拼接 title + snippet + url，带序号
 * @param {Array<{title:string, url:string, snippet:string}>} results
 * @returns {string}
 */
export function formatSearchResults(results) {
  if (!results || results.length === 0) return '';
  return results.map((r, i) =>
    `[${i + 1}] ${r.title}\n${r.snippet}\n来源: ${r.url}`
  ).join('\n\n');
}

export default { searchWeb, formatSearchResults };
