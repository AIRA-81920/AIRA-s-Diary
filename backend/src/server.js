// 服务器入口 — AIRA's Diary 后端主程序
// 启动流程：加载环境变量 → 初始化数据库 → 创建 Express 应用 → 挂载中间件与路由 → 监听端口
//
// Electron 打包适配（重构版）：
//   - 抽出 createApp() / startServer() 导出，供 Electron 主进程「单进程嵌入后端」复用
//   - 模块顶层不再自动监听端口，仅「直接运行时」（node src/server.js）才自动启动
//   - 移除 process.exit（避免误杀 Electron 主进程），DB 失败以 rejected Promise 上报
//   - 数据/上传路径统一走 config/paths.js（打包后由 env 注入 %APPDATA%）
//
// 安全加固（SEC-002/SEC-011/SEC-014/SEC-018、CR-04/CR-10/CR-18）：
//   - 仅绑定 127.0.0.1（局域网不可达）
//   - 生产模式移除 cors()；开发模式仅白名单 Vite dev server
//   - LOCAL_API_TOKEN 本地一次性令牌（Electron 主进程启动时生成并注入），
//     所有 /api 请求必须携带 x-local-token；未配置令牌时（纯 Web 开发）回退 Origin/Host 校验
//   - CSP 安全响应头；express.json 2mb 上限；统一错误中间件（内部错误不回显 e.message）

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

// 加载 .env 环境变量（必须在导入依赖环境变量的模块之前调用）
dotenv.config();

import { initDb, reconcileStartupState } from './database/db.js';
import apiRoutes from './routes/api.js';
import crystallizeRoutes from './routes/crystallizeRoutes.js';
import epitaxyRoutes from './routes/epitaxyRoutes.js';
import coalesceRoutes from './routes/coalesceRoutes.js';
import addendumRoutes from './routes/addendumRoutes.js';
import explainRoutes from './routes/explainRoutes.js';
import assimilateRoutes from './routes/assimilateRoutes.js';
import settingsRoutes from './routes/settings.js';
import folderRoutes from './routes/folderRoutes.js';
import { printModelConfig } from './config/modelConfig.js';
// Electron 路径适配：数据根 / uploads 根统一走 paths
import { resolveDataInspirationsDir, resolveUploadsRoot } from './config/paths.js';
import { EmbeddingService } from './services/embeddingService.js';
import { CoalesceReaperService } from './services/coalesceReaperService.js';
// 快照机制：过期快照清理服务
import { startSnapshotCleanup, stopSnapshotCleanup } from './services/snapshotCleanupService.js';

// ========== 本地 API 令牌（SEC-002/SEC-014） ==========
// 功能：Electron 主进程启动时生成随机令牌写入 process.env.LOCAL_API_TOKEN，
//       前端经 preload 拿到令牌后统一附加 x-local-token 头，本中间件校验。
//       未配置令牌（纯 Web 开发模式）时退化为 Origin/Host 校验，拒绝跨源网页调用。
const LOCAL_API_TOKEN = process.env.LOCAL_API_TOKEN || '';

// 允许的来源（开发模式 Vite dev server / Electron 同源 localhost）
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

function originAllowed(req) {
  // 无 Origin 头（curl/桌面应用同源导航/SSE EventSource）：结合令牌或 Host 校验
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = req.headers.host || '';
    // 同源：Origin 的主机部分与 Host 头一致（如 http://localhost:53123）
    if (`${u.hostname}:${u.port}` === host || u.hostname === host) return true;
  } catch { /* 非法 Origin 拒绝 */ }
  return ALLOWED_ORIGINS.has(origin);
}

/**
 * API 鉴权中间件
 * 令牌模式：必须携带与 LOCAL_API_TOKEN 一致的 x-local-token
 * 回退模式：校验 Origin（阻止浏览器恶意网页跨源调用本机 API）
 */
function localAuthMiddleware(req, res, next) {
  if (LOCAL_API_TOKEN) {
    if (req.headers['x-local-token'] === LOCAL_API_TOKEN) return next();
    return res.status(401).json({ success: false, error: 'Unauthorized: missing or invalid local token' });
  }
  if (originAllowed(req)) return next();
  return res.status(403).json({ success: false, error: 'Forbidden: cross-origin request rejected' });
}

// ========== LLM 端点简单节流（SEC-014） ==========
// 功能：同一灵感 + 同一 stage 的 LLM 调用节流，防恶意网页/脚本刷量消耗用户密钥额度。
//       进程内内存实现，桌面单用户场景足够。
// 节流键：`${key}:${id}:${stage}`（stage 取自 req.body.stage，缺失兜底 '_'）。
// 窗口：由用户点击直接驱动的交互阶段（tension / initial / questioning / generate_crystal）用**秒级短窗**防连点；
//       其余自动化重任务沿用 60 秒冷却。
// 修复原因（存量缺陷）：POST /crystallize/run 承载的是「一问一答」交互——v2 改造后 `tension → 勾选 → initial`
//       是两次紧邻调用，若沿用 60 秒冷却必然撞 429（答完一题立刻点下一题同理）。
//       开发模式（未配置本地令牌）旁路，故该问题此前未暴露。stage 加入键后，各阶段互不占用彼此窗口。
const llmThrottleMap = new Map();
const LLM_THROTTLE_MS = 60 * 1000;
// 交互驱动阶段的短窗（秒级）：只防连点，不阻塞正常的一问一答
const LLM_THROTTLE_INTERACTIVE_MS = 2 * 1000;
// 由用户点击直接驱动、需要允许连续调用的阶段集合
const LLM_INTERACTIVE_STAGES = new Set(['tension', 'initial', 'questioning', 'generate_crystal']);
function llmThrottle(key) {
  return (req, res, next) => {
    // 开发模式（未配置本地令牌 = 纯 Web 开发）旁路限速：避免调试结晶/外延时撞冷却
    if (!LOCAL_API_TOKEN) return next();
    const id = req.params?.id || req.body?.inspirationId || '_';
    // 节流键加入 stage：同一灵感的「找张力对 / 出首题 / 逐题追问 / 生成结晶」互不占用彼此窗口
    const stage = (typeof req.body?.stage === 'string' && req.body.stage) ? req.body.stage : '_';
    const mapKey = `${key}:${id}:${stage}`;
    // 交互阶段用短窗，其余（非交互重任务）用 60 秒冷却
    // 提问支路（explain）是用户点击驱动的交互类调用，只防连点，不占用结晶的 60s 冷却
    const isInteractive = LLM_INTERACTIVE_STAGES.has(stage) || key === 'explain';
    const windowMs = isInteractive ? LLM_THROTTLE_INTERACTIVE_MS : LLM_THROTTLE_MS;
    const last = llmThrottleMap.get(mapKey) || 0;
    const now = Date.now();
    if (now - last < windowMs) {
      return res.status(429).json({ success: false, error: `请求过于频繁，请 ${Math.ceil((windowMs - (now - last)) / 1000)} 秒后再试` });
    }
    llmThrottleMap.set(mapKey, now);
    next();
  };
}

/**
 * 创建 Express 应用（中间件 + 全部 API 路由 + 可选 serve 前端 dist）
 * 功能：Electron 单进程方案中，后端同时 serve 前端静态文件，实现同源访问
 *       （前端相对路径 BASE_URL='/api'、/uploads、fetch 流式对话全部同源直连）。
 * 实现方式：
 *   - 若传入 frontendDist，挂载 express.static + SPA fallback（app.get('*')）
 *   - 不传则纯 API（Web 开发模式由 Vite dev server 代理到本服务）
 * @param {{ frontendDist?: string|null }} [options]
 * @returns {import('express').Express}
 */
export function createApp({ frontendDist = null } = {}) {
  const app = express();

  // 安全响应头（SEC-011：CSP 采用 Report-Only 先行策略——4.5.0 冻结窗口不拦截，
  // 只记录违规供 5.x 收集后转 enforcing；X-Frame-Options/nosniff 等无害头保持 enforcing）
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy-Report-Only',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'"
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // CORS：生产模式（Electron 同源）完全移除；
  // 开发模式（Vite dev server 跨源）仅白名单 localhost:5173，禁止任意网页跨源调用
  if (!frontendDist) {
    app.use(cors({ origin: [...ALLOWED_ORIGINS], credentials: false }));
  }

  // JSON body 解析（CR-18：默认 100KB 上限对长正文/长对话过紧，显式放宽到 2mb）
  app.use(express.json({ limit: '2mb' }));

  // 上传目录静态资源服务（/uploads → 上传根目录，含 addenda/、neoidea/）
  // 随 127.0.0.1 绑定后仅本机可达（SEC-015 收敛）
  const uploadsPath = resolveUploadsRoot();
  fs.mkdirSync(path.join(uploadsPath, 'addenda'), { recursive: true });
  app.use('/uploads', express.static(uploadsPath));

  // API 鉴权：所有 /api 请求过本地令牌 / Origin 校验
  app.use('/api', localAuthMiddleware);

  // LLM 触发类端点节流（SEC-014：防刷量消耗密钥额度；键含 stage，交互阶段秒级短窗、其余 60s）
  app.use('/api/inspirations/:id/crystallize/run', llmThrottle('crystallize'));
  app.use('/api/inspirations/:id/epitaxy/excavate', llmThrottle('excavate'));
  app.use('/api/inspirations/:id/distill', llmThrottle('distill'));
  app.use('/api/inspirations/:id/epitaxy/propose', llmThrottle('propose'));
  app.use('/api/explain', llmThrottle('explain'));

  // 挂载所有 API 路由（统一前缀 /api）
  app.use('/api', apiRoutes);
  app.use('/api', explainRoutes);
  app.use('/api', assimilateRoutes);
  app.use('/api', crystallizeRoutes);
  app.use('/api', epitaxyRoutes);
  app.use('/api', coalesceRoutes);
  app.use('/api', addendumRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/folders', folderRoutes);

  // Electron 生产模式：serve 前端 dist 静态文件 + SPA fallback
  // 需在路由之后挂载，保证 /api、/uploads 优先匹配，前端路由回退到 index.html
  if (frontendDist) {
    const distAbs = path.resolve(frontendDist);
    const indexPath = path.join(distAbs, 'index.html');
    app.use(express.static(distAbs));
    // SPA fallback：非 /api、/uploads 的 GET 请求回退到 index.html（支持前端路由刷新）
    app.get(/^(?!\/api|\/uploads).*/, (req, res) => {
      res.sendFile(indexPath);
    });
  }

  // 统一错误中间件（SEC-018/CR-10/CR-18）：
  //  - expose=true 的业务错误（如路径遍历 400）按原 message 返回
  //  - 其余内部错误仅记日志，对外返回通用文案（不回显 SQL/文件路径等内部信息）
  //  - body 超限（PayloadTooLargeError）映射为 413 JSON
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ success: false, error: '请求体过大（上限 2MB）' });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, error: '请求体不是合法的 JSON' });
    }
    const status = err.status || 500;
    if (status >= 500) {
      console.error('[Server] Internal error:', err.message);
    }
    const message = (err.expose || status < 500) ? (err.message || '请求失败') : '服务器内部错误';
    res.status(status).json({ success: false, error: message });
  });

  return app;
}

/**
 * 优雅关闭句柄（供 Electron 主进程 before-quit 调用）
 * 实现：停止 reaper 定时器 + 快照清理定时器 + 关闭 HTTP server
 * @param {import('http').Server} server - app.listen 返回的 server 实例
 */
export function stopServer(server) {
  try { CoalesceReaperService.stop(); } catch (_) {}
  try { stopSnapshotCleanup(); } catch (_) {}
  if (server && typeof server.close === 'function') server.close();
}

/**
 * 启动后端（供 Electron 主进程「单进程嵌入」复用）
 * 功能：顺序执行 initDb → 启动对账 → 创建 app → 异步预热 embedding → 监听端口 → 启动后台服务
 * 实现方式：
 *   - DB 初始化失败以 rejected Promise 上报（不再 process.exit），由调用方决定处理
 *   - 通过 onReady 回调把实际监听端口交回调用方（端口=0 时），方便前端同源加载
 *   - 仅绑定 127.0.0.1（SEC-002：局域网主机不可达）
 * @param {{ port?: number, frontendDist?: string|null, onReady?: (port:number)=>void }} [options]
 * @returns {Promise<{ server: import('http').Server, port: number }>}
 */
export async function startServer({ port = 3001, frontendDist = null, onReady } = {}) {
  // 确保 per-inspiration 数据目录存在（数据库文件与灵感文件夹均存放于此，recursive 幂等）
  fs.mkdirSync(resolveDataInspirationsDir(), { recursive: true });

  // 1. 初始化数据库（失败则 reject，不退出进程）
  await initDb();

  // 2. 启动对账（CR-04）：复位上次进程遗留的"提炼中(3)"/"generating"状态，避免前端永久转圈
  reconcileStartupState();

  // 3. 创建 Express 应用（Electron 生产模式同时 serve 前端 dist）
  const app = createApp({ frontendDist });

  // 4. 异步预热 embedding 模型（fire-and-forget，不阻塞 listen；失败不退出进程）
  EmbeddingService.init().catch((err) => {
    console.error('[Server] EmbeddingService init failed (scan/coalesce will be unavailable):', err.message);
  });

  // 5. 监听端口并启动后台服务（仅回环地址）
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(port, '127.0.0.1', () => {
      const actualPort = srv.address().port;
      console.log(`[Server] Running on http://127.0.0.1:${actualPort}`);
      // 打印当前生效的模型配置（便于确认 .env 中的自定义是否生效）
      printModelConfig();
      // 启动 Coalesce Reaper 对账扫描器（5 天周期）
      CoalesceReaperService.start();
      // 启动过期快照清理器（30s 后首跑，之后每 24h）
      startSnapshotCleanup();
      // 把实际端口和 server 交回调用方
      onReady?.(actualPort, srv);
      resolve(srv);
    });
    srv.on('error', (err) => {
      // 端口被占用等监听失败：向上抛错（Electron 可据此处理）
      reject(err);
    });
  });

  return { server, port: server.address().port };
}

// ============ 直接运行守卫：仅当 node src/server.js 时才自动启动 ============
// 功能：嵌入 Electron（import 本模块）时不触发任何进程级副作用（监听/定时器/信号处理）
// 实现：对比 process.argv[1]（node 脚本路径）与当前模块 URL 是否一致
const isDirectRun = (() => {
  try {
    const entry = process.argv[1];
    return entry && pathToFileURL(path.resolve(entry)).href === import.meta.url;
  } catch (_) {
    return false;
  }
})();

if (isDirectRun) {
  // 直接运行：自动启动（Web 开发/测试沿用现状）
  startServer()
    .catch((err) => {
      // DB 初始化失败：打印错误并退出（直接运行场景进程生命周期由 node 管理，安全）
      console.error('[Server] Failed to start:', err.message);
      process.exitCode = 1;
    });

  // 注册 SIGINT/SIGTERM 处理器，优雅停止后台定时器（直接运行场景不打断 Electron）
  process.on('SIGINT', () => {
    // 无法直接拿 server 引用时，仅停止后台服务；退出由事件循环自然结束
    try { CoalesceReaperService.stop(); } catch (_) {}
    try { stopSnapshotCleanup(); } catch (_) {}
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    try { CoalesceReaperService.stop(); } catch (_) {}
    try { stopSnapshotCleanup(); } catch (_) {}
    process.exit(0);
  });
}

export { llmThrottle };
