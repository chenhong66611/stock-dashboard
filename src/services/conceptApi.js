/**
 * 算力产业链 · 同花顺概念板块
 * 数据源：d.10jqka.com.cn/v6/realhead/bk_XXXXXX/defer/last.js
 *
 * 说明：
 * 1. 每个板块一个请求 —— 这个接口不支持批量，实测逗号/分号拼多只会 404。
 * 2. 响应是 JSONP 包裹的 quotebridge JSON（`quotebridge_xxx({...})`），纯数字键取值。
 * 3. 字段号不是猜的：同花顺概念详情页的表格头直接写着 `field="19"` 这类属性，
 *    爬下来对照过 —— 19=成交额、199112=涨跌幅、1968584=换手、3475914=流通市值。
 *    交叉验证：成交额 ÷ 流通市值 = 换手率，三个数完全自洽。
 * 4. 接口本身不发任何 cookie，带 Access-Control-Allow-Origin: *，浏览器可直连。
 */

export const CONCEPTS = [
  { bk: '885756', name: '芯片概念' },
  { bk: '886042', name: '存储芯片' },
  { bk: '886009', name: '先进封装' },
  { bk: '885908', name: '第三代半导体', short: '三代半导体' },
  { bk: '886033', name: '共封装光学(CPO)', short: 'CPO' },
  { bk: '886073', name: '铜缆高速连接', short: '铜缆高速' },
  { bk: '886044', name: '液冷服务器', short: '液冷' },
  { bk: '885887', name: '数据中心(AIDC)', short: 'AIDC' },
  { bk: '885957', name: '东数西算(算力)', short: '东数西算' },
  { bk: '886050', name: '算力租赁' },
  { bk: '885959', name: 'PCB概念', short: 'PCB' },
  { bk: '886048', name: '英伟达概念', short: '英伟达' },
  { bk: '885800', name: '消费电子概念', short: '消费电子' },
]

/** 同花顺 realhead 的数字键（来源：概念详情页表头的 field 属性） */
const F = {
  price: '10',          // 现价（板块指数点位）
  amount: '19',         // 成交额（元）
  change: '264648',     // 涨跌
  pct: '199112',        // 涨跌幅 %
  amplitude: '526792',  // 振幅 %
  turnover: '1968584',  // 换手 %
  volRatio: '1771976',  // 量比
  floatCap: '3475914',  // 流通市值（元）
}

function boardUrl(bk) {
  return `https://d.10jqka.com.cn/v6/realhead/bk_${bk}/defer/last.js`
}

/**
 * 拉取全部算力概念板块的实时行情
 * 单个板块失败不拖垮整页 —— 能拿到几个就先显示几个
 * @returns {Promise<Array>} [{ code, name, pct, amount(亿), turnover, floatCap(亿), volRatio, amplitude, time }]
 */
export async function fetchConcepts() {
  const results = await Promise.all(
    CONCEPTS.map(async meta => {
      try {
        const resp = await fetch(boardUrl(meta.bk))
        if (!resp.ok) return null
        return parseOne(meta, await resp.text())
      } catch {
        return null
      }
    })
  )

  const items = results.filter(Boolean)
  if (!items.length) throw new Error('概念板块数据拉取失败，请稍后重试')
  return items
}

function parseOne(meta, text) {
  // quotebridge_v6_realhead_bk_885756_defer_last({...});
  const m = text.match(/\(\s*(\{[\s\S]*\})\s*\)\s*;?\s*$/)
  if (!m) return null

  let payload
  try {
    payload = JSON.parse(m[1])
  } catch {
    return null
  }

  const it = payload.items
  if (!it) return null

  const num = key => {
    const v = parseFloat(it[key])
    return isNaN(v) ? 0 : v
  }

  return {
    code: meta.bk,
    name: it.name || meta.name,
    short: meta.short || '',
    pct: num(F.pct),
    amount: num(F.amount) / 1e8,       // 元 → 亿元
    turnover: num(F.turnover),
    floatCap: num(F.floatCap) / 1e8,   // 元 → 亿元
    volRatio: num(F.volRatio),
    amplitude: num(F.amplitude),
    time: it.updateTime || '',
  }
}

/** "2026-11-13 15:00" → "11-13 15:00" */
export function formatUpdateTime(raw) {
  if (!raw || raw.length < 16) return '--'
  return raw.slice(5, 16)
}
