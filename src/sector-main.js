import { createApp } from 'vue'
import './style.css'
import SectorApp from './SectorApp.vue'

// 热力图页要铺满屏幕，和盯盘页的 1200px 居中版式不一样
document.body.classList.add('sector-page')

createApp(SectorApp).mount('#app')
