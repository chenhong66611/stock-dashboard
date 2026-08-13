<template>
  <div class="app">
    <!-- 页头 -->
    <header class="header">
      <div class="header-left">
        <h1>ETF 盯盘</h1>
        <div class="subtitle">正式网格3只 · 参考观察8只</div>
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

    <!-- 大盘情绪条 -->
    <div class="mood-bar" v-if="mood">
      <span class="mood-label">大盘情绪</span>
      <span class="mood-value" :class="mood.cls">{{ mood.text }}</span>
      <span class="mood-detail">{{ mood.detail }}</span>
    </div>

    <!-- 关键信号栏 -->
    <div class="signal-bar" v-if="signals.length">
      <span class="signal-title">📡 关键信号</span>
      <span v-for="s in signals" :key="s.code + s.label" class="signal-chip" :class="s.cls">{{ s.name }} {{ s.label }}</span>
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
      <IndexCard v-for="item in mainItems" :key="item.code" :data="item" :holding="holdings[item.code] || 0"
                 :analysis="analysisMap[item.code]" />
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

    <!-- 新闻区 -->
    <div class="news-section" v-if="flatNews.length">
      <div class="news-title">📰 今日要闻</div>
      <div class="news-list">
        <a v-for="(n, i) in flatNews" :key="i" class="news-item" :href="n.url" target="_blank" rel="noopener">
          <span class="news-tag" :class="'tag-' + n.tag">{{ n.tag }}</span>
          <span class="news-text">{{ n.title }}</span>
          <span class="news-meta">{{ n.date }}<template v-if="n.source"> · {{ n.source }}</template></span>
        </a>
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
import { analyzeAll } from './services/volumeAnalysis.js'
import { fetchNewsAll } from './services/newsApi.js'
import IndexCard from './components/IndexCard.vue'

const indices = ref([])
const loading = ref(false)
const error = ref('')
const lastUpdate = ref('')
const marketOpen = ref(false)
const timer = ref(null)

// 量能分析结果：{code: report}，新闻列表
const analysisMap = ref({})
const newsList = ref([])
let lastAnalysisAt = 0
let lastNewsAt = 0

// 持仓金额（按ETF代码索引，买入后手动更新）
const holdings = reactive({
  sh510310: 0,
  sh588000: 704,  // 400份 @ 均价1.705
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

// 大盘情绪：3只正式网格标的的平均涨跌
const mood = computed(() => {
  const formal = indices.value.filter(i => !i.ref && !i.watch)
  if (!formal.length) return null
  const avg = formal.reduce((a, i) => a + (i.changePct || 0), 0) / formal.length
  const upCount = formal.filter(i => i.change > 0).length
  let text, cls
  if (avg > 0.3)      { text = '偏暖 🔥'; cls = 'mood-up' }
  else if (avg < -0.3){ text = '偏冷 🧊'; cls = 'mood-down' }
  else                { text = '中性 ⚖️'; cls = 'mood-flat' }
  return {
    text, cls,
    detail: `沪深300 ${fmtPct(formal[0]?.changePct)} · 科创50 ${fmtPct(formal[1]?.changePct)} · 中证1000 ${fmtPct(formal[2]?.changePct)} | ${upCount}/3 上涨`,
  }
})

// 关键信号汇总（转强/反转/出货/吸筹/止跌）
const signals = computed(() => {
  const list = []
  for (const rep of Object.values(analysisMap.value)) {
    if (!rep || rep.error) continue
    if (rep.strongSignal?.strong) list.push({ code: rep.code, name: rep.name, label: '🔥转强', cls: 'sig-up' })
    if (rep.phase?.stage === '反转') list.push({ code: rep.code, name: rep.name, label: '↗️反转', cls: 'sig-up' })
    if (rep.combine?.verdict === '出货') list.push({ code: rep.code, name: rep.name, label: '⚠️出货', cls: 'sig-fall' })
    if (rep.fund?.verdict === '吸筹') list.push({ code: rep.code, name: rep.name, label: '🧲吸筹', cls: 'sig-down' })
    if (rep.phase?.stage === '止跌') list.push({ code: rep.code, name: rep.name, label: '🛑止跌', cls: 'sig-down' })
  }
  return list.slice(0, 10)
})

// 新闻拍平（按关键词分组 → 平铺取前6条）
const flatNews = computed(() => {
  const all = []
  for (const group of newsList.value) all.push(...group.list)
  return all.slice(0, 6)
})

function fmtPct(v) {
  if (v == null || isNaN(v)) return '--'
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%'
}

async function refresh() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const data = await fetchAllIndices()
    indices.value = data
    lastUpdate.value = data[0]?.time || new Date().toLocaleTimeString('zh-CN', { hour12: false })
    marketOpen.value = isTradingTime()

    // 量能分析：最多每60秒一次（K线缓存5分钟兜底）
    const now = Date.now()
    if (now - lastAnalysisAt > 60_000) {
      lastAnalysisAt = now
      analyzeAll(data).then(map => { analysisMap.value = map }).catch(e => console.error('分析失败:', e))
    }
    // 新闻：最多每5分钟一次
    if (now - lastNewsAt > 300_000) {
      lastNewsAt = now
      fetchNewsAll(['A股', 'ETF', '沪深300', '科创50']).then(list => { newsList.value = list }).catch(e => console.error('新闻失败:', e))
    }
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
