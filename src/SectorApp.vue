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

    <div class="stats" v-if="items.length">
      <span class="stat"><i class="dot up"></i>红 <b class="up">{{ upCount }}</b></span>
      <span class="stat"><i class="dot down"></i>绿 <b class="down">{{ downCount }}</b></span>
      <span class="stat"><i class="dot flat"></i>平 <b class="flat">{{ flatCount }}</b></span>
      <span class="stat sep">合计成交额 <b>{{ formatAmountYi(totalAmount) }}</b></span>
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
      <span>正在拉取 31 个行业板块…</span>
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
      <div class="src">
        数据来源：腾讯行情 · 涨跌幅口径为腾讯板块指数，与东财/同花顺的申万指数会有出入，属正常
      </div>
    </footer>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import SectorHeatmap from './components/SectorHeatmap.vue'
import { fetchSectors, maxAbsPct, formatPct, formatDataTime, formatAmountYi } from './services/sectorApi.js'
import { isTradingTime } from './services/stockApi.js'

const CACHE_KEY = 'sector-snapshot-v1'

const items = ref([])
const error = ref('')
const loading = ref(false)
const marketOpen = ref(false)
const dataTime = ref('')
const flashing = ref(new Set())

let timer = null
let flashTimer = null

const maxAbs = computed(() => (items.value.length ? maxAbsPct(items.value) : 1))
const upCount = computed(() => items.value.filter(i => i.pct > 0).length)
const downCount = computed(() => items.value.filter(i => i.pct < 0).length)
const flatCount = computed(() => items.value.filter(i => i.pct === 0).length)
const totalAmount = computed(() => items.value.reduce((s, i) => s + i.amount, 0))
const best = computed(() => items.value.reduce((a, b) => (b.pct > a.pct ? b : a), items.value[0]))
const worst = computed(() => items.value.reduce((a, b) => (b.pct < a.pct ? b : a), items.value[0]))

/** 先在本地缓存上直接出画面，不让用户对着白屏等 */
function paintFromCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return
    const snap = JSON.parse(raw)
    if (Array.isArray(snap?.items) && snap.items.length) {
      items.value = snap.items
      dataTime.value = snap.dataTime || ''
    }
  } catch { /* 缓存坏了就当没有 */ }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ items: items.value, dataTime: dataTime.value }))
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
  if (loading.value) return
  loading.value = true
  try {
    const data = await fetchSectors()
    if (data.length) {
      items.value = data
      dataTime.value = formatDataTime(data[0].time)
      saveCache()
    }
    error.value = ''
    marketOpen.value = isTradingTime()
  } catch (e) {
    // 失败不清屏，保留上一次的数据
    error.value = e.message || '获取板块数据失败，请检查网络'
  } finally {
    loading.value = false
  }
}

function scheduleNext() {
  clearTimeout(timer)
  const interval = isTradingTime() ? 15_000 : 60_000
  timer = setTimeout(async () => {
    await refresh()
    scheduleNext()
  }, interval)
}

onMounted(() => {
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
  margin-bottom: 10px;
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

@media (max-width: 640px) {
  h1 { font-size: 1.1rem; }
  .hint { display: none; }
  .stats { gap: 12px; font-size: 0.7rem; }
  .stat.sep { border-left: none; padding-left: 0; }
  .src { text-align: left; }
}
</style>
