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
const crypto = require('crypto');
const dotenv = require('dotenv');
const { pathToFileURL } = require('url');

// 后端 stop 句柄（before-quit 时清理；CR-13：接入后端导出的 stopServer，同时停 reaper/snapshot 定时器）
let backendServer = null;
let backendStopFn = null;
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
  // 本地 API 令牌（SEC-002/SEC-014）：每次启动生成随机令牌，后端 /api 全部请求须携带，
  // 前端经 preload → ipcMain 获取后统一附加 x-local-token 头，恶意网页无令牌即 401
  process.env.LOCAL_API_TOKEN = crypto.randomUUID();
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

    // 防止 API 密钥泄漏进安装包（对应 package.json 打包 filter 已排除 .env）：
    // - 密钥入口：仅加载 userData/.env（用户在设置界面填写、可写），asar 内无 .env。
    // - 模板种子：首次启动把 asar 内 backend/.env.example（空白模板，无真实密钥）复制到
    //   userData，保证设置界面的"重置为模板/读取示例"功能可用。
    // 实现方式：copyFileSync 仅在本对象不存在时执行；dotenv 先于后端 import 加载，
    //   使 userData/.env 中的配置在每次启动时都注入 process.env（重启后设置仍生效）。
    const exampleInAsar = path.join(app.getAppPath(), 'backend', '.env.example');
    try {
      if (fs.existsSync(exampleInAsar) && !fs.existsSync(process.env.ENV_EXAMPLE_PATH)) {
        fs.copyFileSync(exampleInAsar, process.env.ENV_EXAMPLE_PATH);
      }
    } catch (err) {
      console.error('[Electron] 复制 .env.example 种子失败（不影响启动）:', err.message);
    }
    // 加载用户自己的密钥配置（不存在则跳过，后端提供空配置兜底）
    dotenv.config({ path: process.env.ENV_PATH });
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
  backendStopFn = backend.stopServer;   // CR-13：退出时经 stopServer 统一停后台定时器 + 关闭 HTTP
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
      sandbox: true,            // SEC-010：preload 仅用 contextBridge/ipcRenderer（沙箱内可用），开启沙箱降低 renderer 漏洞利用面
    },
  });

  // 拦截所有 target=_blank 的新窗口请求：统一交给系统默认浏览器（避免 Electron 内开新窗）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // 导航到外部域名时同样转系统浏览器
  // SEC-012 修复：用 URL 解析比较主机名（原 startsWith 可被 http://localhost.evil.com 绕过）
  win.webContents.on('will-navigate', (event, url) => {
    let allowed = false;
    try {
      const u = new URL(url);
      // data: 用于后端启动失败时的内联错误页（CR-13）
      if (u.protocol === 'data:') { allowed = true; }
      else {
        allowed = (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
          (u.protocol === 'http:' || u.protocol === 'https:');
      }
    } catch { allowed = false; }
    if (!allowed) {
      event.preventDefault();
      if (isAllowedExternalUrl(url)) shell.openExternal(url);
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
      mainUrl = `http://127.0.0.1:${port}`;
    } catch (err) {
      console.error('[Electron] 后端启动失败:', err);
      // CR-13 修复：后端起不来时加载内联错误页（原硬编码 3001 只会白屏/连接拒绝），
      // 明确告知用户后端启动失败与日志位置
      const logPath = path.join(app.getPath('userData'), 'data');
      mainUrl = `data:text/html;charset=utf-8,${encodeURIComponent(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>AIRA's Diary - 启动失败</title>
         <style>body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#eee;display:flex;height:100vh;align-items:center;justify-content:center;margin:0}
         .box{max-width:520px;padding:32px;background:#16213e;border-radius:12px;line-height:1.8}
         h1{font-size:20px;color:#ff6b6b}code{background:#0f3460;padding:2px 6px;border-radius:4px}</style></head>
         <body><div class="box"><h1>后端启动失败</h1>
         <p>AIRA's Diary 的内嵌服务未能启动，应用无法正常使用。</p>
         <p>请尝试：重启应用 → 重启电脑后重试 → 重新安装最新版本。</p>
         <p>数据目录（可备份后反馈作者）：<code>${logPath}</code></p>
         </div></body></html>`
      )}`;
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
  // CR-13：调用后端导出的 stopServer（停 CoalesceReaper + SnapshotCleanup 定时器 + 关闭 HTTP server）
  if (typeof backendStopFn === 'function' && backendServer) {
    try { backendStopFn(backendServer); } catch (_) {}
  } else if (backendServer && typeof backendServer.close === 'function') {
    try { backendServer.close(); } catch (_) {}
  }
});

// ==== 外部链接 IPC（对应前端 openExternalLink.js）====
// SEC-012：http(s) 外部链接白名单（项目相关域名），其余一律拒绝；
// 本地相对资源仅允许受控文件名（当前为使用指南 PDF），防止渲染进程被 XSS 后滥用 openExternal
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'githubusercontent.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const ALLOWED_LOCAL_FILES = new Set(['How2Use.pdf', 'how2use.pdf']);

function isAllowedExternalUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    return host === 'github.com' || host.endsWith('.github.com') ||
      host.endsWith('.githubusercontent.com') || host.endsWith('.github.io');
  } catch {
    return false;
  }
}

// 功能：把"使用指南 PDF / GitHub / Issue / 头像长按"的链接打开请求交给主进程，
//       用系统默认浏览器/PDF 阅读器打开。
// 实现方式：
//   - http/https 白名单域名：shell.openExternal（系统默认浏览器），非白名单拒绝
//   - 本地相对资源（如 ./How2Use.pdf）：先拼成本地服务可访问的 URL，再交给默认浏览器打开
ipcMain.handle('open-external', async (_event, url) => {
  try {
    if (!url) return;
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (!isAllowedExternalUrl(url)) {
        console.warn('[Electron] open-external rejected (not in whitelist):', url);
        return;
      }
      await shell.openExternal(url);
      return;
    }
    // 本地相对资源：严格白名单文件名
    const clean = url.replace(/^\.\//, '').replace(/^\//, '');
    if (!ALLOWED_LOCAL_FILES.has(clean)) {
      console.warn('[Electron] open-external rejected (local file not allowed):', clean);
      return;
    }
    if (isDev()) {
      // 开发：Vite dev server serve public 目录
      await shell.openExternal(`http://localhost:5173/${clean}`);
    } else if (currentPort) {
      // 生产：由内嵌后端 serve 前端 dist（How2Use.pdf 已拷贝进 dist）
      await shell.openExternal(`http://127.0.0.1:${currentPort}/${clean}`);
    }
  } catch (err) {
    console.error('[Electron] open-external failed:', err.message);
  }
});

// 本地 API 令牌下发（SEC-002）：渲染进程经 preload 获取后，由前端 fetch 封装统一附加 x-local-token
ipcMain.handle('get-local-token', () => process.env.LOCAL_API_TOKEN || null);