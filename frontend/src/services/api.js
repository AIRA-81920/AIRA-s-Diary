// 前端 API 服务层
// 功能：封装所有对后端 /api 的 HTTP 调用，统一处理 JSON 序列化与错误
// 实现方式：以 request 通用函数为底座，每个具体方法只负责拼路径与参数
//
// M3 变更：原 Clarify 相关方法重命名为 Crystallize，端点前缀 /clarify/ → /crystallize/
const BASE_URL = '/api'

/**
 * 通用请求函数
 * 功能：发起 fetch 请求，自动设置 JSON 请求头，处理非 ok 响应并返回 JSON
 * 实现方式：
 *   1. 若存在 body 且未显式指定 Content-Type，则默认 application/json
 *   2. 响应非 ok 时尝试解析错误信息并抛出 Error
 *   3. 空响应体（如 204）返回空对象，避免 JSON.parse 报错
 * @param {string} path - 拼接在 BASE_URL 之后的路径，如 /inspirations
 * @param {object} options - 透传给 fetch 的配置项
 * @returns {Promise<any>} 后端返回的 JSON 数据
 */
async function request(path, options = {}) {
  const headers = { ...options.headers }
  // 存在请求体时自动设置 Content-Type 为 JSON
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers })

  // 非 ok 响应：尝试提取后端错误信息后抛出
  if (!res.ok) {
    let errMsg = `请求失败：HTTP ${res.status}`
    try {
      const errBody = await res.json()
      errMsg = errBody.error || errBody.message || errMsg
    } catch {
      // 响应非 JSON 时保留默认错误信息
    }
    throw new Error(errMsg)
  }

  // 处理空响应体（DELETE 等可能返回 204 或空 body）
  const text = await res.text()
  if (!text) return {}
  return JSON.parse(text)
}

// ========== 灵感相关 API ==========

/**
 * 获取灵感列表（支持分页与搜索）
 * @param {object} params - { limit, offset, search }
 * @returns {Promise<{data: Array, total: number}>}
 */
export function getInspirations(params = {}) {
  // 用 URLSearchParams 拼接 query string，自动跳过 undefined/null
  const query = new URLSearchParams()
  if (params.limit != null) query.set('limit', params.limit)
  if (params.offset != null) query.set('offset', params.offset)
  if (params.search) query.set('search', params.search)
  const qs = query.toString()
  return request(`/inspirations${qs ? `?${qs}` : ''}`)
}

/**
 * 获取单个灵感详情
 * @param {string} id
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function getInspiration(id) {
  return request(`/inspirations/${id}`)
}

/**
 * 创建灵感
 * @param {object} data - { title, content, source_type, source_url }
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function createInspiration(data) {
  return request('/inspirations', {
    method: 'POST',
    body: JSON.stringify(data)
  })
}

/**
 * 更新灵感
 * @param {string} id
 * @param {object} data - 待更新字段
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function updateInspiration(id, data) {
  return request(`/inspirations/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  })
}

/**
 * 删除灵感
 * @param {string} id
 * @returns {Promise<{success: boolean}>}
 */
export function deleteInspiration(id) {
  return request(`/inspirations/${id}`, {
    method: 'DELETE'
  })
}

/**
 * 搜索灵感
 * @param {string} q - 关键词
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function searchInspirations(q) {
  const query = new URLSearchParams()
  if (q) query.set('q', q)
  return request(`/inspirations/search${query.toString() ? `?${query}` : ''}`)
}

// ========== 灵感存储与面板状态 API ==========

/**
 * 初始化灵感的 per-inspiration 文件存储
 * @param {string} id
 */
export function initStorage(id) {
  return request(`/inspirations/${id}/storage/init`, {
    method: 'POST'
  })
}

/**
 * 保存面板状态
 * @param {string} id
 * @param {object} state - { crystallizeCollapsed, leftCollapsed, rightCollapsed }
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function savePanelState(id, state) {
  return request(`/inspirations/${id}/panel-state`, {
    method: 'POST',
    body: JSON.stringify(state)
  })
}

/**
 * 获取面板状态
 * @param {string} id
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function getPanelState(id) {
  return request(`/inspirations/${id}/panel-state`)
}

/**
 * 获取灵感档案馆聚合数据（K3-d 新增，§9.2 契约）
 * 功能：Detail 唯一数据源，合并三阶段产物 + 徽章口径
 * @param {string} id - 灵感 ID
 * @returns {Promise<{success: boolean, data: object}>} ArchiveResponse
 */
export function getArchive(id) {
  return request(`/inspirations/${id}/archive`)
}

/**
 * 获取力导向图全量数据（K3-c 新增）
 * @returns {Promise<{success: boolean, data: {nodes: Array, edges: Array}}>}
 */
export function getCoalesceGraph() {
  return request('/coalesce/graph')
}

/**
 * 策展桥梁：确认或忽略（K3-c 新增）
 * @param {string} bridgeId - 桥梁 ID
 * @param {string} action - 'confirm' | 'dismiss'
 * @returns {Promise<{success: boolean, data: object}>} BridgeRecord
 */
export function curateBridge(bridgeId, action) {
  return request(`/coalesce/bridges/${bridgeId}`, {
    method: 'PATCH',
    body: JSON.stringify({ action })
  })
}

/**
 * 桥梁转新灵感（K3-c 改造路径）
 * @param {string} bridgeId - 桥梁 ID
 * @returns {Promise<{success: boolean, data: {inspiration: object, sourceBridgeId: string}}>}
 */
export function bridgeToInspirationNew(bridgeId) {
  return request(`/coalesce/bridges/${bridgeId}/to-inspiration`, { method: 'POST' })
}

// ========== Crystallize（灵感结晶）API ==========
// 端点前缀：/inspirations/:id/crystallize/*
// 功能：调用 CrystallizeAgent 进行灵感结晶，支持 Sense 感知类型 → 定制化追问 → 生成结晶体
// M3-b 变更：新增 senseInspirationType；runCrystallize 透传 inspirationType；新增 updateCrystallizeCrystal

/**
 * 感知灵感类型（Sense 阶段，M3-b 新增）
 * 功能：调用后端 /crystallize/sense，让 LLM 分析灵感文本判断类型
 * @param {string} id - 灵感 ID
 * @param {string} [text] - 可选文本；不传则后端从 inspiration 记录读取
 * @returns {Promise<{success: boolean, data: {type, confidence, alternative_types, reasoning, crystal_type}}>}
 */
export function senseInspirationType(id, text) {
  return request(`/inspirations/${id}/crystallize/sense`, {
    method: 'POST',
    body: JSON.stringify(text ? { text } : {})
  })
}

/**
 * 运行结晶流程
 * @param {string} id - 灵感 ID
 * @param {object} payload - { stage, userInput, crystalDraft, conversationHistory, autoRun, inspirationType }
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function runCrystallize(id, payload) {
  return request(`/inspirations/${id}/crystallize/run`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

/**
 * 获取最新结晶记录
 * @param {string} id - 灵感 ID
 * @returns {Promise<{success: boolean, data: object|null}>}
 */
export function getCrystallizeLatest(id) {
  return request(`/inspirations/${id}/crystallize/latest`)
}

/**
 * 获取结晶历史
 * @param {string} id - 灵感 ID
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function getCrystallizeHistory(id) {
  return request(`/inspirations/${id}/crystallize/history`)
}

/**
 * 更新最新结晶记录的 crystal（M3-b 新增，按类型字段）
 * @param {string} id - 灵感 ID
 * @param {object} crystal - 结晶体对象（结构由 crystal_type 决定）
 * @returns {Promise<{success: boolean}>}
 */
export function updateCrystallizeCrystal(id, crystal) {
  return request(`/inspirations/${id}/crystallize/crystal`, {
    method: 'PUT',
    body: JSON.stringify({ crystal })
  })
}

/**
 * 更新最新结晶记录的 PRD（向后兼容旧路径）
 * @param {string} id - 灵感 ID
 * @param {object} prd - PRD 对象
 * @returns {Promise<{success: boolean}>}
 */
export function updateCrystallizePRD(id, prd) {
  return request(`/inspirations/${id}/crystallize/prd`, {
    method: 'PUT',
    body: JSON.stringify({ prd })
  })
}

/**
 * 从结晶结果手动分流到下一 Agent（如 epitaxy / coalesce）
 * @param {string} id - 灵感 ID
 * @param {object} payload - { targetAgent, prd }
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function dispatchFromCrystallize(id, payload) {
  return request(`/inspirations/${id}/crystallize/dispatch`, {
    method: 'POST',
    body: JSON.stringify(payload)
  })
}

// ========== Epitaxy（外延探究）API ==========
// 端点前缀：/inspirations/:id/epitaxy/*
// 功能：方向提案 → 深挖笔记（含可点击词块）→ 用户选词提炼

/**
 * 生成方向提案
 * @param {string} id - 灵感 ID
 * @param {object} crystal - 结晶体
 * @returns {Promise<{success: boolean, data: {proposals: Array}}>}
 */
export function proposeEpitaxy(id, crystal) {
  return request(`/inspirations/${id}/epitaxy/propose`, {
    method: 'POST',
    body: JSON.stringify({ crystal })
  })
}

/**
 * 获取所有提案
 * @param {string} id - 灵感 ID
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function getEpitaxyProposals(id) {
  return request(`/inspirations/${id}/epitaxy/proposals`)
}

/**
 * 深挖某方向
 * @param {string} id - 灵感 ID
 * @param {string} proposalId - 提案 ID
 * @returns {Promise<{success: boolean, data: {fragments: Array}}>}
 */
export function excavateEpitaxy(id, proposalId) {
  return request(`/inspirations/${id}/epitaxy/excavate`, {
    method: 'POST',
    body: JSON.stringify({ proposalId })
  })
}

/**
 * 获取某方向的深挖结果
 * @param {string} id - 灵感 ID
 * @param {string} proposalId - 提案 ID
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function getEpitaxyExcavation(id, proposalId) {
  return request(`/inspirations/${id}/epitaxy/excavation/${proposalId}`)
}

/**
 * 保存提炼词块
 * @param {string} id - 灵感 ID
 * @param {Array} chunks - 词块数组 [{fragmentId, originalText, chunkText, kind, subkind, userNote}]
 * @returns {Promise<{success: boolean, data: {chunks: Array}}>}
 */
export function distillEpitaxyChunks(id, chunks) {
  return request(`/inspirations/${id}/epitaxy/distill`, {
    method: 'POST',
    body: JSON.stringify({ chunks })
  })
}

/**
 * 获取所有词块
 * @param {string} id - 灵感 ID
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function getEpitaxyChunks(id) {
  return request(`/inspirations/${id}/epitaxy/chunks`)
}

/**
 * 词块转新灵感
 * @param {string} id - 灵感 ID
 * @param {Array<string>} chunkIds - 词块 ID 数组
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function chunkToInspiration(id, chunkIds) {
  return request(`/inspirations/${id}/epitaxy/chunk-to-inspiration`, {
    method: 'POST',
    body: JSON.stringify({ chunkIds })
  })
}

// ========== Coalesce（跨灵感桥梁）API ==========
// 端点前缀：/inspirations/:id/coalesce/*
// 功能：向量扫描候选对 → LLM 深挖桥梁 → 桥梁转新灵感

/**
 * 触发向量扫描
 * @param {string} id - 灵感 ID
 * @returns {Promise<{success: boolean, data: {candidates: Array}}>}
 */
export function scanCoalesce(id) {
  return request(`/inspirations/${id}/coalesce/scan`, { method: 'POST' })
}

/**
 * 获取候选对
 * @param {string} id - 灵感 ID
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function getCoalesceCandidates(id) {
  return request(`/inspirations/${id}/coalesce/candidates`)
}

/**
 * LLM 深挖桥梁
 * @param {string} id - 灵感 ID
 * @param {Array<string>} [candidateIds] - 可选指定候选对 ID
 * @returns {Promise<{success: boolean, data: {bridges: Array}}>}
 */
export function excavateCoalesceBridges(id, candidateIds) {
  return request(`/inspirations/${id}/coalesce/excavate`, {
    method: 'POST',
    body: JSON.stringify(candidateIds ? { candidateIds } : {})
  })
}

/**
 * 获取已存桥梁
 * @param {string} id - 灵感 ID
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function getCoalesceBridges(id) {
  return request(`/inspirations/${id}/coalesce/bridges`)
}

/**
 * 桥梁转新灵感
 * @param {string} id - 灵感 ID
 * @param {string} bridgeId - 桥梁 ID
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function bridgeToInspiration(id, bridgeId) {
  return request(`/inspirations/${id}/coalesce/bridge-to-inspiration`, {
    method: 'POST',
    body: JSON.stringify({ bridgeId })
  })
}

// ========== Addenda（追加条目）API ==========
// 端点前缀：/inspirations/:id/addenda 和 /addenda/*
// 功能：灵感原文之后的追加思考时间线，支持文本/链接/图片 + 评论 + 对话探究

/**
 * 获取灵感的追加条目列表
 * @param {string} inspirationId - 灵感 ID
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function listAddenda(inspirationId) {
  return request(`/inspirations/${inspirationId}/addenda`)
}

/**
 * 创建追加条目
 * @param {string} inspirationId - 灵感 ID
 * @param {object} data - { content, links, images }
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function createAddendum(inspirationId, data) {
  return request(`/inspirations/${inspirationId}/addenda`, {
    method: 'POST',
    body: JSON.stringify(data)
  })
}

/**
 * 更新追加条目
 * @param {string} addendumId - 追加条目 ID
 * @param {object} data - { content, links, images }
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function updateAddendum(addendumId, data) {
  return request(`/addenda/${addendumId}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  })
}

/**
 * 删除追加条目
 * @param {string} addendumId - 追加条目 ID
 * @returns {Promise<{success: boolean}>}
 */
export function deleteAddendum(addendumId) {
  return request(`/addenda/${addendumId}`, {
    method: 'DELETE'
  })
}

/**
 * 创建评论
 * @param {string} inspirationId - 灵感 ID
 * @param {string} addendumId - 追加条目 ID
 * @param {string} content - 评论核心文本
 * @param {string} [context] - 评论展开/阐释部分（可空，用于折叠展示）
 * @returns {Promise<{success: boolean, data: object}>}
 */
// 创建评论：路径与后端路由 /inspirations/:id/addenda/:addendumId/comments 对齐
// v9：新增 context 字段透传，后端 addendumService.createComment 接收第三个参数
export function createComment(inspirationId, addendumId, content, context) {
  // 仅在 context 非空时加入 body，避免后端收到 undefined 字符串
  const body = context ? { content, context } : { content };
  return request(`/inspirations/${inspirationId}/addenda/${addendumId}/comments`, {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

/**
 * 更新评论
 * @param {string} commentId - 评论 ID
 * @param {string} content - 新评论核心文本
 * @param {string} [context] - 新评论展开/阐释部分（undefined 表示不更新该字段）
 * @returns {Promise<{success: boolean, data: object}>}
 */
// v9：新增可选 context 参数；undefined 不传入 body，后端 service 判断后不更新该字段
export function updateComment(commentId, content, context) {
  // context === undefined 时不更新该字段；显式传 null 表示清空
  const body = context !== undefined ? { content, context } : { content };
  return request(`/comments/${commentId}`, {
    method: 'PUT',
    body: JSON.stringify(body)
  })
}

/**
 * 删除评论
 * @param {string} commentId - 评论 ID
 * @returns {Promise<{success: boolean}>}
 */
export function deleteComment(commentId) {
  return request(`/comments/${commentId}`, {
    method: 'DELETE'
  })
}

/**
 * 保存对话回答到 DB（书签）
 * @param {string} inspirationId - 灵感 ID
 * @param {string} addendumId - 追加条目 ID
 * @param {object} data - { question, answer }
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function saveReply(inspirationId, addendumId, data) {
  return request(`/inspirations/${inspirationId}/addenda/${addendumId}/replies`, {
    method: 'POST',
    body: JSON.stringify(data)
  })
}

/**
 * 删除已保存的对话回答
 * @param {string} replyId - 回答 ID
 * @returns {Promise<{success: boolean}>}
 */
export function deleteReply(replyId) {
  return request(`/replies/${replyId}`, {
    method: 'DELETE'
  })
}

/**
 * 获取所有灵感的已保存对话回答（继续思考面板用）
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function listAllSavedReplies() {
  return request('/addenda/saved-replies')
}

/**
 * 对话探究：向 AI 提问
 * @param {string} inspirationId - 灵感 ID
 * @param {string} addendumId - 追加条目 ID
 * @param {object} data - { question, history }
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function askConversation(inspirationId, addendumId, data) {
  return request(`/inspirations/${inspirationId}/addenda/${addendumId}/conversation`, {
    method: 'POST',
    body: JSON.stringify(data)
  })
}

/**
 * 流式对话（SSE）
 * 功能：向 /conversation/stream 发起 POST，通过 ReadableStream 逐帧解析 SSE，
 *       每个 delta 立刻回调 onDelta，结束时回调 onDone，出错回调 onError
 * 实现方式：
 *   1. 用原生 fetch（不走 request 封装，因 request 会 await json()，不适合流）
 *   2. 拿到 response.body.getReader()，循环 read()，按 \n\n 分割 SSE 帧
 *   3. 每帧形如 "data: {...}\n\n"，解析 JSON 后按 type 分发回调
 *   4. 缓冲区处理：一个 chunk 可能含多帧也可能含半帧，用 buffer 拼接后按 \n\n 切割
 *   5. 返回一个 { abort } 控制器，调用方可主动中断流
 * @param {string} inspirationId
 * @param {string} addendumId
 * @param {{question: string, history?: Array}} data
 * @param {{onDelta?: (text: string) => void, onDone?: (searchUsed: boolean) => void, onError?: (err: string) => void}} handlers
 * @returns {Promise<{abort: () => void}>}
 */
export async function askConversationStream(inspirationId, addendumId, data, { onDelta, onDone, onError } = {}) {
  const controller = new AbortController();

  // 异步执行流式读取；不 await，让调用方拿到 abort 控制器
  (async () => {
    try {
      const res = await fetch(`${BASE_URL}/inspirations/${inspirationId}/addenda/${addendumId}/conversation/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      if (!res.ok) {
        // 非 2xx：尝试读 error 字段
        let errMsg = `HTTP ${res.status}`;
        try {
          const errBody = await res.json();
          errMsg = errBody.error || errBody.message || errMsg;
        } catch {
          // 非 JSON 错误保留默认信息
        }
        if (onError) onError(errMsg);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      // 循环读取 chunk，按 SSE 帧边界（\n\n）分割
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 按双换行切帧；最后一段可能不完整，留在 buffer 等下一轮
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';

        for (const frame of frames) {
          // 每帧可能多行，只取 data: 开头的行（忽略 event:/id:/注释行）
          const dataLines = frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trimStart());
          if (dataLines.length === 0) continue;
          const jsonStr = dataLines.join('\n');
          try {
            const payload = JSON.parse(jsonStr);
            if (payload.type === 'delta' && onDelta) {
              onDelta(payload.text || '');
            } else if (payload.type === 'done') {
              if (onDone) onDone(!!payload.searchUsed);
            } else if (payload.type === 'error') {
              if (onError) onError(payload.error || '未知错误');
            }
          } catch {
            // 单帧 JSON 解析失败：跳过，不中断整个流
            console.warn('[askConversationStream] skip bad frame:', jsonStr);
          }
        }
      }
    } catch (err) {
      // AbortError 是主动中断，不算错误
      if (err.name === 'AbortError') return;
      if (onError) onError(err.message);
    }
  })();

  // 返回 abort 方法，调用方可中断流
  return { abort: () => controller.abort() };
}

/**
 * 上传追加条目图片
 * 功能：用 FormData 直接 fetch 上传，不走 request 封装（因 request 默认 JSON）
 * @param {File} file - 图片文件
 * @returns {Promise<{success: boolean, data: { filename, url }}>}
 */
export async function uploadAddendumImage(file) {
  const formData = new FormData()
  formData.append('image', file)
  const res = await fetch(`${BASE_URL}/addenda/upload-image`, {
    method: 'POST',
    body: formData
  })
  if (!res.ok) {
    let errMsg = `上传失败：HTTP ${res.status}`
    try {
      const errBody = await res.json()
      errMsg = errBody.error || errBody.message || errMsg
    } catch {
      // 非 JSON 错误保留默认信息
    }
    throw new Error(errMsg)
  }
  const text = await res.text()
  if (!text) return {}
  return JSON.parse(text)
}

// ========== 文件夹 API（v8 新增） ==========

/**
 * 获取所有文件夹（含灵感计数）
 * @returns {Promise<{success: boolean, data: Array}>}
 */
export function getFolders() {
  return request('/folders')
}

/**
 * 创建文件夹
 * @param {{ name?: string, color?: string }} data
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function createFolder(data) {
  return request('/folders', {
    method: 'POST',
    body: JSON.stringify(data)
  })
}

/**
 * 更新文件夹（名称/颜色/排序）
 * @param {string} id
 * @param {{ name?: string, color?: string, sort_order?: number }} data
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function updateFolder(id, data) {
  return request(`/folders/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data)
  })
}

/**
 * 删除文件夹（灵感散出，不删灵感）
 * @param {string} id
 * @returns {Promise<{success: boolean}>}
 */
export function deleteFolder(id) {
  return request(`/folders/${id}`, {
    method: 'DELETE'
  })
}

/**
 * 批量更新文件夹排序
 * @param {Array<{id: string, sort_order: number}>} items
 * @returns {Promise<{success: boolean}>}
 */
export function reorderFolders(items) {
  return request('/folders/reorder', {
    method: 'PUT',
    body: JSON.stringify({ items })
  })
}

/**
 * 移动灵感到文件夹（或散出）
 * @param {string} inspirationId
 * @param {string|null} folderId - null 表示散出
 * @param {number} [sortOrder]
 * @returns {Promise<{success: boolean, data: object}>}
 */
export function moveInspiration(inspirationId, folderId, sortOrder) {
  return request(`/inspirations/${inspirationId}/move`, {
    method: 'PATCH',
    body: JSON.stringify({ folder_id: folderId, sort_order: sortOrder })
  })
}

/**
 * 批量更新灵感排序
 * @param {Array<{id: string, sort_order: number, folder_id?: string|null}>} items
 * @returns {Promise<{success: boolean}>}
 */
export function reorderInspirations(items) {
  return request('/inspirations/reorder', {
    method: 'PUT',
    body: JSON.stringify({ items })
  })
}

// 默认导出所有方法，便于按需引入
export default {
  request,
  getInspirations,
  getInspiration,
  createInspiration,
  updateInspiration,
  deleteInspiration,
  searchInspirations,
  initStorage,
  savePanelState,
  getPanelState,
  getArchive,
  getCoalesceGraph,
  curateBridge,
  bridgeToInspirationNew,
  senseInspirationType,
  runCrystallize,
  getCrystallizeLatest,
  getCrystallizeHistory,
  updateCrystallizeCrystal,
  updateCrystallizePRD,
  dispatchFromCrystallize,
  proposeEpitaxy,
  getEpitaxyProposals,
  excavateEpitaxy,
  getEpitaxyExcavation,
  distillEpitaxyChunks,
  getEpitaxyChunks,
  chunkToInspiration,
  scanCoalesce,
  getCoalesceCandidates,
  excavateCoalesceBridges,
  getCoalesceBridges,
  bridgeToInspiration,
  listAddenda,
  createAddendum,
  updateAddendum,
  deleteAddendum,
  createComment,
  updateComment,
  deleteComment,
  saveReply,
  deleteReply,
  listAllSavedReplies,
  askConversation,
  askConversationStream,
  uploadAddendumImage,
  getFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  reorderFolders,
  moveInspiration,
  reorderInspirations
}
