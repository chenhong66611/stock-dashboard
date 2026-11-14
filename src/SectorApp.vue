<template>
  <div class="page">
    <header class="bar">
      <div class="bar-left">
        <a class="back" href="./">← 盯盘</a>
        <h1>板块热力图</h1>
        <span class="hint">面积=成交额 · 颜色=涨跌幅</span>
      </div>
      <div class="bar-right">
        <span class="market-status">
          <span class="market-dot" :class="marketOpen ? 'open' : 'closed'"></span>
          {{ marketOpen ? '交易中' : '已收盘' }}
        </span>
        <span class="last-update">{{ dataTime ? '数据 ' + dataTime : '' }}</span>
        <span v-if="loading" class="updating">更新中…</span>
        <button class="refresh-btn" :disabled="loading" @click="refresh">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
               :class="{ spinning: loading }">
            <polyline points="23 4 23 10 17 10" />
            <polyline points="1 20 1 14 7 14" />
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
          </svg>
          刷新
        </button>
      </div>
    </header>

    <!-- 两套口径各一屏，随时对照 -->
    <div class="tabs">
      <button class="tab" :class="{ on: view === 'concept' }" @click="switchView('concept')">
        算力产业链<span class="tab-n">{{ CONCEPTS.length }}</span>
      </button>
      <button class="tab" :class="{ on: view === 'industry' }" @click="switchView('industry')">
        申万一级行业<span class="tab-n">{{ SECTORS.length }}</span>
      </button>
    </div>

    <div class="stats" v-if="items.length">
      <span class="stat"><i class="dot up"></i>红 <b class="up">{{ upCount }}</b></span>
      <span class="stat"><i class="dot down"></i>绿 <b class="down">{{ downCount }}</b></span>
      <span class="stat" v-if="flatCount"><i class="dot flat"></i>平 <b class="flat">{{ flatCount }}</b></span>
      <!-- 概念之间成分股重叠，加起来是重复计数的，所以这一屏不给合计 -->
      <span class="stat sep" v-if="view === 'industry'">合计成交额 <b>{{ formatAmountYi(totalAmount) }}</b></span>
      <span class="stat" v-if="best">最强 <b class="up">{{ best.name }}</b> {{ formatPct(best.pct) }}</span>
      <span class="stat" v-if="worst">最弱 <b class="down">{{ worst.name }}</b> {{ formatPct(worst.pct) }}</span>
    </div>

    <div class="error-bar" v-if="error">
      <span>{{ error }}</span>
      <button class="refresh-btn" style="margin-left: auto; padding: 3px 10px;" @click="refresh">重试</button>
    </div>

    <!-- 首屏只给一条细提示，不挡画面 -->
    <div class="first-load" v-if="!items.length && loading">
      <div class="spinner"></div>
      <span>{{ view === 'concept' ? '正在拉取算力产业链…' : '正在拉取 31 个行业板块…' }}</span>
    </div>

    <div class="chart" v-if="items.length">
      <SectorHeatmap :items="items" :max-abs="maxAbs" :flashing="flashing" />
    </div>

    <footer class="foot">
      <div class="legend">
        <span class="legend-label">{{ formatPct(-maxAbs) }}</span>
        <span class="legend-bar left"></span>
        <span class="legend-label legend-zero">0</span>
        <span class="legend-bar right"></span>
        <span class="legend-label">{{ formatPct(maxAbs) }}</span>
      </div>
      <div class="src" v-if="view === 'concept'">
        数据来源：同花顺概念板块 · 概念之间成分股大量重叠，面积是各板块自身成交额，<b>不可相加</b>
      </div>
      <div class="src" v-else>
        数据来源：腾讯行情 · 涨跌幅口径为腾讯板块指数，与东财/同花顺的申万指数会有出入，属正常
      </div>
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import SectorHeatmap from './components/SectorHeatmap.vue'
import { fetchSectors, SECTORS, maxAbsPct, formatPct, formatDataTime, formatAmountYi } from './services/sectorApi.js'
import { fetchConcepts, CONCEPTS, formatUpdateTime } from './services/conceptApi.js'
import { isTradingTime } from './services/stockApi.js'

const CACHE_INDUSTRY = 'sector-snapshot-v1'
const CACHE_CONCEPT = 'concept-snapshot-v1'

// 两套数据分开存，切来切去都是秒开
const view = ref('concept')
const conceptItems = ref([])
const industryItems = ref([])
const conceptTime = ref('')
const industryTime = ref('')

const error = ref('')
const loading = ref(false)
const marketOpen = ref(false)
const flashing = ref(new Set())

let timer = null
let flashTimer = null
let pendingRefresh = false

const items = computed(() => (view.value === 'concept' ? conceptItems.value : industryItems.value))
const dataTime = computed(() => (view.value === 'concept' ? conceptTime.value : industryTime.value))

const maxAbs = computed(() => (items.value.length ? maxAbsPct(items.value) : 1))
const upCount = computed(() => items.value.filter(i => i.pct > 0).length)
const downCount = computed(() => items.value.filter(i => i.pct < 0).length)
const flatCount = computed(() => items.value.filter(i => i.pct === 0).length)
const totalAmount = computed(() => items.value.reduce((s, i) => s + i.amount, 0))
const best = computed(() => items.value.reduce((a, b) => (b.pct > a.pct ? b : a), items.value[0]))
const worst = computed(() => items.value.reduce((a, b) => (b.pct < a.pct ? b : a), items.value[0]))

/** 先在本地缓存上直接出画面，不让用户对着白屏等 */
function paintFromCache() {
  const read = key => {
    try {
      const snap = JSON.parse(localStorage.getItem(key) || 'null')
      return Array.isArray(snap?.items) && snap.items.length ? snap : null
    } catch {
      return null // 缓存坏了就当没有
    }
  }

  const c = read(CACHE_CONCEPT)
  if (c) { conceptItems.value = c.items; conceptTime.value = c.dataTime || '' }

  const i = read(CACHE_INDUSTRY)
  if (i) { industryItems.value = i.items; industryTime.value = i.dataTime || '' }
}

function saveCache(key, list, time) {
  try {
    localStorage.setItem(key, JSON.stringify({ items: list, dataTime: time }))
  } catch { /* 隐私模式写不了，忽略 */ }
}

/** 涨跌幅变了的板块闪一下，让"有动静"看得见 */
watch(items, (next, prev) => {
  if (!prev || !prev.length) return
  const before = new Map(prev.map(i => [i.code, i.pct]))
  const changed = next.filter(i => before.has(i.code) && Math.abs(before.get(i.code) - i.pct) > 0.001)
  if (!changed.length) return
  flashing.value = new Set(changed.map(i => i.code))
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { flashing.value = new Set() }, 700)
})

async function refresh() {
  // 有请求在飞就记一笔，等它回来再补一次 —— 否则切 tab 时刚好撞上刷新会漏掉
  if (loading.value) {
    pendingRefresh = true
    return
  }
  loading.value = true
  const target = view.value

  try {
    if (target === 'concept') {
      const data = await fetchConcepts()
      if (data.length) {
        conceptItems.value = data
        conceptTime.value = formatUpdateTime(data[0].time)
        saveCache(CACHE_CONCEPT, data, conceptTime.value)
      }
    } else {
      const data = await fetchSectors()
      if (data.length) {
        industryItems.value = data
        industryTime.value = formatDataTime(data[0].time)
        saveCache(CACHE_INDUSTRY, data, industryTime.value)
      }
    }
    error.value = ''
    marketOpen.value = isTradingTime()
  } catch (e) {
    // 失败不清屏，保留上一次的数据
    error.value = e.message || '获取数据失败，请检查网络'
  } finally {
    loading.value = false
    if (pendingRefresh) {
      pendingRefresh = false
      refresh()
    }
  }
}

function switchView(next) {
  if (next === view.value) return
  view.value = next
  error.value = ''
  flashing.value = new Set()
  // 让当前这屏能被收藏 / 刷新后还在
  try {
    history.replaceState(null, '', next === 'industry' ? '#industry' : location.pathname + location.search)
  } catch { /* file:// 下会抛，忽略 */ }
  refresh()
  scheduleNext()
}

function scheduleNext() {
  clearTimeout(timer)
  const trading = isTradingTime()
  // 概念板块一个板块一个请求，13 个一起发，所以拉得比行业那屏慢一点
  const interval = view.value === 'concept'
    ? (trading ? 20_000 : 120_000)
    : (trading ? 15_000 : 60_000)

  timer = setTimeout(async () => {
    await refresh()
    scheduleNext()
  }, interval)
}

onMounted(() => {
  if (location.hash === '#industry') view.value = 'industry'
  paintFromCache()
  marketOpen.value = isTradingTime()
  refresh()
  scheduleNext()
})

onUnmounted(() => {
  clearTimeout(timer)
  clearTimeout(flashTimer)
})
</script>

<style scoped>
.page {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.bar-left {
  display: flex;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}

.back {
  font-size: 0.75rem;
  color: var(--text-secondary);
  text-decoration: none;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  transition: all 0.2s;
}
.back:hover { background: var(--surface-hover); color: var(--text-primary); }

h1 {
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: 2px;
  background: linear-gradient(135deg, #e8eaed 0%, #8e99a4 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.hint {
  font-size: 0.68rem;
  color: var(--text-muted);
  letter-spacing: 0.5px;
}

.bar-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

/* 口径切换 */
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}

.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.18s;
}
.tab:hover { background: var(--surface-hover); color: var(--text-primary); }

.tab.on {
  background: rgba(242, 54, 69, 0.12);
  border-color: rgba(242, 54, 69, 0.45);
  color: var(--text-primary);
}

.tab-n {
  font-size: 0.62rem;
  font-weight: 700;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.tab.on .tab-n { background: rgba(242, 54, 69, 0.25); color: var(--text-primary); }

.market-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.market-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  animation: pulse 1.5s ease-in-out infinite;
}
.market-dot.open { background: var(--green); box-shadow: 0 0 8px rgba(0, 200, 83, 0.4); }
.market-dot.closed { background: var(--text-muted); animation: none; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.last-update {
  font-size: 0.7rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.updating {
  font-size: 0.68rem;
  color: var(--text-muted);
}

.refresh-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-secondary);
  padding: 5px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.72rem;
  display: flex;
  align-items: center;
  gap: 4px;
  transition: all 0.2s;
}
.refresh-btn:hover { background: var(--surface-hover); color: var(--text-primary); }
.refresh-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.stats {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  padding: 9px 16px;
  margin-bottom: 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 0.74rem;
  color: var(--text-muted);
}

.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-variant-numeric: tabular-nums;
}
.stat.sep {
  padding-left: 18px;
  border-left: 1px solid var(--border);
}
.stat b { color: var(--text-primary); font-weight: 700; }
.stat b.up { color: var(--red); }
.stat b.down { color: var(--green); }
.stat b.flat { color: var(--text-secondary); }

.dot {
  width: 6px;
  height: 6px;
  border-radius: 2px;
  display: inline-block;
}
.dot.up { background: var(--red); }
.dot.down { background: var(--green); }
.dot.flat { background: var(--text-muted); }

.error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 16px;
  margin-bottom: 10px;
  background: rgba(242, 54, 69, 0.1);
  border: 1px solid rgba(242, 54, 69, 0.2);
  border-radius: 8px;
  color: var(--red);
  font-size: 0.78rem;
}

.first-load {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.spinner {
  width: 30px;
  height: 30px;
  border: 2px solid var(--border);
  border-top-color: var(--text-secondary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.chart {
  flex: 1;
  min-height: 0;
  margin-bottom: 10px;
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}

.legend {
  display: flex;
  align-items: center;
  gap: 8px;
}

.legend-bar {
  width: 76px;
  height: 8px;
  border-radius: 4px;
}
.legend-bar.left {
  background: linear-gradient(90deg, rgba(0, 200, 83, 0.9), rgba(0, 200, 83, 0.30), rgba(255, 255, 255, 0.05));
}
.legend-bar.right {
  background: linear-gradient(90deg, rgba(255, 255, 255, 0.05), rgba(242, 54, 69, 0.30), rgba(242, 54, 69, 0.9));
}

.legend-label {
  font-size: 0.66rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
.legend-zero { color: var(--text-secondary); }

.src {
  font-size: 0.64rem;
  color: var(--text-muted);
  text-align: right;
  flex: 1;
  min-width: 240px;
}
.src b { color: var(--text-secondary); }

@media (max-width: 640px) {
  h1 { font-size: 1.1rem; }
  .hint { display: none; }
  .stats { gap: 12px; font-size: 0.7rem; }
  .stat.sep { border-left: none; padding-left: 0; }
  .src { text-align: left; }
}
</style>
