/**
 * 量能资金分析核心逻辑（纯函数，无IO）
 * 前端（volumeAnalysis.js）与云端（scripts/analyze.mjs）共用同一份分析口径
 */

export const ANALYSIS_DAYS = 241

/** 计算N日均线，返回 null（数据不足时） */
export function calcMA(closes, n) {
  if (closes.length < n) return null
  const slice = closes.slice(-n)
  return slice.reduce((a, b) => a + b, 0) / n
}

/** 量比：今日量 / 前5日均量（不含今日）。>1放量，<1缩量 */
export function calcVolRatio(vols) {
  if (vols.length < 6) return null
  const today = vols[vols.length - 1]
  const prev = vols.slice(-6, -1)
  const avg = prev.reduce((a, b) => a + b, 0) / prev.length
  return avg > 0 ? today / avg : null
}

/** 最近N日均量（含今日） */
export function calcAvgVol(vols, n) {
  if (vols.length < n) return null
  const slice = vols.slice(-n)
  return slice.reduce((a, b) => a + b, 0) / n
}

/** 241天分位：现价在241天最低~最高之间的位置（收盘价口径，0-100） */
export function calcPercentile(closes, todayClose) {
  const window = closes.slice(-ANALYSIS_DAYS)
  if (window.length < 20) return null
  const min = Math.min(...window)
  const max = Math.max(...window)
  if (max <= min) return { pct: 50, min, max, offLow: 0 }
  return {
    pct: Math.round(((todayClose - min) / (max - min)) * 100),
    min,
    max,
    offLow: (todayClose / min - 1) * 100, // 距241天最低点（%）
  }
}

/**
 * 量价四象限
 * 放量：量比≥1.2  缩量：量比≤0.8  平量：中间
 */
export function judgeVolume(volRatio, pct) {
  if (volRatio == null || pct == null) return { quad: '--', label: '数据不足' }
  const expand = volRatio >= 1.2
  const shrink = volRatio <= 0.8
  if (expand && pct > 0) return { quad: '放量涨', label: '放量上涨，有人抢筹' }
  if (expand && pct < 0) return { quad: '放量跌', label: '放量下跌，有人砸盘' }
  if (shrink && pct > 0) return { quad: '缩量涨', label: '缩量上涨，追高意愿弱' }
  if (shrink && pct < 0) return { quad: '缩量跌', label: '缩量下跌，抛压不大' }
  return { quad: '平量' + (pct > 0 ? '涨' : '跌'), label: '量能平平' }
}

/**
 * 阶段判定：止跌 / 转强 / 反转 / 下跌通道 / 横盘
 * - 反转：收盘突破近20日高点（压力位突破）
 * - 转强：放量 + 连续2天收阳 + 站稳MA5
 * - 止跌：缩量 + 未创新低（今日最低 > 前3日最低）
 * - 下跌通道：MA5<MA10<MA20 空头排列
 * - 横盘：其余
 */
export function judgePhase(klines, ma, volRatio) {
  const n = klines.length
  if (n < 20) return { stage: '数据不足', desc: '' }
  const closes = klines.map(k => k.close)
  const lows = klines.map(k => k.low)
  const today = klines[n - 1]
  const prev = klines[n - 2]

  // 反转：突破20日高点
  const high20 = Math.max(...closes.slice(-21, -1))
  if (today.close > high20) {
    return { stage: '反转', desc: `突破20日高点${high20.toFixed(3)}，上方空间打开` }
  }

  // 转强：放量 + 连2阳 + 站稳MA5
  const expand = volRatio != null && volRatio >= 1.2
  const twoUp = prev.close > prev.open && today.close > today.open
  const aboveMA5 = ma.ma5 != null && today.close > ma.ma5
  if (expand && twoUp && aboveMA5) {
    return { stage: '转强', desc: '放量+连阳+站上MA5，转强信号' }
  }

  // 止跌：缩量 + 今日最低 > 前3日最低
  const shrink = volRatio != null && volRatio <= 0.8
  const min3 = Math.min(lows[n - 4], lows[n - 3], lows[n - 2])
  if (shrink && today.low > min3) {
    return { stage: '止跌', desc: '缩量+不创新低，跌不动了' }
  }

  // 下跌通道：空头排列
  if (ma.ma5 != null && ma.ma10 != null && ma.ma20 != null &&
      ma.ma5 < ma.ma10 && ma.ma10 < ma.ma20) {
    return { stage: '下跌通道', desc: 'MA5<MA10<MA20 空头排列，趋势向下' }
  }

  return { stage: '横盘', desc: '无明确方向，等量能选边' }
}

/**
 * 转强信号（用户教学口径）：
 * 量 ≥ 5500万手（科创50绝对阈值）+ 连续2天收阳 + 站稳MA5
 * 其他ETF用相对口径：量 ≥ 25日均量×1.3
 */
export function judgeStrongSignal(code, klines, ma5, volRatio, avgVol25) {
  const n = klines.length
  if (n < 3 || volRatio == null) return null
  const today = klines[n - 1]
  const prev = klines[n - 2]
  const todayVol = today.volume
  const threshold = code === 'sh588000' ? 55_000_000 : (avgVol25 != null ? avgVol25 * 1.3 : null)
  if (threshold == null || todayVol < threshold) return null
  const twoUp = prev.close > prev.open && today.close > today.open
  const aboveMA5 = ma5 != null && today.close > ma5
  if (twoUp && aboveMA5) {
    return { strong: true, volStr: (todayVol / 1e4).toFixed(0) + '万手' }
  }
  // 连阳但量不足 = 虚涨（教学案例：8/4-8/5 假信号）
  if (twoUp && aboveMA5 && volRatio < 1) {
    return { strong: false, fake: true, volStr: (todayVol / 1e4).toFixed(0) + '万手' }
  }
  return null
}

/**
 * 资金四象限：价格方向 × 主力流向
 */
export function judgeFundVerdict(pct, main) {
  if (pct == null || main == null) return { verdict: '--', desc: '数据不足' }
  if (main > 0 && pct > 0) return { verdict: '健康', desc: '涨+主力流入，有资金撑腰' }
  if (main > 0 && pct < 0) return { verdict: '吸筹', desc: '跌+主力流入，跌着有人接' }
  if (main < 0 && pct > 0) return { verdict: '虚涨', desc: '涨+主力流出，涨着有人跑' }
  if (main < 0 && pct < 0) return { verdict: '真跌', desc: '跌+主力流出，资金配合下跌' }
  return { verdict: '平衡', desc: '资金基本打平' }
}

/**
 * 量能×资金组合判断（用户核心需求）：
 * 放量+主力流入=真转强  缩量+主力流入=温和吸筹
 * 放量+主力流出=出货    缩量+主力流出=阴跌
 */
export function judgeCombine(volRatio, main) {
  if (volRatio == null || main == null) return { verdict: '--', desc: '数据不足' }
  const expand = volRatio >= 1.2
  const shrink = volRatio <= 0.8
  if (expand && main > 0) return { verdict: '真转强', desc: '放量+主力流入，最强信号' }
  if (shrink && main > 0) return { verdict: '温和吸筹', desc: '缩量+主力流入，跌不动了' }
  if (expand && main < 0) return { verdict: '出货', desc: '放量+主力流出，最危险' }
  if (shrink && main < 0) return { verdict: '阴跌', desc: '缩量+主力流出，钝刀子' }
  if (main > 0) return { verdict: '流入', desc: '量能平平+主力流入' }
  return { verdict: '流出', desc: '量能平平+主力流出' }
}

/** 格式化资金为 亿/万 字符串 */
export function fmtYi(val) {
  if (val == null || isNaN(val)) return '--'
  const abs = Math.abs(val)
  const sign = val > 0 ? '+' : val < 0 ? '-' : ''
  if (abs >= 1e8) return sign + (abs / 1e8).toFixed(2) + '亿'
  if (abs >= 1e4) return sign + (abs / 1e4).toFixed(1) + '万'
  return sign + abs.toFixed(0)
}

/** 格式化量为 亿/万 手 */
export function fmtVolHand(v) {
  if (v == null || isNaN(v)) return '--'
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿'
  if (v >= 1e4) return (v / 1e4).toFixed(0) + '万'
  return v.toFixed(0)
}

// ===== 新闻标签（云端/前端共用） =====

const BULL_WORDS = [
  '上涨', '大涨', '突破', '拉升', '涨停', '反弹', '增持', '回购', '获批', '核准',
  '超预期', '创新高', '流入', '加仓', '利好', '增长', '扩张', '中标', '提价',
  '复苏', '回暖', '翻倍', '强劲', '加速', '新高', '放量上涨',
]
const BEAR_WORDS = [
  '下跌', '大跌', '跌停', '回落', '跳水', '暴跌', '下挫', '减持', '亏损', '处罚',
  '下调', '利空', '流出', '清仓', '退市', '萎缩', '收缩', '下滑', '暴雷', '诉讼',
  '风险', '警示', '逾期', '违约', '降级', '抛售', '破位', '出货',
]

/** 给新闻标题打标签：'利好' / '利空' / '中性' */
export function tagNews(title) {
  if (!title) return '中性'
  const clean = title.replace(/<[^>]+>/g, '')
  let bull = 0, bear = 0
  for (const w of BULL_WORDS) if (clean.includes(w)) bull++
  for (const w of BEAR_WORDS) if (clean.includes(w)) bear++
  if (bull > bear) return '利好'
  if (bear > bull) return '利空'
  return '中性'
}

/** 清理标题中的HTML标签 */
export function cleanTitle(title) {
  return (title || '').replace(/<[^>]+>/g, '')
}

/** 由K线+资金流构建报告（纯函数，前端/云端共用） */
export function buildReport(code, name, quote, klines, fundFlow) {
  if (!klines.length) {
    return { code, name, error: '无K线数据' }
  }
  const closes = klines.map(k => k.close)
  const vols = klines.map(k => k.volume)
  const n = klines.length
  const today = klines[n - 1]
  const yesterday = klines[n - 2]
  const todayVol = today.volume
  const yesterdayVol = yesterday ? yesterday.volume : null
  const vol5 = calcAvgVol(vols, 5)
  const vol25 = calcAvgVol(vols, 25)
  const volRatio = calcVolRatio(vols)
  const ma5 = calcMA(closes, 5)
  const ma10 = calcMA(closes, 10)
  const ma20 = calcMA(closes, 20)
  const pct = quote?.changePct != null && !isNaN(quote.changePct)
    ? quote.changePct
    : (yesterday && today) ? (today.close / yesterday.close - 1) * 100 : null

  const volQuad = judgeVolume(volRatio, pct)
  const phase = judgePhase(klines, { ma5, ma10, ma20 }, volRatio)
  const strongSignal = judgeStrongSignal(code, klines, ma5, volRatio, vol25)
  const percentile = calcPercentile(closes, today.close)

  // 资金（今日 + 5日）
  let fund = null
  if (fundFlow && fundFlow.length) {
    const last = fundFlow[fundFlow.length - 1]
    const last5 = fundFlow.slice(-5)
    const main5d = last5.reduce((a, f) => a + f.main, 0)
    const fv = judgeFundVerdict(pct ?? last.pct, last.main)
    fund = {
      date: last.date,
      main: last.main,
      superBig: last.superBig,
      big: last.big,
      mid: last.mid,
      small: last.small,
      main5d,
      ...fv,
      verdictDesc: `${fv.verdict}（今日主力${fmtYi(last.main)}，5日累计${fmtYi(main5d)}）`,
    }
  }

  const combine = judgeCombine(volRatio, fund?.main ?? null)

  const report = {
    code,
    name,
    date: today.date,
    price: today.close,
    quote,
    volume: {
      todayVol,
      yesterdayVol,
      vol5,
      vol25,
      volRatio,
      quad: volQuad.quad,
      quadDesc: volQuad.label,
    },
    ma: {
      ma5, ma10, ma20,
      aboveMA5: ma5 != null && today.close > ma5,
      aboveMA10: ma10 != null && today.close > ma10,
      aboveMA20: ma20 != null && today.close > ma20,
    },
    phase,
    strongSignal,
    percentile,
    fund,
    combine,
  }
  report.conclusion = buildConclusion(report)
  return report
}

/** 一句话人话总结 */
export function buildConclusion(rep) {
  const parts = []
  if (rep.strongSignal?.strong) parts.push('转强信号：放量连阳站上MA5')
  else if (rep.strongSignal?.fake) parts.push('连阳但量不足，虚涨！')
  if (rep.fund) parts.push(rep.fund.verdictDesc)
  if (rep.combine && rep.combine.verdict !== '--') parts.push(rep.combine.verdict + '：' + rep.combine.desc)
  if (!parts.length) parts.push(rep.phase.desc)
  return parts.join('；')
}
