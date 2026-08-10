<template>
  <div class="index-card" :class="{ up: isUp, down: isDown }">
    <!-- 标题行 -->
    <div class="card-header">
      <span class="card-name">{{ data.name }}</span>
      <span class="card-code">{{ data.code?.replace(/^(sh|sz)/, '').toUpperCase() }}</span>
    </div>

    <!-- 价格与涨跌幅 -->
    <div class="card-price-row">
      <span class="card-price">{{ formatPrice(data.price) }}</span>
      <span class="card-change" :class="{ up: isUp, down: isDown }">
        <template v-if="isUp">▲</template>
        <template v-else-if="isDown">▼</template>
        {{ formatChange(data.change) }}
      </span>
      <span class="card-pct" :class="{ up: isUp, down: isDown }">
        {{ formatPct(data.changePct) }}%
      </span>
    </div>

    <!-- 今日高低区间条 -->
    <div class="range-bar-wrap" v-if="data.high > 0 && data.low > 0">
      <div class="range-bar">
        <div class="range-fill" :style="{ left: rangeLeft + '%', width: rangeWidth + '%' }"
             :class="{ up: isUp, down: isDown }"></div>
      </div>
      <div class="range-labels">
        <span class="range-label low">{{ formatPrice(data.low) }}</span>
        <span class="range-label label-middle">今日最低</span>
        <span class="range-label label-middle">今日最高</span>
        <span class="range-label high">{{ formatPrice(data.high) }}</span>
      </div>
    </div>

    <!-- 建议横幅 -->
    <div class="banner" :class="bannerClass">
      <span class="banner-icon">{{ bannerIcon }}</span>
      <span class="banner-text">{{ bannerText }}</span>
    </div>

    <!-- 持仓信息 -->
    <div class="hold-bar">
      <span>持仓</span>
      <span class="hold-amount">{{ holding }} 元</span>
    </div>

    <!-- 网格计划 -->
    <div class="grid-wrap">
      <div class="grid-title">{{ isWatch ? '👀 参考观察' : '📊 正式网格' }}</div>
      <div class="grid-body">
        <!-- 卖出目标 -->
        <div class="grid-row sell" :class="{ active: atSell }">
          <span class="grid-dot"></span>
          <span class="grid-label">🔴 目标卖出 ({{ grid.gain }})</span>
          <span class="grid-price">{{ grid.s1 }}<template v-if="grid.s2 != '--'"> / {{ grid.s2 }}</template></span>
        </div>
        <!-- 当前价 -->
        <div class="grid-row current">
          <span class="grid-dot cur-dot">▶</span>
          <span class="grid-label cur-label">★ 当前价</span>
          <span class="grid-price cur-price">{{ price.toFixed(3) }}</span>
        </div>
        <!-- 买入区 -->
        <div class="grid-row buy" :class="{ active: atBuy1 }">
          <span class="grid-dot"></span>
          <span class="grid-label">🟢 买入① {{ grid.amt1 }}</span>
          <span class="grid-price">{{ grid.b1 }}</span>
        </div>
        <div class="grid-row buy" :class="{ active: atBuy2 }">
          <span class="grid-dot"></span>
          <span class="grid-label">🟢 买入② {{ grid.amt2 }}</span>
          <span class="grid-price">{{ grid.b2 }}</span>
        </div>
        <div class="grid-row buy" :class="{ active: atBuy3 }" v-if="grid.amt3">
          <span class="grid-dot"></span>
          <span class="grid-label">🟢 买入③ {{ grid.amt3 }}</span>
          <span class="grid-price">{{ grid.b3 }}</span>
        </div>
        <!-- 规则提示 -->
        <div class="grid-rule">
          ⏱ 每档买入后冷却 {{ grid.cooldown }} 再考虑下一档
          <template v-if="grid.note"> · {{ grid.note }}</template>
        </div>
      </div>
    </div>

    <!-- 详情 -->
    <div class="card-details">
      <div class="detail-item">
        <span class="detail-label">今开</span>
        <span class="detail-value">{{ formatPrice(data.open) }}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">昨收</span>
        <span class="detail-value">{{ formatPrice(data.prevClose) }}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">成交量</span>
        <span class="detail-value">{{ formatVolume(data.volume) }}</span>
      </div>
      <div class="detail-item">
        <span class="detail-label">更新</span>
        <span class="detail-value time">{{ data.time || '--' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { formatPrice, formatVolume } from '../services/stockApi.js'

const props = defineProps({
  data: { type: Object, required: true },
  holding: { type: Number, default: 0 },
})

// 每只ETF的网格计划（8/7 定稿，基于历史K线数据）
const GRID = {
  // ===== 正式网格 =====
  sh510310: {
    sell1: 4.90,
    buy1: 4.45, buy2: 4.30, buy3: null,
    amount1: '100份', amount2: '100份', amount3: '',
    cooldown: '3天',
    targetGain: '+10%',
    note: '压舱石，波动最小',
  },
  sh588000: {
    sell1: 2.02,
    sell2: 2.20,
    buy1: 1.76, buy2: 1.65, buy3: 1.55,
    amount1: '200份', amount2: '200份', amount3: '200份',
    cooldown: '3天',
    targetGain: '+15%~+25%',
    note: '分批卖：2.02卖75%，2.20卖25%',
  },
  sh560010: {
    sell1: 3.10,
    buy1: 2.88, buy2: 2.75, buy3: 2.62,
    amount1: '100份', amount2: '100份', amount3: '100份',
    cooldown: '3天',
    targetGain: '+8%',
    note: '已走完一轮（2.88→3.10）',
  },
  // ===== 参考观察（额外资金）=====
  // 8/10 定稿：三档全部锚定"过去241天最低收盘价"，均有真实触发记录，120天有效
  sz159755: {
    sell1: 1.10,
    buy1: 0.93, buy2: 0.88, buy3: 0.825,
    amount1: '100份', amount2: '200份', amount3: '200份',
    cooldown: '3天',
    targetGain: '+18%',
    note: '电池：出清尾声，离触发最近',
  },
  sh515790: {
    sell1: 1.00,
    buy1: 0.83, buy2: 0.79, buy3: 0.75,
    amount1: '100份', amount2: '200份', amount3: '200份',
    cooldown: '3天',
    targetGain: '+21%',
    note: '光伏：美国封锁出尽',
  },
  sz159869: {
    sell1: 1.25,
    buy1: 1.10, buy2: 1.045, buy3: 0.995,
    amount1: '100份', amount2: '200份', amount3: '200份',
    cooldown: '3天',
    targetGain: '+14%',
    note: '游戏：版号破千+出海',
  },
  sh512980: {
    sell1: 0.97,
    buy1: 0.84, buy2: 0.80, buy3: 0.76,
    amount1: '100份', amount2: '200份', amount3: '200份',
    cooldown: '3天',
    targetGain: '+16%',
    note: '传媒：与游戏同板块',
  },
  sh512710: {
    sell1: 0.70,
    buy1: 0.615, buy2: 0.598, buy3: 0.585,
    amount1: '100份', amount2: '200份', amount3: '200份',
    cooldown: '3天',
    targetGain: '+14%',
    note: '军工龙头：十五五规划+军贸出海',
  },
  sz159766: {
    sell1: 0.61,
    buy1: 0.562, buy2: 0.547, buy3: 0.532,
    amount1: '100份', amount2: '200份', amount3: '200份',
    cooldown: '3天',
    targetGain: '+13%',
    note: '旅游：暑期旺季+旅游强国规划',
  },
  sz159996: {
    sell1: 1.629,
    buy1: 1.40, buy2: 1.38, buy3: 1.36,
    amount1: '100份', amount2: '200份', amount3: '200份',
    cooldown: '3天',
    targetGain: '+16%',
    note: '家电：出口修复+持仓历史低位',
  },
  sh515250: {
    sell1: 1.086,
    buy1: 0.945, buy2: 0.928, buy3: 0.912,
    amount1: '100份', amount2: '200份', amount3: '200份',
    cooldown: '3天',
    targetGain: '+15%',
    note: '智能汽车：全场最低分位5%',
  },
}

const cfg = computed(() => GRID[props.data.code] || null)
const price = computed(() => props.data.price || 0)
const isUp = computed(() => props.data.change > 0)
const isDown = computed(() => props.data.change < 0)

// 网格各档位价格
const grid = computed(() => {
  const g = cfg.value
  if (!g) return { s1:'--', s2:'--', b1:'--', b2:'--', b3:'--', amt1:'', amt2:'', amt3:'', cooldown:'', gain:'' }
  return {
    s1: g.sell1.toFixed(3),
    s2: g.sell2 != null ? g.sell2.toFixed(3) : '--',
    b1: g.buy1.toFixed(3),
    b2: g.buy2 != null ? g.buy2.toFixed(3) : '--',
    b3: g.buy3 != null ? g.buy3.toFixed(3) : '--',
    amt1: g.amount1, amt2: g.amount2, amt3: g.amount3,
    cooldown: g.cooldown,
    gain: g.targetGain,
    note: g.note || '',
  }
})

// 是否为参考观察标的
const isWatch = computed(() => props.data.watch || false)

// 当前价触达了哪个档位
const atSell = computed(() => cfg.value && price.value >= cfg.value.sell1)
const atBuy1 = computed(() => cfg.value && price.value <= cfg.value.buy1 && (cfg.value.buy2 == null || price.value > cfg.value.buy2))
const atBuy2 = computed(() => cfg.value && cfg.value.buy2 != null && price.value <= cfg.value.buy2 && (cfg.value.buy3 == null || price.value > cfg.value.buy3))
const atBuy3 = computed(() => cfg.value && cfg.value.buy3 != null && price.value <= cfg.value.buy3)

const bannerClass = computed(() => {
  if (!cfg.value || !price.value) return ''
  if (atSell.value) return 'banner-sell-all'
  if (atBuy1.value || atBuy2.value || atBuy3.value) return 'banner-buy'
  // 距买① 5%以内
  if (cfg.value && price.value < cfg.value.buy1 && price.value > cfg.value.buy1 * 0.95) return 'banner-warn'
  return 'banner-wait'
})

const bannerIcon = computed(() => {
  if (!cfg.value || !price.value) return '⏳'
  if (atSell.value) return '🔴'
  if (atBuy1.value || atBuy2.value || atBuy3.value) return '🟢'
  return '⏳'
})

const bannerText = computed(() => {
  if (!cfg.value || !price.value) return '加载中...'
  if (atSell.value) return '建议：全部卖出 🏆'
  if (atBuy1.value) return `建议：买入① ${cfg.value.amount1}（万联证券）`
  if (atBuy2.value) return `建议：买入② ${cfg.value.amount2}（注意冷却期≥3天）`
  if (atBuy3.value) return `建议：买入③ ${cfg.value.amount3}（极端机会！）`
  if (cfg.value && price.value < cfg.value.buy1 && price.value > cfg.value.buy1 * 0.95) return '接近买入①，盯紧！'
  return '等待回调，不到不动'
})

// 当前价格在高低区间内的位置（%）
const rangeLeft = computed(() => {
  const { high, low } = props.data
  if (high <= low || price.value <= 0) return 0
  return Math.max(0, Math.min(100, ((price.value - low) / (high - low)) * 100))
})
const rangeWidth = computed(() => Math.max(2, 100 - rangeLeft.value))

function formatChange(val) {
  if (val == null || isNaN(val)) return '--'
  return (val > 0 ? '+' : '') + val.toFixed(2)
}
function formatPct(val) {
  if (val == null || isNaN(val)) return '--'
  return (val > 0 ? '+' : '') + val.toFixed(2)
}
</script>

<style scoped>
.index-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px;
  transition: all 0.25s ease;
  cursor: default;
}
.index-card:hover {
  background: var(--surface-hover);
  transform: translateY(-2px);
  box-shadow: var(--shadow);
}
.index-card.up    { border-left: 3px solid var(--red); }
.index-card.down  { border-left: 3px solid var(--green); }
.index-card:not(.up):not(.down) { border-left: 3px solid var(--text-muted); }

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.card-name {
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.5px;
}
.card-code {
  font-size: 0.65rem;
  color: var(--text-muted);
  background: rgba(255,255,255,0.04);
  padding: 1px 8px;
  border-radius: 4px;
  margin-left: auto;
}

/* ===== 价格 ===== */
.card-price-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}
.card-price {
  font-size: 2rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.card-change {
  font-size: 1rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.card-pct {
  font-size: 0.9rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.up  { color: var(--red); }
.down{ color: var(--green); }

/* ===== 高低区间条 ===== */
.range-bar-wrap {
  margin-bottom: 14px;
}
.range-bar {
  height: 4px;
  background: rgba(255,255,255,0.06);
  border-radius: 4px;
  overflow: hidden;
  position: relative;
}
.range-fill {
  height: 100%;
  border-radius: 4px;
  position: absolute;
  top: 0;
  transition: all 0.3s ease;
}
.range-fill.up   { background: linear-gradient(90deg, rgba(242,54,69,0.3), var(--red)); }
.range-fill.down { background: linear-gradient(90deg, rgba(0,200,83,0.3), var(--green)); }
.range-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
}
.range-label {
  font-size: 0.6rem;
  font-variant-numeric: tabular-nums;
}
.range-label.low  { color: var(--green); }
.range-label.high { color: var(--red); }
.label-middle { color: var(--text-muted); }

/* ===== 建议横幅 ===== */
.banner {
  padding: 10px 14px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  font-size: 0.9rem;
  font-weight: 600;
}
.banner-icon { font-size: 1.1rem; }

.banner-wait {
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border);
  color: var(--text-secondary);
}
.banner-warn {
  background: rgba(255, 200, 0, 0.1);
  border: 1px solid rgba(255, 200, 0, 0.25);
  color: #ffc107;
}
.banner-buy {
  background: rgba(0, 200, 83, 0.12);
  border: 1px solid rgba(0, 200, 83, 0.3);
  color: var(--green);
}
.banner-sell-one {
  background: rgba(255, 200, 0, 0.12);
  border: 1px solid rgba(255, 200, 0, 0.3);
  color: #ffc107;
}
.banner-sell-two {
  background: rgba(255, 140, 0, 0.12);
  border: 1px solid rgba(255, 140, 0, 0.3);
  color: #ff8c00;
}
.banner-sell-all {
  background: rgba(242, 54, 69, 0.12);
  border: 1px solid rgba(242, 54, 69, 0.3);
  color: var(--red);
}

/* ===== 持仓信息 ===== */
.hold-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: rgba(255,255,255,0.02);
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 0.75rem;
  color: var(--text-secondary);
}
.hold-amount {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}

/* ===== 网格计划 ===== */
.grid-wrap {
  margin-bottom: 14px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
}
.grid-title {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 8px;
  letter-spacing: 1px;
}
.grid-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.grid-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 4px;
  font-size: 0.78rem;
  color: var(--text-muted);
  transition: all 0.2s;
}
.grid-dot {
  width: 6px; height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.grid-row.sell .grid-dot { background: rgba(242,54,69,0.3); }
.grid-row.buy  .grid-dot { background: rgba(0,200,83,0.3); }

.grid-label { flex: 1; }
.grid-price {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  min-width: 48px;
  text-align: right;
}

/* 激活态 - 价格已触达 */
.grid-row.sell.active {
  background: rgba(242,54,69,0.08);
  color: var(--red);
  font-weight: 600;
}
.grid-row.sell.active .grid-dot { background: var(--red); }

.grid-row.buy.active {
  background: rgba(0,200,83,0.08);
  color: var(--green);
  font-weight: 600;
}
.grid-row.buy.active .grid-dot { background: var(--green); }

/* 当前价行 */
.grid-row.current {
  background: rgba(255,255,255,0.04);
  color: var(--text-primary);
  font-weight: 700;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  padding: 6px 8px;
  margin: 2px 0;
}
.cur-dot {
  width: auto !important; height: auto !important;
  background: none !important;
  font-size: 0.65rem;
  color: var(--text-secondary);
}
.cur-label { color: var(--text-primary); }
.cur-price {
  color: var(--text-primary);
  font-size: 0.9rem;
}

/* 规则提示 */
.grid-rule {
  font-size: 0.6rem;
  color: var(--text-muted);
  text-align: center;
  padding: 4px 0 0;
  border-top: 1px solid rgba(255,255,255,0.03);
  margin-top: 2px;
  letter-spacing: 0.3px;
}

/* ===== 详情 ===== */
.card-details {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 16px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.detail-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.detail-label {
  font-size: 0.7rem;
  color: var(--text-muted);
}
.detail-value {
  font-size: 0.8rem;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.detail-value.time {
  font-size: 0.7rem;
  color: var(--text-secondary);
}
</style>
