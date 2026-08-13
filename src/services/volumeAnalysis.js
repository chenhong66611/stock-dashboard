/**
 * 量能与资金分析模块（前端数据层）
 *
 * 数据源：
 *  - 日K线：腾讯 web.ifzq.gtimg.cn（CORS ✓）
 *  - 资金流：东财 push2his.eastmoney.com fflow/daykline（CORS ✓）
 *
 * 分析口径统一在 analysisCore.js（前端与云端共用）
 */

import {
  ANALYSIS_DAYS, buildReport, fmtYi, fmtVolHand,
} from './analysisCore.js'

// 内存缓存：K线5分钟，资金流30分钟（日线数据盘中缓慢累积，无需频繁拉取）
const KLINE_TTL = 5 * 60_000
const FUND_TTL = 30 * 60_000
const cache = new Map()

function cacheGet(key, ttlMs) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.t < ttlMs) return hit.data
  return null
}
function cacheSet(key, data) {
  cache.set(key, { t: Date.now(), data })
}

// 资金流请求队列：东财 push2his 接口并发会被限流（实测11并发全挂），串行+间隔
let fundQueue = Promise.resolve()
const FUND_INTERVAL = 300 // ms

function fundThrottled(task) {
  const p = fundQueue.then(task, task)
  fundQueue = p.then(
    () => new Promise(r => setTimeout(r, FUND_INTERVAL)),
    () => new Promise(r => setTimeout(r, FUND_INTERVAL)),
  )
  return p
}

/** 代码 → 东财 secid（sh→1.xxxxxx, sz→0.xxxxxx） */
export function toSecid(code) {
  return code.startsWith('sh') ? '1.' + code.slice(2) : '0.' + code.slice(2)
}

/** 拉取日K线（前复权），返回 [{date, open, close, high, low, volume}]，volume单位：手 */
export async function fetchKline(code, days = ANALYSIS_DAYS) {
  const key = 'kline:' + code + ':' + days
  const hit = cacheGet(key, KLINE_TTL)
  if (hit) return hit
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${days},qfq`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`K线请求失败 (${resp.status})`)
  const json = await resp.json()
  const info = json?.data?.[code]
  const raw = info?.qfqday || info?.day || []
  const data = raw.map(k => ({
    date: k[0], open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5],
  }))
  cacheSet(key, data)
  return data
}

/**
 * 拉取日线资金流（近 N 日），返回：
 * [{date, main, superBig, big, mid, small, close, pct}]  单位：元
 * main = 主力净流入 = 大单 + 超大单（口径已验证）
 */
export async function fetchFundFlow(code, lmt = 30) {
  const key = 'fund:' + code + ':' + lmt
  const hit = cacheGet(key, FUND_TTL)
  if (hit) return hit
  const secid = toSecid(code)
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63&klt=101&lmt=${lmt}`
  // 串行请求 + 失败重试1次（东财限流实测）
  const data = await fundThrottled(async () => {
    try {
      return await doFundFetch()
    } catch (e) {
      await new Promise(r => setTimeout(r, 1500))
      return await doFundFetch()
    }
  })
  cacheSet(key, data)
  return data

  async function doFundFetch() {
    const resp = await fetch(url)
    if (!resp.ok) throw new Error(`资金流请求失败 (${resp.status})`)
    const json = await resp.json()
    const klines = json?.data?.klines || []
    if (!klines.length) throw new Error('资金流数据为空')
    return klines.map(k => {
      const p = k.split(',')
      return {
        date: p[0],
        main: +p[1],      // 主力净流入（元）
        small: +p[2],     // 小单净流入
        mid: +p[3],       // 中单净流入
        big: +p[4],       // 大单净流入
        superBig: +p[5],  // 超大单净流入
        close: +p[11],    // 收盘价
        pct: +p[12],      // 涨跌幅%
      }
    })
  }
}

/**
 * 单只标的完整分析
 * @param {string} code  如 'sh588000'
 * @param {string} name  如 '科创50ETF'
 * @param {object} quote 实时行情 {price, changePct, volume}
 */
export async function analyzeOne(code, name, quote) {
  const [klines, fundFlow] = await Promise.all([
    fetchKline(code).catch(e => { console.warn(name + ' K线失败:', e.message); return [] }),
    fetchFundFlow(code).catch(e => { console.warn(name + ' 资金流失败:', e.message); return [] }),
  ])
  return buildReport(code, name, quote, klines, fundFlow)
}

/** 批量分析（App.vue 调用）：传入 ALL_LIST 和实时行情，返回 {code: report} */
export async function analyzeAll(indices) {
  const etfs = indices.filter(i => !i.ref)
  const tasks = etfs.map(i => analyzeOne(i.code, i.shortName || i.name, {
    price: i.price,
    changePct: i.changePct,
    volume: i.volume,
  }))
  const reports = await Promise.allSettled(tasks)
  const map = {}
  reports.forEach((r, idx) => {
    if (r.status === 'fulfilled') map[etfs[idx].code] = r.value
  })
  return map
}

export { ANALYSIS_DAYS, fmtYi, fmtVolHand }
