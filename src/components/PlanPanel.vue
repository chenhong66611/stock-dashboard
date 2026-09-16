<template>
  <section class="plan" v-if="rows.length">
    <div class="plan-head" @click="open = !open">
      <span class="plan-title">📋 交易计划</span>
      <span class="plan-date">{{ PLAN_DATE }} 制定</span>
      <span class="plan-spacer"></span>
      <span class="plan-alert" v-if="triggeredCount">🔔 {{ triggeredCount }} 档到价</span>
      <span class="plan-toggle">{{ open ? '▲ 收起' : '▼ 展开' }}</span>
    </div>

    <div v-show="open" class="plan-body">
      <div class="hint">不到价不动 · 到价的那一行会自己亮起来</div>

      <div class="pos" v-for="r in rows" :key="r.code">
        <div class="pos-head">
          <span class="pos-name">{{ r.name }}</span>
          <span class="pos-code">{{ r.code.replace(/^(sh|sz)/, '') }}</span>
          <span class="pos-price" :class="cls(r.changePct)">{{ r.price.toFixed(3) }}</span>
          <span class="pos-chg" :class="cls(r.changePct)">{{ fmtPct(r.changePct) }}</span>
        </div>

        <div class="rows">
          <!-- 卖出档（高 → 低） -->
          <div class="row row-sell" v-for="s in r.sells" :key="'s' + s.price" :class="{ hit: r.price >= s.price }">
            <span class="tag">卖</span>
            <span class="lv">{{ s.price.toFixed(3) }}</span>
            <span class="dist">{{ dist(r.price, s.price) }}</span>
            <span class="act">减 {{ s.pct }}%</span>
            <span class="note">{{ s.note }}</span>
            <span class="flag" v-if="r.price >= s.price">到价</span>
          </div>

          <!-- 认错线 -->
          <div class="row row-stop" :class="{ hit: r.price <= r.stop.price }">
            <span class="tag">认错</span>
            <span class="lv">{{ r.stop.price.toFixed(3) }}</span>
            <span class="dist">{{ dist(r.price, r.stop.price) }}</span>
            <span class="act">全清</span>
            <span class="note">{{ r.stop.note }}</span>
            <span class="flag" v-if="r.price <= r.stop.price">触发</span>
          </div>

          <!-- 买入档（高 → 低） -->
          <div class="row row-buy" v-for="b in r.buys" :key="'b' + b.price" :class="{ hit: r.price <= b.price }">
            <span class="tag">买</span>
            <span class="lv">{{ b.price.toFixed(3) }}</span>
            <span class="dist">{{ dist(r.price, b.price) }}</span>
            <span class="act">买一档</span>
            <span class="note">停留 {{ b.stopDays }} 天</span>
            <span class="flag" v-if="r.price <= b.price">到价</span>
          </div>
        </div>

        <div class="pos-foot" v-if="r.footnote">⚠ {{ r.footnote }}</div>
      </div>

      <!-- 铁律 -->
      <div class="rules">
        <div class="rules-title">铁律</div>
        <ol>
          <li v-for="(t, i) in RULES" :key="i">{{ t }}</li>
        </ol>
      </div>
    </div>
  </section>
</template>

<script setup>
import { ref, computed } from 'vue'
import { PLAN, PLAN_DATE, RULES } from '../data/plan.js'

const props = defineProps({
  indices: { type: Array, default: () => [] },
})

const open = ref(true)

const priceMap = computed(() => {
  const m = {}
  for (const i of props.indices) m[i.code] = i
  return m
})

const rows = computed(() =>
  PLAN.map((p) => {
    const q = priceMap.value[p.code]
    return { ...p, price: q?.price || 0, changePct: q?.changePct || 0 }
  }).filter((r) => r.price > 0)
)

const triggeredCount = computed(() => {
  let n = 0
  for (const r of rows.value) {
    n += r.sells.filter((s) => r.price >= s.price).length
    if (r.price <= r.stop.price) n++
    n += r.buys.filter((b) => r.price <= b.price).length
  }
  return n
})

const fmtPct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%'
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '')
const dist = (cur, lv) => {
  const d = (lv / cur - 1) * 100
  return (d >= 0 ? '+' : '') + d.toFixed(1) + '%'
}
</script>

<style scoped>
.plan {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 24px;
  overflow: hidden;
}

.plan-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--border);
}
.plan-head:hover { background: var(--surface-hover); }
.plan-title { font-size: 15px; font-weight: 600; }
.plan-date { font-size: 12px; color: var(--text-muted); }
.plan-spacer { flex: 1; }
.plan-alert {
  font-size: 12px;
  font-weight: 600;
  color: var(--red);
  background: var(--red-bg);
  border: 1px solid rgba(242, 54, 69, 0.3);
  border-radius: 6px;
  padding: 2px 8px;
}
.plan-toggle { font-size: 12px; color: var(--text-secondary); }

.plan-body { padding: 14px 18px 20px; }

.hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-bottom: 6px;
}

/* 持仓块 */
.pos {
  border-top: 1px solid var(--border);
  padding: 14px 0;
}
.pos:first-of-type { border-top: none; padding-top: 6px; }

.pos-head {
  display: flex;
  align-items: baseline;
  gap: 9px;
  flex-wrap: wrap;
  margin-bottom: 9px;
}
.pos-name { font-size: 14px; font-weight: 600; }
.pos-code { font-size: 11px; color: var(--text-muted); }
.pos-price { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; margin-left: 4px; }
.pos-chg { font-size: 12px; font-variant-numeric: tabular-nums; }

/* 档位行 */
.rows {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}
.row {
  display: grid;
  grid-template-columns: 40px 62px 62px 1fr auto auto;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid var(--border);
}
.row:last-child { border-bottom: none; }

.tag {
  font-size: 11px;
  text-align: center;
  border-radius: 4px;
  padding: 2px 0;
  background: var(--bg);
  color: var(--text-secondary);
}
.lv { font-weight: 600; }
.dist { color: var(--text-secondary); font-size: 12px; }
.act { color: var(--text-secondary); font-size: 12px; }
.note { color: var(--text-muted); font-size: 11px; text-align: right; }
.flag {
  font-size: 11px;
  font-weight: 600;
  color: var(--red);
  background: var(--red-bg);
  border-radius: 4px;
  padding: 1px 6px;
}

/* 到价高亮 */
.row-sell.hit { background: var(--red-bg); }
.row-sell.hit .lv, .row-sell.hit .dist { color: var(--red); }
.row-buy.hit { background: var(--green-bg); }
.row-buy.hit .lv, .row-buy.hit .dist { color: var(--green); }
.row-stop { background: rgba(242, 54, 69, 0.04); }
.row-stop .tag { background: rgba(242, 54, 69, 0.15); color: var(--red); }
.row-stop.hit { background: rgba(242, 54, 69, 0.18); }
.row-stop.hit .lv { color: var(--red); font-weight: 700; }

.pos-foot {
  margin-top: 9px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg);
  border-left: 3px solid var(--border);
  padding: 6px 10px;
  border-radius: 0 6px 6px 0;
}

/* 铁律 */
.rules {
  margin-top: 20px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
}
.rules-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.rules ol { margin: 0; padding-left: 20px; }
.rules li {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.9;
}

/* 涨跌色（A股习惯：红涨绿跌） */
.up { color: var(--red); }
.down { color: var(--green); }

@media (max-width: 640px) {
  .row { grid-template-columns: 34px 54px 54px 1fr auto; gap: 6px; padding: 7px 9px; font-size: 12px; }
  .note { display: none; }
}
</style>
