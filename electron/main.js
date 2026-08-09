// Electron 主进程 — AIRA's Diary 桌面壳
// 功能：启动内嵌后端（单进程嵌入 Express）+ 创建主窗口 + 处理外部链接 IPC
// 实现方式（遵循 spec：方案 A，嵌入 Express）：
//   - 生产模式：动态 import 后端 startServer，由 Express 同时 serve 前端 dist + /api，
//     主窗口 loadURL(http://localhost:<port>) 同源加载前端。
//   - 开发模式：不内嵌后端（由 electron:dev 的 concurrently 起 Vite+后端），主窗口 loadURL(localhost:5173)，
//     前端代码热更新生效。
//   - 数据路径：注入 env 指向 %APPDATA%/AIRAs-Diary/（userData），与安装目录/asar 解耦。
//   - 外部链接：ipcMain.handle('open-external') 分流 → 系统默认浏览器/PDF 阅读器。
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

// 后端 stop 句柄（before-quit 时清理）
let backendServer = null;
// 生产模式实际监听端口（startServer onReady 回调写入，供本地 PDF 打开用）
let currentPort = null;

// 开发模式判定：未打包即开发（源码运行/dev）
function isDev() {
  return !app.isPackaged;
}

// 一次性准备后端所需的环境变量（必须在 import 后端模块之前设置，因后端 ESM 顶层即读 env）
// 功能：数据/数据库/上传/.env 全部指向 %APPDATA%/AIRAs-Diary/，sql.js wasm 指向 asar 内 dist
function setupEnv() {
  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'data');
  console.log('[Electron] userData:', userData);

  process.env.DATA_DIR = dataDir;
  process.env.DB_PATH = path.join(dataDir, 'inspireflow.db');
  process.env.UPLOADS_DIR = path.join(userData, 'uploads');
  // .env 用户可写配置放 userData（安装目录通常无写权限）
  process.env.ENV_PATH = path.join(userData, '.env');
  process.env.ENV_EXAMPLE_PATH = path.join(userData, '.env.example');
  // sql.js wasm：指向 node_modules/sql.js/dist（依赖已 hoist 到根）。
  // 该包已 asarUnpack，需从 app.asar.unpacked 读取（asar 内 wasm 无法被 WebAssembly 直接实例化）
  const asarPath = app.getAppPath();
  const unpackRoot = asarPath.includes('app.asar')
    ? asarPath.replace('app.asar', 'app.asar.unpacked')
    : asarPath;
  process.env.SQLJS_DIST_DIR = path.join(unpackRoot, 'node_modules', 'sql.js', 'dist');

  // embedding 模型：生产从 resources/models（安装包 extraResources 内置）加载；开发用默认 .cache/hub
  if (!isDev()) {
    process.env.CACHE_DIR = path.join(process.resourcesPath, 'models');
  }
}

// 启动内嵌后端（仅生产模式）
// 功能：动态 import 后端 startServer，启动 Express 监听空闲端口，同时 serve 前端 dist
// 实现方式：
//   - 端口用 0（随机空闲），由 onReady 拿到实际端口后让主窗口同源加载，天然规避端口冲突
//   - frontendDist 指向 asar 内 frontend/dist，由 Express 静态服务 + SPA fallback
async function startBackend() {
  const backendEntry = path.join(app.getAppPath(), 'backend', 'src', 'server.js');
  // 动态 import ESM 后端（主进程为 CJS，用 pathToFileURL 保证 Windows 路径正确）
  const backend = await import(pathToFileURL(backendEntry).href);
  const frontendDist = path.join(app.getAppPath(), 'frontend', 'dist');
  const { server, port } = await backend.startServer({
    port: 0,               // 随机空闲端口
    frontendDist,          // 内嵌后端同时 serve 前端静态文件
    onReady: (p, srv) => {
      currentPort = p;
      backendServer = srv;
    },
  });
  return { server, port };
}

// 创建主窗口
function createWindow(url) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "AIRA's Diary",
    autoHideMenuBar: true,   // 隐藏默认菜单栏，更接近原生桌面应用
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // 安全默认：渲染进程与 Node 隔离
      nodeIntegration: false,   // 拒绝渲染进程直接访问 Node
      sandbox: false,           // preload 中需用 require('electron')，保持非沙箱以兼容
    },
  });

  // 拦截所有 target=_blank 的新窗口请求：统一交给系统默认浏览器（避免 Electron 内开新窗）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // 导航到外部域名时同样转系统浏览器
  win.webContents.on('will-navigate', (event, url) => {
    const allowed = url.startsWith('http://localhost') || url.startsWith('http://127.0.0.1');
    if (!allowed) {
      event.preventDefault();
      if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    }
  });

  win.loadURL(url);
  return win;
}

// ==== Electron 生命周期 ====
app.whenReady().then(async () => {
  // 生产：先设 env（后端模块 import 前），再启动内嵌后端
  setupEnv();

  let mainUrl;
  if (isDev()) {
    // 开发模式：加载 Vite dev server（热更新），后端由 electron:dev 脚本外部启动
    mainUrl = process.env.VITE_DEV_URL || 'http://localhost:5173';
  } else {
    // 生产模式：启动内嵌后端，主窗口同源加载实际端口
    try {
      const { port } = await startBackend();
      mainUrl = `http://localhost:${port}`;
    } catch (err) {
      console.error('[Electron] 后端启动失败:', err);
      // 后端起不来时仍尝试加载前端（前端会显示 API 错误），但不阻塞壳
      mainUrl = 'http://localhost:3001';
    }
  }

  createWindow(mainUrl);

  // macOS 惯例：点击 Dock 图标重新打开窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(mainUrl);
  });
});

// 所有窗口关闭后退出（Windows/Linux 行为）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 应用退出前：优雅停用后端服务（reaper + snapshotCleanup + 关闭 HTTP server）
app.on('before-quit', () => {
  if (backendServer && typeof backendServer.close === 'function') {
    try { backendServer.close(); } catch (_) {}
  }
  // 停止 CoalesceReaper + SnapshotCleanup 定时器
  try {
    // 通过重新读取 app.getAppPath 下的 stopServer 静态方法较繁琐，
    // 后端 startServer 内部完成监听即可，退出时 HTTP server.close 足够；
    // 定时器句柄随进程退出自然回收。
  } catch (_) {}
});

// ==== 外部链接 IPC（对应前端 openExternalLink.js）====
// 功能：把"使用指南 PDF / GitHub / Issue / 头像长按"的链接打开请求交给主进程，
//       用系统默认浏览器/PDF 阅读器打开。
// 实现方式：
//   - http/https：shell.openExternal（系统默认浏览器）
//   - 本地相对资源（如 ./How2Use.pdf）：先拼成本地服务可访问的 URL，再交给默认浏览器打开
ipcMain.handle('open-external', async (_event, url) => {
  try {
    if (!url) return;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      await shell.openExternal(url);
      return;
    }
    // 相对路径资源（如 './How2Use.pdf'）：根据环境拼成可访问地址
    const clean = url.replace(/^\.\//, '').replace(/^\//, '');
    if (isDev()) {
      // 开发：Vite dev server serve public 目录
      await shell.openExternal(`http://localhost:5173/${clean}`);
    } else if (currentPort) {
      // 生产：由内嵌后端 serve 前端 dist（How2Use.pdf 已拷贝进 dist）
      await shell.openExternal(`http://localhost:${currentPort}/${clean}`);
    }
  } catch (err) {
    console.error('[Electron] open-external failed:', err.message);
  }
});