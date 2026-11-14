<template>
  <div ref="box" class="heatmap" @mouseleave="hovered = null">
    <div
      v-for="t in tiles"
      :key="t.code"
      class="tile"
      :class="{ held: t.held, flash: flashing.has(t.code), 'is-hover': hovered && hovered.code === t.code }"
      :style="tileStyle(t)"
      @mouseenter="hovered = t"
      @mousemove="onMove"
    >
      <span v-if="t.held" class="held-dot" title="你持仓的板块">持仓</span>
      <span v-if="t.showName" class="tile-name" :style="{ fontSize: t.fs.name + 'px' }">{{ t.name }}</span>
      <span v-if="t.fs.pct" class="tile-pct" :style="{ fontSize: t.fs.pct + 'px' }">{{ fmtPct(t.pct) }}</span>
      <span v-if="t.fs.amt" class="tile-amt" :style="{ fontSize: t.fs.amt + 'px' }">{{ fmtAmount(t.amount) }}</span>
    </div>

    <!-- 悬停详情 -->
    <div v-if="hovered" class="tip" :style="tipStyle">
      <div class="tip-head">
        <span class="tip-name">{{ hovered.name }}</span>
        <span v-if="hovered.held" class="tip-held">持仓</span>
      </div>
      <div class="tip-pct" :class="hovered.pct >= 0 ? 'up' : 'down'">{{ fmtPct(hovered.pct) }}</div>
      <div class="tip-rows">
        <span>成交额</span><b>{{ fmtAmount(hovered.amount) }}</b>
        <span>换手率</span><b>{{ hovered.turnover.toFixed(2) }}%</b>
        <span>流通市值</span><b>{{ hovered.floatCap.toFixed(0) }}亿</b>
        <span>量比</span><b>{{ hovered.volRatio.toFixed(2) }}</b>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { HELD_SECTORS, sectorFill, sectorTextTone, formatPct, formatAmountYi } from '../services/sectorApi.js'

const props = defineProps({
  items: { type: Array, required: true },
  maxAbs: { type: Number, required: true },
  flashing: { type: Set, default: () => new Set() },
})

const box = ref(null)
const size = ref({ w: 0, h: 0 })
const hovered = ref(null)
const pointer = ref({ x: 0, y: 0 })
let ro = null

const fmtPct = formatPct
const fmtAmount = formatAmountYi

onMounted(() => {
  ro = new ResizeObserver(entries => {
    const r = entries[0].contentRect
    size.value = { w: Math.floor(r.width), h: Math.floor(r.height) }
  })
  ro.observe(box.value)
})
onUnmounted(() => { if (ro) ro.disconnect() })

function onMove(e) {
  pointer.value = { x: e.clientX, y: e.clientY }
}

const tiles = computed(() => {
  const { w, h } = size.value
  if (!w || !h || !props.items.length) return []

  const laid = squarify(props.items, w, h)
  return laid.map(t => {
    const fg = sectorTextTone(t.pct, props.maxAbs)
    const nameFs = t.w >= 132 ? 15 : t.w >= 96 ? 13 : t.w >= 70 ? 12 : 11
    return {
      ...t,
      held: HELD_SECTORS.includes(t.name),
      fill: sectorFill(t.pct, props.maxAbs),
      fg,
      // 方块够大才写字，太小就留白 —— 详情走悬停
      fs: {
        name: nameFs,
        pct: t.w >= 110 && t.h >= 64 ? 26 : t.w >= 78 && t.h >= 50 ? 19 : 0,
        amt: t.w >= 110 && t.h >= 92 ? 11 : 0,
      },
      // 中文字宽约等于字号，放不下就整条不写，免得裁成半截字
      showName: t.h >= 20 && t.w >= t.name.length * nameFs + 8,
    }
  })
})

function tileStyle(t) {
  return {
    left: t.x + 1 + 'px',
    top: t.y + 1 + 'px',
    width: Math.max(0, t.w - 2) + 'px',
    height: Math.max(0, t.h - 2) + 'px',
    background: t.fill,
    color: t.fg === 'light' ? '#fff' : 'var(--text-primary)',
  }
}

const tipStyle = computed(() => {
  const x = Math.min(pointer.value.x + 16, window.innerWidth - 200)
  const y = Math.min(pointer.value.y + 16, window.innerHeight - 170)
  return { left: x + 'px', top: y + 'px' }
})

/**
 * Squarified treemap（Bruls / Huizing / van Wijk）
 * 面积 ∝ 成交额，尽量让每块接近正方形
 */
function squarify(items) {
  const { w: W, h: H } = size.value
  const total = items.reduce((s, i) => s + Math.max(i.amount, 1), 0)
  const zone = W * H
  const scaled = items
    .map(i => ({ ...i, value: (Math.max(i.amount, 1) / total) * zone }))
    .sort((a, b) => b.value - a.value)

  const out = []
  place(scaled, 0, 0, W, H, out)
  return out
}

function place(row, x, y, w, h, out) {
  if (!row.length || w <= 0 || h <= 0) return
  if (row.length === 1) {
    out.push({ ...row[0], x, y, w, h })
    return
  }

  const side = Math.min(w, h)
  let cur = [row[0]]
  let rest = row.slice(1)
  let best = worstRatio(cur, side)

  while (rest.length) {
    const next = cur.concat(rest[0])
    const score = worstRatio(next, side)
    if (score > best) break
    cur = next
    rest = rest.slice(1)
    best = score
  }

  const sum = cur.reduce((s, i) => s + i.value, 0)
  if (w >= h) {
    const rw = sum / h
    let yy = y
    for (const it of cur) {
      const ih = rw > 0 ? it.value / rw : 0
      out.push({ ...it, x, y: yy, w: rw, h: ih })
      yy += ih
    }
    place(rest, x + rw, y, w - rw, h, out)
  } else {
    const rh = sum / w
    let xx = x
    for (const it of cur) {
      const iw = rh > 0 ? it.value / rh : 0
      out.push({ ...it, x: xx, y, w: iw, h: rh })
      xx += iw
    }
    place(rest, x, y + rh, w, h - rh, out)
  }
}

/** 一行的最差长宽比，越小越方正 */
function worstRatio(row, side) {
  const sum = row.reduce((s, i) => s + i.value, 0)
  if (sum <= 0) return Infinity
  let max = -Infinity
  let min = Infinity
  for (const i of row) {
    if (i.value > max) max = i.value
    if (i.value < min) min = i.value
  }
  const s2 = sum * sum
  const side2 = side * side
  return Math.max((side2 * max) / s2, s2 / (side2 * min))
}
</script>

<style scoped>
.heatmap {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 320px;
}

.tile {
  position: absolute;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  cursor: default;
  transition: filter 0.15s ease, box-shadow 0.15s ease;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}

.tile.is-hover {
  filter: brightness(1.18);
  box-shadow: inset 0 0 0 2px rgba(255, 255, 255, 0.55);
  z-index: 3;
}

.tile.flash {
  animation: flash 0.7s ease-out;
}

@keyframes flash {
  0%   { filter: brightness(1.85); }
  100% { filter: brightness(1); }
}

.tile-name {
  font-weight: 600;
  letter-spacing: 0.5px;
  white-space: nowrap;
  opacity: 0.92;
}

.tile-pct {
  font-weight: 700;
  letter-spacing: -0.5px;
}

.tile-amt {
  opacity: 0.62;
  white-space: nowrap;
}

.held-dot {
  position: absolute;
  top: 4px;
  left: 4px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.5px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.9);
  color: #0f1419;
}

.tip {
  position: fixed;
  z-index: 50;
  pointer-events: none;
  min-width: 168px;
  padding: 10px 12px;
  background: rgba(15, 20, 25, 0.97);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(6px);
}

.tip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.tip-name {
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--text-primary);
}

.tip-held {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--red-bg);
  color: var(--red);
  border: 1px solid rgba(242, 54, 69, 0.3);
}

.tip-pct {
  font-size: 1.35rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  margin-bottom: 8px;
}

.tip-pct.up   { color: var(--red); }
.tip-pct.down { color: var(--green); }

.tip-rows {
  display: grid;
  grid-template-columns: auto auto;
  gap: 3px 14px;
  font-size: 0.7rem;
  color: var(--text-muted);
}

.tip-rows b {
  text-align: right;
  font-weight: 600;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

@media (max-width: 640px) {
  .heatmap { min-height: 260px; }
  .tip { display: none; }
}
</style>
