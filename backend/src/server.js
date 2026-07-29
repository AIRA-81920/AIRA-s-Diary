// 服务器入口 — AIRA's Diary 后端主程序
// 启动流程：加载环境变量 → 初始化数据库 → 创建 Express 应用 → 挂载中间件与路由 → 监听端口

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

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
import { EmbeddingService } from './services/embeddingService.js';

// 确保数据目录存在（数据库文件与 per-inspiration 文件夹均存放于此）
// 实现：基于 DATA_DIR 创建 data/ 与 data/inspirations/ 目录（recursive 保证幂等）
const DATA_DIR = process.env.DATA_DIR || './data';
const dataAbsPath = path.isAbsolute(DATA_DIR) ? DATA_DIR : path.resolve(process.cwd(), DATA_DIR);
fs.mkdirSync(path.join(dataAbsPath, 'inspirations'), { recursive: true });

const app = express();
const PORT = process.env.PORT || 3001;

// 中间件：CORS 跨域支持 + JSON body 解析
app.use(cors());
app.use(express.json());

// v7 新增：追加条目图片上传目录与静态资源服务
// 实现：在 express.json() 之后挂载 /uploads 静态目录，前端可通过 /uploads/addenda/{filename} 访问图片
const uploadsPath = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(path.join(uploadsPath, 'addenda'), { recursive: true });
app.use('/uploads', express.static(uploadsPath));

// 挂载 API 路由（统一前缀 /api）
app.use('/api', apiRoutes);

// 挂载结晶流程路由（同样使用 /api 前缀，路径 /api/inspirations/:id/crystallize/*）
// M3 重命名：原 clarifyRoutes → crystallizeRoutes
app.use('/api', crystallizeRoutes);

// 挂载 Epitaxy 外延探究路由（M3-c 新增，路径 /api/inspirations/:id/epitaxy/*）
app.use('/api', epitaxyRoutes);

// 挂载 Coalesce 跨灵感桥梁路由（M3-e 新增，路径 /api/inspirations/:id/coalesce/*）
app.use('/api', coalesceRoutes);

// 挂载追加条目路由（v7 新增，路径 /api/inspirations/:id/addenda/* 等）
app.use('/api', addendumRoutes);
app.use('/api/settings', settingsRoutes);

// 挂载文件夹路由（v8 新增，路径 /api/folders/*）
app.use('/api/folders', folderRoutes);

// 启动服务器：先初始化数据库，成功后异步预热 embedding 模型并监听端口
// 实现：
//   1. await initDb() 确保数据库就绪
//   2. 异步触发 EmbeddingService.init() 预热（不阻塞 app.listen，3-5s 完成）
//      - 失败不退出进程（与 health 契约一致：embeddingModel='failed'）
//      - scan API 前置检查 isReady()，未就绪返回 503 EMBEDDING_UNAVAILABLE
//   3. app.listen 启动 HTTP 服务
initDb()
  .then(() => {
    // 异步预热 embedding 模型（fire-and-forget，不阻塞 listen）
    // 架构 §6.5 + R2：启动预热 + 健康门；未 ready 时 API 返回 503
    EmbeddingService.init().catch((err) => {
      console.error('[Server] EmbeddingService init failed (scan/coalesce will be unavailable):', err.message);
      console.error('[Server] Health endpoint will report embeddingModel=failed; scan API returns 503');
    });
    app.listen(PORT, () => {
      console.log(`[Server] Running on http://localhost:${PORT}`);
      // 打印当前生效的模型配置（便于确认 .env 中的自定义是否生效）
      printModelConfig();
    });
  })
  .catch((err) => {
    // 数据库初始化失败时打印错误并退出进程（不启动半残的服务器）
    console.error('[Server] Failed to start: database initialization error:', err);
    process.exit(1);
  });
