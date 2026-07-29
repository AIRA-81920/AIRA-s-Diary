import express from 'express'
import fs from 'fs'
import path from 'path'
import dotenv from 'dotenv'
import OpenAI from 'openai'
import { printModelConfig } from '../config/modelConfig.js'

const router = express.Router()

const ENV_PATH = path.resolve(process.cwd(), '.env')
const ENV_EXAMPLE_PATH = path.resolve(process.cwd(), '.env.example')

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {}
  const content = fs.readFileSync(filePath, 'utf-8')
  const result = {}
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx === -1) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let value = trimmed.slice(eqIdx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function writeEnvFile(filePath, updates) {
  let content
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf-8')
  } else if (fs.existsSync(ENV_EXAMPLE_PATH)) {
    // .env 不存在时，以 .env.example 为模板创建
    content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8')
  } else {
    content = ''
  }
  const lines = content.split('\n')
  for (const [key, value] of Object.entries(updates)) {
    // 跳过空值写入：保留 .env 中已有的 per-agent 配置不被 UI 空字段覆盖
    // 用户如需清除某字段，应直接编辑 .env 文件
    if (value === '' || value === null || value === undefined) continue
    let found = false
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const lineKey = trimmed.slice(0, eqIdx).trim()
      if (lineKey === key) {
        lines[i] = `${key}=${value}`
        found = true
        break
      }
    }
    if (!found) {
      lines.push(`${key}=${value}`)
    }
  }
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8')
}

router.get('/env', (_req, res) => {
  try {
    const envVars = parseEnvFile(ENV_PATH)
    const exampleVars = parseEnvFile(ENV_EXAMPLE_PATH)

    const agentKeys = ['CRYSTALLIZE', 'EPITAXY', 'COALESCE', 'CONVERSATION']

    const global = {
      api_key: envVars.OPENAI_API_KEY || '',
      base_url: envVars.OPENAI_BASE_URL || '',
      default_model: envVars.OPENAI_DEFAULT_MODEL || '',
      default_temperature: envVars.OPENAI_DEFAULT_TEMPERATURE !== undefined
        ? parseFloat(envVars.OPENAI_DEFAULT_TEMPERATURE) : null
    }

    const agents = {}
    for (const agent of agentKeys) {
      agents[agent] = {
        model: envVars[`OPENAI_MODEL_${agent}`] || '',
        temperature: envVars[`OPENAI_TEMP_${agent}`] !== undefined
          ? parseFloat(envVars[`OPENAI_TEMP_${agent}`]) : null,
        api_key: envVars[`OPENAI_API_KEY_${agent}`] || '',
        base_url: envVars[`OPENAI_BASE_URL_${agent}`] || ''
      }
    }

    const search = {
      serper_api_key: envVars.SERPER_API_KEY || ''
    }

    res.json({ global, agents, search })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/env', (req, res) => {
  try {
    const { global = {}, agents = {}, search = {} } = req.body
    const updates = {}

    if (typeof global.api_key === 'string') updates.OPENAI_API_KEY = global.api_key
    if (typeof global.base_url === 'string') updates.OPENAI_BASE_URL = global.base_url
    if (typeof global.default_model === 'string') updates.OPENAI_DEFAULT_MODEL = global.default_model
    if (typeof global.default_temperature === 'number') updates.OPENAI_DEFAULT_TEMPERATURE = String(global.default_temperature)

    for (const [agent, cfg] of Object.entries(agents || {})) {
      const upper = agent.toUpperCase()
      if (typeof cfg.model === 'string') updates[`OPENAI_MODEL_${upper}`] = cfg.model
      if (typeof cfg.temperature === 'number') updates[`OPENAI_TEMP_${upper}`] = String(cfg.temperature)
      if (typeof cfg.api_key === 'string') updates[`OPENAI_API_KEY_${upper}`] = cfg.api_key
      if (typeof cfg.base_url === 'string') updates[`OPENAI_BASE_URL_${upper}`] = cfg.base_url
    }

    if (typeof search.serper_api_key === 'string') updates.SERPER_API_KEY = search.serper_api_key

    writeEnvFile(ENV_PATH, updates)

    // 重新加载 .env 到 process.env，让运行中的进程立即生效（无需重启）
    dotenv.config({ path: ENV_PATH, override: true })
    // 打印更新后的配置到控制台，便于确认生效
    printModelConfig(true)

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * POST /env/test — 检测 API 配置是否可用（不写入 .env）
 * 功能：用前端传入的表单值临时创建客户端发测试请求
 * 实现：并行测试各配置项，Promise.allSettled 收集结果
 */
router.post('/env/test', async (req, res) => {
  const { global = {}, agents = {}, search = {} } = req.body
  const TIMEOUT_MS = 10000  // 单项超时 10s
  const AGENT_LABELS = {
    CRYSTALLIZE: '结晶 Crystallize',
    EPITAXY: '外延 Epitaxy',
    COALESCE: '融合 Coalesce',
    CONVERSATION: '对话 Conversation'
  }

  /**
   * 测试 OpenAI 兼容接口
   * 实现：临时 new OpenAI 客户端，发 max_tokens=5 的最简请求
   */
  async function testOpenAI({ name, apiKey, baseURL, model }) {
    const startedAt = Date.now()
    if (!apiKey || !apiKey.trim()) {
      return { name, ok: false, error: '未配置 API Key', latency: 0 }
    }
    try {
      const client = new OpenAI({
        apiKey: apiKey.trim(),
        baseURL: (baseURL && baseURL.trim()) || 'https://api.openai.com/v1'
      })
      // AbortController 控制超时
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const resp = await client.chat.completions.create(
          {
            model: (model && model.trim()) || 'gpt-4o-mini',
            messages: [{ role: 'user', content: '回复OK' }],
            max_tokens: 5
          },
          { signal: controller.signal }
        )
        return {
          name,
          ok: true,
          latency: Date.now() - startedAt,
          reply: resp.choices?.[0]?.message?.content || '(空)',
          model: (model && model.trim()) || 'gpt-4o-mini',
          baseURL: (baseURL && baseURL.trim()) || 'https://api.openai.com/v1'
        }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      // 提取错误信息：OpenAI SDK 错误有 status/code/message，abort 是超时
      let errorMsg = err.message || '未知错误'
      if (err.name === 'AbortError') errorMsg = `超时 (${TIMEOUT_MS / 1000}s)`
      if (err.status) errorMsg = `${err.status} ${errorMsg}`
      return { name, ok: false, error: errorMsg, latency: Date.now() - startedAt }
    }
  }

  /**
   * 测试 Serper 搜索 API
   * 实现：fetch POST 到 google.serper.dev/search，发最简搜索
   */
  async function testSerper(apiKey) {
    const startedAt = Date.now()
    if (!apiKey || !apiKey.trim()) {
      return { name: 'Serper', ok: false, error: '未配置', latency: 0 }
    }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const resp = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': apiKey.trim(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: 'test', num: 1 }),
          signal: controller.signal
        })
        if (!resp.ok) {
          return { name: 'Serper', ok: false, error: `${resp.status} ${resp.statusText}`, latency: Date.now() - startedAt }
        }
        return { name: 'Serper', ok: true, latency: Date.now() - startedAt }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      let errorMsg = err.message || '未知错误'
      if (err.name === 'AbortError') errorMsg = `超时 (${TIMEOUT_MS / 1000}s)`
      return { name: 'Serper', ok: false, error: errorMsg, latency: Date.now() - startedAt }
    }
  }

  // 收集所有待测项
  const tasks = []

  // 全局配置：必测
  tasks.push(testOpenAI({
    name: '全局配置',
    apiKey: global.api_key,
    baseURL: global.base_url,
    model: global.default_model
  }))

  // per-agent 配置：仅在有独立 apiKey 或 baseURL 覆盖时才单独测
  for (const [key, cfg] of Object.entries(agents || {})) {
    const hasOverride = (cfg.api_key && cfg.api_key.trim()) || (cfg.base_url && cfg.base_url.trim())
    if (!hasOverride) continue
    tasks.push(testOpenAI({
      name: AGENT_LABELS[key] || key,
      apiKey: cfg.api_key || global.api_key,
      baseURL: cfg.base_url || global.base_url,
      model: cfg.model || global.default_model
    }))
  }

  // Serper 搜索：有填才测
  if (search.serper_api_key && search.serper_api_key.trim()) {
    tasks.push(testSerper(search.serper_api_key))
  }

  // 并行发起，allSettled 保证单个失败不影响其他
  const results = await Promise.allSettled(tasks)
  const data = results.map(r => r.status === 'fulfilled' ? r.value : { name: '未知', ok: false, error: r.reason?.message || '异常' })

  res.json({ results: data })
})

router.get('/env/example', (_req, res) => {
  try {
    const example = parseEnvFile(ENV_EXAMPLE_PATH)
    res.json(example)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * 以 .env.example 为模板重置 .env
 * 功能：将 .env.example 复制为 .env，保留完整注释与结构
 * 场景：用户想恢复模板结构，或 .env 被破坏时重建
 */
router.post('/env/reset', (_req, res) => {
  try {
    if (!fs.existsSync(ENV_EXAMPLE_PATH)) {
      return res.status(404).json({ error: '.env.example 模板不存在' })
    }
    const template = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf-8')
    fs.writeFileSync(ENV_PATH, template, 'utf-8')
    res.json({ ok: true, message: '已重置为模板，请重新配置 API 密钥' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * 检查 .env 是否存在
 */
router.get('/env/exists', (_req, res) => {
  res.json({ exists: fs.existsSync(ENV_PATH) })
})

export default router
