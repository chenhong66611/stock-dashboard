#!/usr/bin/env node
/**
 * 云端量能分析脚本（GitHub Actions 每5分钟调度）
 *
 * 分析全部11只标的（量能+阶段+均线+分位+资金+组合判断），邮件在关键时点发送：
 *  - 早报  09:00  （全量报告 + 新闻）
 *  - 盘中① 10:00  （关键信号，有信号才发）
 *  - 盘中② 13:30  （关键信号）
 *  - 盘中③ 14:45  （关键信号）
 *  - 复盘  15:05  （全量报告 + 新闻）
 *
 * 防重：.alert-last 文件记录"日期:类型"，当天同类型只发一次
 * 假日：K线最后日期距今天超过3天则跳过（避免节假日空报）
 *
 * 输出：mail.html（邮件正文）+ mail_subject.txt；无需发送时不生成
 */
import fs from 'node:fs'
import { buildReport, tagNews, cleanTitle, fmtYi, fmtVolHand } from '../src/services/analysisCore.js'
import { fetchKline, fetchFundFlow } from '../src/services/volumeAnalysis.js'

// 标的列表（与前端 stockApi.js 保持一致）
const INDEX_LIST = [
  { code: 'sh510310', name: '沪深300ETF' },
  { code: 'sh588000', name: '科创50ETF' },
  { code: 'sh560010', name: '中证1000' },
  { code: 'sz159755', name: '电池' },
  { code: 'sh515790', name: '光伏' },
  { code: 'sz159869', name: '游戏' },
  { code: 'sh515250', name: '智能汽车' },
  { code: 'sh512710', name: '军工' },
  { code: 'sz159996', name: '家电' },
  { code: 'sh512980', name: '传媒' },
  { code: 'sz159766', name: '旅游' },
]

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六']

// ===== 北京时间工具 =====
function bjParts() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' })
  const d = new Date(s)
  return {
    y: d.getFullYear(),
    m: d.getMonth() + 1,
    day: d.getDate(),
    hh: String(d.getHours()).padStart(2, '0'),
    mm: String(d.getMinutes()).padStart(2, '0'),
    week: WEEK_CN[d.getDay()],
  }
}
function bjKey() {
  const p = bjParts()
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

// ===== 决策：本次该发什么 =====
function decideType() {
  const p = bjParts()
  const t = p.hh + ':' + p.mm
  if (t >= '09:00' && t < '09:10') return 'morning'   // 早报
  if (t >= '10:00' && t < '10:10') return 'signal'    // 盘中①
  if (t >= '13:30' && t < '13:40') return 'signal'    // 盘中②
  if (t >= '14:45' && t < '14:55') return 'signal'    // 盘中③
  if (t >= '15:05' && t < '15:15') return 'review'    // 复盘
  return null
}

// ===== 防重标记 =====
const LAST_FILE = '.alert-last'
function markSent(type) {
  const marker = bjKey() + ':' + type
  let last = ''
  try { last = fs.readFileSync(LAST_FILE, 'utf-8').trim() } catch { /* 首次运行 */ }
  if (last === marker) return false
  fs.writeFileSync(LAST_FILE, marker)
  return true
}

// ===== 数据拉取 =====
async function fetchAll() {
  const reports = []
  for (const it of INDEX_LIST) {
    try {
      const [klines, fund] = await Promise.all([
        fetchKline(it.code).catch(() => []),
        fetchFundFlow(it.code).catch(() => []),
      ])
      if (!klines.length) {
        reports.push({ code: it.code, name: it.name, error: '无K线' })
        continue
      }
      const rep = buildReport(it.code, it.name, null, klines, fund)
      rep.quotePct = rep.price && klines.length > 1
        ? (klines[klines.length - 1].close / klines[klines.length - 2].close - 1) * 100
        : null
      reports.push(rep)
    } catch (e) {
      reports.push({ code: it.code, name: it.name, error: e.message })
    }
  }
  return reports
}

// ===== 新闻（云端直接fetch，无CORS限制） =====
async function fetchNews(keyword, pageSize = 3) {
  const param = JSON.stringify({
    uid: '', keyword,
    type: ['cmsArticleWebOld'], client: 'web', clientType: 'web', clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize, preTag: '<em>', postTag: '</em>' } },
  })
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(param)}`
  try {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } })
    const text = await resp.text()
    const json = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')))
    return (json?.result?.cmsArticleWebOld || []).map(a => ({
      title: cleanTitle(a.title),
      date: (a.date || '').slice(5, 16),
      source: a.mediaName || '',
      tag: tagNews(a.title),
      url: a.url || '',
    }))
  } catch (e) {
    return []
  }
}

// ===== 邮件HTML =====
const ESC = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const RED = '#f23645'
const GREEN = '#00a854'
const GRAY = '#8e99a4'

function colorOf(v) { return v > 0 ? RED : v < 0 ? GREEN : GRAY }
function sign(v, digits = 2) {
  if (v == null || isNaN(v)) return '--'
  return (v > 0 ? '+' : '') + v.toFixed(digits)
}

function stageBadge(stage) {
  const map = { 转强: 'background:#f23645;color:#fff', 反转: 'background:#f23645;color:#fff', 止跌: 'background:#00a854;color:#fff', 下跌通道: 'background:#d9e6d9;color:#1a7a3a', 横盘: 'background:#eef1f5;color:#5e6873' }
  const st = map[stage] || 'background:#eef1f5;color:#5e6873'
  return `<span style="padding:1px 8px;border-radius:8px;font-size:12px;${st}">${ESC(stage)}</span>`
}

function newsHtml(news) {
  if (!news.length) return '<p style="color:#8e99a4;font-size:12px">暂无新闻</p>'
  const tagColor = { 利好: RED, 利空: GREEN, 中性: GRAY }
  return news.map(n =>
    `<p style="margin:4px 0;font-size:13px;line-height:1.5">` +
    `<span style="color:#fff;background:${tagColor[n.tag] || GRAY};padding:0 6px;border-radius:6px;font-size:11px;margin-right:6px">${n.tag}</span>` +
    `<a href="${ESC(n.url)}" style="color:#333;text-decoration:none">${ESC(n.title)}</a>` +
    `<span style="color:#8e99a4;font-size:11px;margin-left:6px">${ESC(n.date)}${n.source ? ' · ' + ESC(n.source) : ''}</span></p>`
  ).join('')
}

function reportRows(reports) {
  return reports.map(r => {
    if (r.error) return `<tr><td>${ESC(r.name)}</td><td colspan="7" style="color:#f23645">${ESC(r.error)}</td></tr>`
    const pct = r.quotePct ?? r.price
    const v = r.volume
    const fundMain = r.fund?.main
    const main5 = r.fund?.main5d
    return `<tr style="border-bottom:1px solid #eee">
      <td style="padding:6px 8px;font-weight:600">${ESC(r.name)}</td>
      <td style="padding:6px 8px;text-align:right">${r.price.toFixed(3)}</td>
      <td style="padding:6px 8px;text-align:right;color:${pct != null && !isNaN(pct) ? colorOf(pct) : GRAY}">${pct != null && !isNaN(pct) ? sign(pct) + '%' : '--'}</td>
      <td style="padding:6px 8px;text-align:center">${stageBadge(r.phase.stage)}</td>
      <td style="padding:6px 8px;text-align:center">${v.volRatio ? v.volRatio.toFixed(2) : '--'}<span style="color:#8e99a4;font-size:11px"> ${ESC(v.quad)}</span></td>
      <td style="padding:6px 8px;text-align:center;color:${r.combine?.verdict === '真转强' ? RED : r.combine?.verdict === '出货' ? GREEN : GRAY};font-weight:600">${ESC(r.combine?.verdict || '--')}</td>
      <td style="padding:6px 8px;text-align:right;color:${fundMain ? colorOf(fundMain) : GRAY}">${fundMain ? fmtYi(fundMain) : '--'}</td>
      <td style="padding:6px 8px;text-align:right;color:${main5 ? colorOf(main5) : GRAY}">${main5 ? fmtYi(main5) : '--'}</td>
    </tr>`
  }).join('')
}

function buildHtml(type, reports, news, signals) {
  const p = bjParts()
  const typeName = { morning: '早报', review: '复盘', signal: '盘中信号' }[type]
  const dateStr = `${p.m}月${p.day}日 周${p.week}`

  // 大盘情绪：3只正式标的
  const formal = reports.slice(0, 3)
  const formalOk = formal.filter(r => !r.error)
  const avg = formalOk.length ? formalOk.reduce((a, r) => a + (r.quotePct ?? 0), 0) / formalOk.length : null
  const moodText = avg == null ? '数据不足' : avg > 0.3 ? '偏暖 🔥' : avg < -0.3 ? '偏冷 🧊' : '中性 ⚖️'
  const moodColor = avg == null ? GRAY : avg > 0.3 ? RED : avg < -0.3 ? GREEN : GRAY

  // 持仓重点：科创50（唯一持仓）
  const held = reports.find(r => r.code === 'sh588000')

  let heldHtml = ''
  if (held && !held.error) {
    heldHtml = `
    <h3 style="margin-top:24px">⭐ 持仓：科创50ETF</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;background:#fafbfc">
      <tr style="background:#f0f2f5">
        <th style="padding:6px 8px;text-align:left">阶段</th><th style="padding:6px 8px">量比/量价</th><th style="padding:6px 8px">MA5</th><th style="padding:6px 8px">MA10</th><th style="padding:6px 8px">MA20</th>
        <th style="padding:6px 8px">241分位</th><th style="padding:6px 8px">主力今日</th><th style="padding:6px 8px">5日累计</th>
      </tr>
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:6px 8px;text-align:center">${stageBadge(held.phase.stage)}</td>
        <td style="padding:6px 8px;text-align:center">${held.volume.volRatio ? held.volume.volRatio.toFixed(2) : '--'} ${ESC(held.volume.quad)}</td>
        <td style="padding:6px 8px;text-align:center;color:${held.ma.aboveMA5 ? RED : GRAY}">${held.ma.ma5?.toFixed(3) ?? '--'}</td>
        <td style="padding:6px 8px;text-align:center;color:${held.ma.aboveMA10 ? RED : GRAY}">${held.ma.ma10?.toFixed(3) ?? '--'}</td>
        <td style="padding:6px 8px;text-align:center;color:${held.ma.aboveMA20 ? RED : GRAY}">${held.ma.ma20?.toFixed(3) ?? '--'}</td>
        <td style="padding:6px 8px;text-align:center">${held.percentile?.pct ?? '--'}%</td>
        <td style="padding:6px 8px;text-align:right;color:${held.fund ? colorOf(held.fund.main) : GRAY}">${held.fund ? fmtYi(held.fund.main) : '--'}</td>
        <td style="padding:6px 8px;text-align:right;color:${held.fund ? colorOf(held.fund.main5d) : GRAY}">${held.fund ? fmtYi(held.fund.main5d) : '--'}</td>
      </tr>
    </table>
    <p style="font-size:13px;color:#333;background:#fff8e6;border-left:4px solid #ffc107;padding:8px 12px;border-radius:4px">${ESC(held.conclusion)}</p>`
  }

  let signalHtml = ''
  if (signals.length) {
    signalHtml = `
    <h3 style="margin-top:24px">🔔 盘中关键信号</h3>
    ${signals.map(s => `<p style="font-size:13px;margin:4px 0">${s}</p>`).join('')}`
  }

  const headerColor = { morning: '#1a73e8', review: '#8e44ad', signal: '#e67e22' }[type]

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#333">
  <div style="background:${headerColor};color:#fff;padding:14px 20px;border-radius:10px">
    <h2 style="margin:0;font-size:18px">📈 ETF量能${typeName} · ${dateStr}</h2>
    <p style="margin:6px 0 0;font-size:13px;opacity:.9">自动分析 · 数据仅供参考</p>
  </div>

  <p style="font-size:13px;margin-top:16px">大盘情绪：<b style="color:${moodColor};font-size:15px">${moodText}</b>
    <span style="color:#8e99a4">${formalOk.map(r => `${ESC(r.name)} ${sign(r.quotePct)}%`).join(' · ')}</span></p>

  ${signalHtml}
  ${heldHtml}

  <h3 style="margin-top:24px">📋 全部标的速览</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px;background:#fafbfc">
    <tr style="background:#f0f2f5">
      <th style="padding:6px 8px;text-align:left">标的</th><th style="padding:6px 8px">现价</th><th style="padding:6px 8px">涨跌</th>
      <th style="padding:6px 8px">阶段</th><th style="padding:6px 8px">量比</th><th style="padding:6px 8px">组合</th>
      <th style="padding:6px 8px">主力今日</th><th style="padding:6px 8px">5日累计</th>
    </tr>
    ${reportRows(reports)}
  </table>

  <h3 style="margin-top:24px">📰 要闻（利好/利空）</h3>
  ${newsHtml(news)}

  <p style="margin-top:28px;font-size:11px;color:#8e99a4;border-top:1px solid #eee;padding-top:10px">
    信号口径：转强=量≥5500万(科创50)/25日均量×1.3 + 连续2天收阳 + 站稳MA5 · 主力/散户为按单笔成交金额估算的代理指标<br>
    本邮件由 GitHub Actions 自动生成，不构成投资建议
  </p>
</body></html>`
}

// ===== 主流程 =====
async function main() {
  // ALERT_TYPE 环境变量可强制类型（本地测试用）：morning / signal / review
  const type = process.env.ALERT_TYPE || decideType()
  if (!type) {
    console.log('非发送时点，跳过')
    process.exit(0)
  }
  if (!markSent(type)) {
    console.log(`今天已发过 ${type}，跳过`)
    process.exit(0)
  }

  console.log(`开始分析（${type}）...`)
  const reports = await fetchAll()

  // 假日判断：K线最后日期距今天 >3天
  const lastDate = reports.find(r => !r.error)?.date
  if (lastDate) {
    const diff = (Date.now() - new Date(lastDate + 'T00:00:00+08:00')) / 86400_000
    if (diff > 3) {
      console.log('非交易日（最后K线 ' + lastDate + '），跳过')
      process.exit(0)
    }
  }

  // 信号收集（早报/复盘也列信号，盘中只有信号邮件才发）
  const signals = []
  for (const r of reports) {
    if (r.error) continue
    if (r.strongSignal?.strong) signals.push(`🔥 <b>${ESC(r.name)}</b> 转强信号：量 ${ESC(r.strongSignal.volStr)}，连阳站上MA5（现价 ${r.price.toFixed(3)}，${sign(r.quotePct)}%）`)
    if (r.phase?.stage === '反转') signals.push(`↗️ <b>${ESC(r.name)}</b> 反转：突破20日高点（现价 ${r.price.toFixed(3)}）`)
    if (r.combine?.verdict === '出货') signals.push(`⚠️ <b>${ESC(r.name)}</b> 出货：放量+主力流出，最危险（现价 ${r.price.toFixed(3)}，主力${fmtYi(r.fund?.main)}）`)
    if (r.fund?.verdict === '吸筹') signals.push(`🧲 <b>${ESC(r.name)}</b> 吸筹：跌+主力流入，跌着有人接（现价 ${r.price.toFixed(3)}，主力${fmtYi(r.fund.main)}）`)
    if (r.phase?.stage === '止跌') signals.push(`🛑 <b>${ESC(r.name)}</b> 止跌：缩量不创新低（现价 ${r.price.toFixed(3)}）`)
  }

  // 盘中信号：无信号不发邮件
  if (type === 'signal' && !signals.length) {
    console.log('盘中无关键信号，不发送')
    process.exit(0)
  }

  // 新闻（早报/复盘带，盘中信号不带）
  let news = []
  if (type !== 'signal') {
    const groups = await Promise.all([
      fetchNews('A股', 3),
      fetchNews('ETF', 2),
      fetchNews('科创50', 2),
    ])
    news = groups.flat()
  }

  const html = buildHtml(type, reports, news, signals)
  const p = bjParts()
  const typeName = { morning: '早报', review: '复盘', signal: '盘中信号' }[type]
  fs.writeFileSync('mail.html', html)
  fs.writeFileSync('mail_subject.txt', `ETF量能${typeName} ${p.m}月${p.day}日 ${signals.length ? `(${signals.length}个信号)` : ''}`)
  console.log(`已生成邮件：${typeName}，信号 ${signals.length} 条，标的 ${reports.length} 只`)
}

main().catch(e => {
  console.error('分析失败:', e)
  process.exit(1)
})
