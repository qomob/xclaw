import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// 与 vite.config.ts 保持同一套插件；测试环境用 jsdom（组件渲染）
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
})
