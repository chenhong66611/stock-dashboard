#!/usr/bin/env node
/**
 * stock-quote.cjs — A 股实时行情 CLI
 *
 * 用法:
 *   node stock-quote.cjs sh600519                   # 单只股票
 *   node stock-quote.cjs sh600519 sz000001 sh000001  # 多只
 *   node stock-quote.cjs --watch                     # 自选股
 *   node stock-quote.cjs --help                      # 帮助
 *
 * 数据源: 腾讯股票 API (qt.gtimg.cn)
 * 代码格式: sh=上证, sz=深证, hk=港股
 */

const https = require('https')

// ====== 自选列表 ======
const WATCHLIST = [
  { code: 'sh510300', name: '沪深300ETF' },
  { code: 'sh588000', name: '华夏科创50ETF' },
]
// 参考指数（显示在分隔线下方）
const REF_LIST = [
  { code: 'sh000688', name: '科创50指数' },
]

// ====== 帮助 ======
function showHelp() {
  console.log([
    '',
    '  stock-quote --- A 股实时行情 CLI',
    '',
    '  用法: node stock-quote.cjs <codes...>',
    '       node stock-quote.cjs --watch',
    '       node stock-quote.cjs --help',
    '',
    '  代码格式:  sh600519  上证  |  sz000001  深证  |  hk00700  港股',
    '',
    '  示例:',
    '    node stock-quote.cjs sh600519',
    '    node stock-quote.cjs sh000001 sz399001',
    '    node stock-quote.cjs --watch',
    '',
  ].join('\n'))
  process.exit(0)
}

// ====== 调用腾讯 API ======
function fetchQuotes(codes) {
  return new Promise((resolve, reject) => {
    https.get('https://qt.gtimg.cn/q=' + codes.join(','), { timeout: 10000 }, (res) => {
      let data = ''
      res.on('data', function (c) { data += c })
      res.on('end', function () { resolve(data) })
    }).on('error', reject).on('timeout', function () {
      this.destroy()
      reject(new Error('请求超时'))
    })
  })
}

// ====== 解析响应 ======
function parseResponse(raw) {
  const items = []
  var lines = raw.split('\n')
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^v_(\w+)="(.+)";?$/)
    if (!m) continue
    var f = m[2].split('~')
    var price = parseFloat(f[3]) || 0
    var prevClose = parseFloat(f[4]) || 0
    var change = price - prevClose
    var changePct = prevClose > 0 ? (change / prevClose) * 100 : 0
    var t = f[30] || ''
    var timeStr = t.length >= 14
      ? t.slice(0,4) + '-' + t.slice(4,6) + '-' + t.slice(6,8)
        + ' ' + t.slice(8,10) + ':' + t.slice(10,12) + ':' + t.slice(12,14)
      : t
    items.push({
      code: m[1],
      name: f[1] || '--',
      price: price,
      change: change,
      changePct: changePct,
      open: parseFloat(f[5]) || 0,
      high: parseFloat(f[33]) || 0,
      low: parseFloat(f[34]) || 0,
      prevClose: prevClose,
      volume: parseFloat(f[6]) || 0,
      time: timeStr,
    })
  }
  return items
}

// ====== 格式化 ======
function formatOutput(items) {
  var now = new Date()
  var pad = function (n) { return n < 10 ? '0' + n : '' + n }
  var timeStr = now.getFullYear() + '/' + pad(now.getMonth()+1) + '/' + pad(now.getDate())
    + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds())

  var out = []
  out.push('=== A 股实时行情 ===  ' + timeStr)
  out.push('')

  // 参考指数代码列表
  var refCodes = REF_LIST.map(function (r) { return r.code })

  for (var i = 0; i < items.length; i++) {
    var item = items[i]
    var dir = item.change > 0 ? '▲' : item.change < 0 ? '▼' : '─'
    var chg = (item.change > 0 ? '+' : '') + item.change.toFixed(2)
    var pct = (item.changePct > 0 ? '+' : '') + item.changePct.toFixed(2)

    // 参考指数前加分隔线
    if (refCodes.indexOf(item.code) !== -1) {
      out.push('  ───── 参考指数 ─────')
    }

    out.push('  ' + dir + '  ' + item.name + '  (' + item.code + ')')
    out.push('    价格: ' + item.price.toFixed(2) + '  涨跌: ' + chg + '  (' + pct + '%)')
    out.push('    开: ' + item.open.toFixed(2) + '  昨收: ' + item.prevClose.toFixed(2)
      + '  高: ' + item.high.toFixed(2) + '  低: ' + item.low.toFixed(2))

    // 成交量
    var v = item.volume
    var volStr = v >= 1e8 ? (v/1e8).toFixed(2) + '亿'
      : v >= 1e4 ? (v/1e4).toFixed(2) + '万' : (v || '--')
    out.push('    成交量: ' + volStr + '手')

    // 简评
    out.push('    -> ' + comment(item))

    if (item.time) out.push('    [' + item.time + ']')
    out.push('')
  }

  return out.join('\n')
}

function comment(item) {
  var p = Math.abs(item.changePct)
  if (item.change > 0) {
    if (p >= 5) return '大幅上涨'
    if (p >= 3) return '强势上涨'
    if (p >= 1) return '震荡上行'
    return '小幅上涨'
  }
  if (item.change < 0) {
    if (p >= 5) return '大幅下跌'
    if (p >= 3) return '明显下跌'
    if (p >= 1) return '震荡下行'
    return '小幅下跌'
  }
  return '平盘'
}

// ====== 主入口 ======
async function main() {
  var args = process.argv.slice(2)

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp()
    return
  }

  var codes
  if (args[0] === '--watch' || args[0] === '-w') {
    var allCodes = WATCHLIST.concat(REF_LIST)
    codes = allCodes.map(function (x) { return x.code })
    console.log('\n  自选列表:')
    for (var i = 0; i < WATCHLIST.length; i++) {
      console.log('    ' + WATCHLIST[i].code + '  ' + WATCHLIST[i].name)
    }
    if (REF_LIST.length) {
      console.log('  ───── 参考指数 ─────')
      for (var j = 0; j < REF_LIST.length; j++) {
        console.log('    ' + REF_LIST[j].code + '  ' + REF_LIST[j].name)
      }
    }
    console.log('')
  } else {
    codes = args.filter(function (a) { return a[0] !== '-' })
  }

  if (!codes || !codes.length) {
    console.error('错误: 未指定股票代码。使用 --help 查看帮助。')
    process.exit(1)
  }

  try {
    var raw = await fetchQuotes(codes)
    var items = parseResponse(raw)
    if (!items.length) {
      console.error('错误: 未获取到数据，请检查股票代码。')
      process.exit(1)
    }
    console.log(formatOutput(items))
  } catch (err) {
    console.error('错误: 请求失败 - ' + err.message)
    process.exit(1)
  }
}

main()
