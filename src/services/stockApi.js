/**
 * A股实时行情数据服务
 * 数据源：腾讯股票 API (qt.gtimg.cn)
 */

// 自选ETF定义
export const INDEX_LIST = [
  { code: 'sh510310', name: '易方达沪深300ETF', shortName: '沪深300ETF' },
  { code: 'sh588000', name: '华夏科创50ETF', shortName: '科创50ETF' },
  { code: 'sh560010', name: '中证1000ETF', shortName: '中证1000' },
]

// 参考指数（卡片下方显示）
export const REF_LIST = [
  { code: 'sh000688', name: '科创50指数', shortName: '科创50', ref: true },
  { code: 'sh000852', name: '中证1000指数', shortName: '中证1000', ref: true },
]

// 合并列表
export const ALL_LIST = [...INDEX_LIST, ...REF_LIST]

// 判断是否在交易时间（周一到周五 9:30-15:00）
export function isTradingTime() {
  const now = new Date()
  const day = now.getDay()
  const h = now.getHours()
  const m = now.getMinutes()
  if (day === 0 || day === 6) return false
  const total = h * 60 + m
  // 上午 9:30-11:30, 下午 13:00-15:00
  return (total >= 570 && total <= 750) || (total >= 780 && total <= 900)
}

/**
 * 解析腾讯 API 返回的文本数据
 * 格式：v_sh000001="field1~field2~...";
 */
function parseStockData(rawText) {
  const items = []
  const lines = rawText.trim().split('\n')
  for (const line of lines) {
    const match = line.match(/^v_(\w+)="(.+)";?$/)
    if (!match) continue
    const code = match[1]
    const fields = match[2].split('~')
    const price = parseFloat(fields[3]) || 0
    const prevClose = parseFloat(fields[4]) || 0
    const change = price - prevClose
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0
    // 时间格式：20260720153102 → 15:31:02
    const rawTime = fields[30] || ''
    const timeStr = rawTime.length >= 14
      ? `${rawTime.slice(8,10)}:${rawTime.slice(10,12)}:${rawTime.slice(12,14)}`
      : rawTime
    items.push({
      code,
      market:    fields[0] || '',
      name:      fields[1] || '--',
      price,
      change,
      changePct,
      open:      parseFloat(fields[5]) || 0,       // 今开
      high:      parseFloat(fields[33]) || 0,      // 最高
      low:       parseFloat(fields[34]) || 0,      // 最低
      volume:    parseFloat(fields[6]) || 0,       // 成交量（手）
      amount:    0,                                 // 暂不解析成交额，字段位置不稳定
      prevClose,
      time: timeStr,
    })
  }
  return items
}

/**
 * 格式化数字
 */
export function formatPrice(val) {
  if (val == null || isNaN(val)) return '--'
  return val.toFixed(2)
}

export function formatVolume(val) {
  if (!val || isNaN(val)) return '--'
  if (val >= 1e8) return (val / 1e8).toFixed(2) + '亿'
  if (val >= 1e4) return (val / 1e4).toFixed(2) + '万'
  return val.toFixed(0)
}

export function formatAmount(val) {
  if (!val || isNaN(val)) return '--'
  // 接口返回的是万元
  if (val >= 1e4) return (val / 1e4).toFixed(2) + '亿'
  if (val >= 1)   return val.toFixed(2) + '万'
  return val.toFixed(0) + '元'
}

export function formatTime(t) {
  if (!t) return '--'
  return t
}

/**
 * 获取所有自选行情（ETF + 参考指数）
 */
export async function fetchAllIndices() {
  const codes = ALL_LIST.map(i => i.code).join(',')
  const url = `https://qt.gtimg.cn/q=${codes}`
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`请求失败 (${resp.status})`)
  const text = await resp.text()
  if (!text || text.includes('FAILED')) {
    throw new Error('数据源返回异常，请稍后重试')
  }
  const items = parseStockData(text)
  // 合并名称和 ref 信息
  return items.map(item => {
    const meta = ALL_LIST.find(i => i.code === item.code)
    return { ...item, name: meta?.name || item.name, ref: meta?.ref || false }
  })
}
