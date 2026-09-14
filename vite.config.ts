/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // 与 tsconfig.json 的 paths 保持一致。两处都要写是因为 TS 只管类型检查，
    // 真正的模块解析由打包器做，它读不到 tsconfig 的 paths。
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // 开发期把 /api 代理到 Go 后端，前端因此始终同源请求。
    //
    // 这么做而不是让浏览器直接跨域打 8080，有两个实际好处：
    // 一是不依赖后端开 CORS（后端的 -cors 参数只在开发模式挂载，生产留空）；
    // 二是 EventSource 在跨域时的 withCredentials 和预检行为比同源复杂得多，
    // 同源可以完全绕开这类问题。生产环境由 nginx 做同样的事。
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET ?? 'http://localhost:8080',
        changeOrigin: true,
        // SSE 不需要额外配置：Vite 的代理基于 http-proxy，响应是流式转发的，
        // 且开发服务器默认不压缩。真正会缓冲 SSE 的是生产环境的 nginx，
        // 后端已经为此发了 X-Accel-Buffering: no 响应头。
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
