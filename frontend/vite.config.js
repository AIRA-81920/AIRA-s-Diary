// Vite 配置文件
// 功能：配置 React 插件、开发服务器端口与 /api 代理、注入应用版本号
// 实现方式：
//   - 通过 @vitejs/plugin-react 启用 JSX 支持
//   - server.proxy 将 /api 请求转发到后端 3001 端口
//   - define 将根 package.json 的 version 注入为 import.meta.env.VITE_APP_VERSION
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// 读取根 package.json 的 version 字段，注入前端环境变量
const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'))

export default defineConfig({
  plugins: [react()],
  define: {
    // 将版本号注入 import.meta.env.VITE_APP_VERSION，组件中直接读取
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version)
  },
  server: {
    port: 5173,
    // 固定端口：冲突时明确报错而非自动切换端口。
    // 保证 electron:dev 脚本里 wait-on tcp:5173 与 VITE_DEV_URL=http://localhost:5173 始终命中，
    // 否则 vite 切到 5174 会导致 Electron 窗口连不上前端。
    strictPort: true,
    proxy: {
      // 将所有 /api 开头的请求代理到后端 Express 服务器，避免前端跨域问题
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      // 追加条目图片等静态资源代理到后端（/uploads 目录）
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})

// touch: restart vite to reload tailwind config
