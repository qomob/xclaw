import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // 不自动 modulepreload 重型懒加载 chunk（maplibre/deckgl/three 等按需加载，
    // 避免每次打开首页都预取 ~460KB，弱网络下显著拖慢首屏）
    modulePreload: false,
    // manualChunks 已移除（实验：避免共享模块被塞进 react-vendor 造成静态引用重型库）
  },
})
