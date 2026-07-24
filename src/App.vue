<template>
  <div class="app">
    <!-- 页头 -->
    <header class="header">
      <div class="header-left">
        <h1>ETF 盯盘</h1>
        <div class="subtitle">中证1000ETF · 沪深300ETF</div>
      </div>
      <div class="header-right">
        <div class="market-status">
          <span class="market-dot" :class="marketOpen ? 'open' : 'closed'"></span>
          {{ marketOpen ? '交易中' : '已收盘' }}
        </div>
        <span class="last-update">
          {{ lastUpdate ? '更新: ' + lastUpdate : '' }}
        </span>
        <button class="refresh-btn" :disabled="loading" @click="refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
               :class="{ spinning: loading }">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          {{ loading ? '刷新中...' : '刷新' }}
        </button>
      </div>
    </header>

    <!-- 涨跌统计条 -->
    <div class="stats-bar" v-if="indices.length">
      <div class="stat-item">
        <span class="stat-label">上涨</span>
        <span class="stat-value" style="color: var(--red);">{{ stats.up }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">下跌</span>
        <span class="stat-value" style="color: var(--green);">{{ stats.down }}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">平盘</span>
        <span class="stat-value" style="color: var(--text-secondary);">{{ stats.flat }}</span>
      </div>
    </div>

    <!-- 错误提示 -->
    <div class="error-bar" v-if="error">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
      {{ error }}
      <button class="refresh-btn" style="margin-left: auto; padding: 4px 10px;" @click="refresh">重试</button>
    </div>

    <!-- 加载 -->
    <div class="loading-shimmer" v-if="loading && !indices.length">
      <div class="spinner"></div>
      <div>正在加载行情数据...</div>
    </div>

    <!-- ETF 卡片网格 -->
    <div class="index-grid" v-if="mainItems.length">
      <IndexCard v-for="item in mainItems" :key="item.code" :data="item" :holding="holdings[item.code] || 0" />
    </div>

    <!-- 参考指数分隔线 -->
    <div class="ref-divider" v-if="refItems.length">
      <span class="ref-divider-line"></span>
      <span class="ref-divider-text">参考指数</span>
      <span class="ref-divider-line"></span>
    </div>

    <!-- 参考指数 -->
    <div class="ref-grid" v-if="refItems.length">
      <div class="ref-card" v-for="item in refItems" :key="item.code">
        <div class="ref-name">{{ item.name }}</div>
        <div class="ref-price" :class="{ up: item.change > 0, down: item.change < 0 }">
          {{ item.price.toFixed(2) }}
          <span class="ref-change">
            {{ item.change > 0 ? '▲' : item.change < 0 ? '▼' : '─' }}
            {{ (item.change > 0 ? '+' : '') + item.change.toFixed(2) }}
            ({{ (item.changePct > 0 ? '+' : '') + item.changePct.toFixed(2) }}%)
          </span>
        </div>
        <div class="ref-range">
          高 <span class="high">{{ item.high.toFixed(2) }}</span>
          低 <span class="low">{{ item.low.toFixed(2) }}</span>
        </div>
      </div>
    </div>

    <!-- 页脚 -->
    <footer class="footer">
      数据来源：<a href="https://qt.gtimg.cn" target="_blank" rel="noopener">腾讯股票</a> ·
      仅作参考，不构成投资建议 ·
      盯住目标，不到不动
    </footer>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'

import { fetchAllIndices, isTradingTime, formatTime } from './services/stockApi.js'
import IndexCard from './components/IndexCard.vue'

const indices = ref([])
const loading = ref(false)
const error = ref('')
const lastUpdate = ref('')
const marketOpen = ref(false)
const timer = ref(null)

// 持仓金额（按ETF代码索引，买入后手动更新）
const holdings = reactive({
  sh510310: 0,
  sh588000: 0,
  sh560010: 0,
})

// 分离 ETF 和参考指数
const mainItems = computed(() => indices.value.filter(i => !i.ref))
const refItems = computed(() => indices.value.filter(i => i.ref))

const stats = computed(() => {
  const list = mainItems.value
  if (!list.length) return { up: 0, down: 0, flat: 0 }
  return {
    up:   list.filter(i => i.change > 0).length,
    down: list.filter(i => i.change < 0).length,
    flat: list.filter(i => i.change === 0).length,
  }
})

async function refresh() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const data = await fetchAllIndices()
    indices.value = data
    lastUpdate.value = data[0]?.time || new Date().toLocaleTimeString('zh-CN', { hour12: false })
    marketOpen.value = isTradingTime()
  } catch (e) {
    error.value = e.message || '获取数据失败，请检查网络连接'
    console.error('Stock fetch error:', e)
  } finally {
    loading.value = false
  }
}

// 自动刷新：交易时段每 10 秒，非交易时段每 60 秒
function startAutoRefresh() {
  const interval = isTradingTime() ? 10_000 : 60_000
  timer.value = setInterval(refresh, interval)
}

onMounted(() => {
  refresh()
  startAutoRefresh()
})

onUnmounted(() => {
  if (timer.value) clearInterval(timer.value)
})
</script>
