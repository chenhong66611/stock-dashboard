import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/stock-dashboard/',
  plugins: [vue()],
  build: {
    // 两个入口：盯盘页 index.html、板块热力图页 sector.html
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        sector: fileURLToPath(new URL('./sector.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api/stock': {
        target: 'https://qt.gtimg.cn',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api\/stock/, ''),
      },
    },
  },
})
