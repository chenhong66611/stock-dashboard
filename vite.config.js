import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: '/stock-dashboard/',
  plugins: [vue()],
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
