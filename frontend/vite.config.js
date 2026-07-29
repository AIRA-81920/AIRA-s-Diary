// Vite 配置文件
// 功能：配置 React 插件、开发服务器端口与 /api 代理
// 实现方式：通过 @vitejs/plugin-react 启用 JSX 支持，server.proxy 将 /api 请求转发到后端 3001 端口
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
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
