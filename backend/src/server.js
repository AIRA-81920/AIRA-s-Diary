// 服务器入口 — AIRA's Diary 后端主程序
// 启动流程：加载环境变量 → 初始化数据库 → 创建 Express 应用 → 挂载中间件与路由 → 监听端口
//
// Electron 打包适配（重构版）：
//   - 抽出 createApp() / startServer() 导出，供 Electron 主进程「单进程嵌入后端」复用
//   - 模块顶层不再自动监听端口，仅「直接运行时」（node src/server.js）才自动启动
//   - 移除 process.exit（避免误杀 Electron 主进程），DB 失败以 rejected Promise 上报
//   - 数据/上传路径统一走 config/paths.js（打包后由 env 注入 %APPDATA%）

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

// 加载 .env 环境变量（必须在导入依赖环境变量的模块之前调用）
dotenv.config();

import { initDb } from './database/db.js';
import apiRoutes from './routes/api.js';
import crystallizeRoutes from './routes/crystallizeRoutes.js';
import epitaxyRoutes from './routes/epitaxyRoutes.js';
import coalesceRoutes from './routes/coalesceRoutes.js';
import addendumRoutes from './routes/addendumRoutes.js';
import settingsRoutes from './routes/settings.js';
import folderRoutes from './routes/folderRoutes.js';
import { printModelConfig } from './config/modelConfig.js';
// Electron 路径适配：数据根 / uploads 根统一走 paths
import { resolveDataInspirationsDir, resolveUploadsRoot } from './config/paths.js';
import { EmbeddingService } from './services/embeddingService.js';
import { CoalesceReaperService } from './services/coalesceReaperService.js';
// 快照机制：过期快照清理服务
import { startSnapshotCleanup, stopSnapshotCleanup } from './services/snapshotCleanupService.js';

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

  // 中间件：CORS 跨域支持 + JSON body 解析
  app.use(cors());
  app.use(express.json());

  // 上传目录静态资源服务（/uploads → 上传根目录，含 addenda/、neoidea/）
  const uploadsPath = resolveUploadsRoot();
  fs.mkdirSync(path.join(uploadsPath, 'addenda'), { recursive: true });
  app.use('/uploads', express.static(uploadsPath));

  // 挂载所有 API 路由（统一前缀 /api）
  app.use('/api', apiRoutes);
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
 * 功能：顺序执行 initDb → 创建 app → 异步预热 embedding → 监听端口 → 启动后台服务
 * 实现方式：
 *   - DB 初始化失败以 rejected Promise 上报（不再 process.exit），由调用方决定处理
 *   - 通过 onReady 回调把实际监听端口交回调用方（端口=0 时），方便前端同源加载
 * @param {{ port?: number, frontendDist?: string|null, onReady?: (port:number)=>void }} [options]
 * @returns {Promise<{ server: import('http').Server, port: number }>}
 */
export async function startServer({ port = 3001, frontendDist = null, onReady } = {}) {
  // 确保 per-inspiration 数据目录存在（数据库文件与灵感文件夹均存放于此，recursive 幂等）
  fs.mkdirSync(resolveDataInspirationsDir(), { recursive: true });

  // 1. 初始化数据库（失败则 reject，不退出进程）
  await initDb();

  // 2. 创建 Express 应用（Electron 生产模式同时 serve 前端 dist）
  const app = createApp({ frontendDist });

  // 3. 异步预热 embedding 模型（fire-and-forget，不阻塞 listen；失败不退出进程）
  EmbeddingService.init().catch((err) => {
    console.error('[Server] EmbeddingService init failed (scan/coalesce will be unavailable):', err.message);
  });

  // 4. 监听端口并启动后台服务
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(port, () => {
      const actualPort = srv.address().port;
      console.log(`[Server] Running on http://localhost:${actualPort}`);
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