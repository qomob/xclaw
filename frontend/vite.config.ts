import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // 将重型可视化/渲染库拆分为独立 chunk，提升缓存命中与并行加载
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('maplibre') || id.includes('@vis.gl')) return 'maplibre';
          if (id.includes('deck.gl') || id.includes('@deck.gl') || id.includes('h3-js')) return 'deckgl';
          if (id.includes('three') || id.includes('@react-three') || id.includes('troika')) return 'three3d';
          if (id.includes('d3-') || id.includes('/d3/')) return 'd3';
          if (id.includes('react') || id.includes('scheduler') || id.includes('zustand')) return 'react-vendor';
          return 'vendor';
        },
      },
    },
  },
})
