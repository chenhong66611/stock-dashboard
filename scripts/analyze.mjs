#!/usr/bin/env node
/**
 * 云端量能分析脚本（GitHub Actions 每5分钟调度）
 *
 * 调度（事件驱动，无固定时点，误差≤5分钟）：
 *  - 早报  09:00  必发（全量报告 + 新闻）
 *  - 盘中  09:30-15:00 每5分钟检查，出现新信号/挂单临近立即发（精简邮件）
 *  - 复盘  15:05  必发（全量报告 + 新闻）
 * 每天总上限 MAX_DAILY=12 条（防异常刷屏），早报/复盘不受上限限制
 *
 * 状态：state.json（信号去重 + 当天发送计数 + 挂单提醒去重），推回仓库
 * 防重：.alert-last 记录"日期:类型"（早报/复盘当天一次），兼容旧机制
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

// ===== 挂单配置（只提醒价格临近，不带份数/金额）=====
// levels: 每档 { p: 挂单价, d: 'buy'买入档 | 'sell'卖出档 }
const ORDERS = [
  { code: 'sh588000', name: '科创50ETF', levels: [{ p: 1.55, d: 'buy' }, { p: 2.02, d: 'sell' }] },
  { code: 'sz159755', name: '电池', levels: [{ p: 0.93, d: 'buy' }] },
  { code: 'sh515790', name: '光伏', levels: [{ p: 0.83, d: 'buy' }] },
  { code: 'sz159869', name: '游戏', levels: [{ p: 1.10, d: 'buy' }] },
  { code: 'sh515250', name: '智能汽车', levels: [{ p: 0.945, d: 'buy' }, { p: 0.928, d: 'buy' }] },
  { code: 'sh512710', name: '军工', levels: [{ p: 0.615, d: 'buy' }] },
  { code: 'sz159996', name: '家电', levels: [{ p: 1.392, d: 'buy' }] },
  { code: 'sz159766', name: '旅游', levels: [{ p: 0.547, d: 'buy' }] },
]
const NEAR_RATIO = 0.01   // 距挂单价 ≤1% 触发提醒
const MAX_DAILY = 12      // 每天发送总上限（早报/复盘必发，不受限）

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

// ===== 调度：事件驱动，交易时段内每5分钟都是检查点 =====
// hhmm 形如 "0945"；参数化便于本地测试
function decideType(hhmm) {
  if (hhmm >= '0900' && hhmm < '0910') return 'morning'              // 早报
  if (hhmm >= '1505' && hhmm < '1515') return 'review'               // 复盘
  const isTrading = (hhmm >= '0930' && hhmm < '1135') || (hhmm >= '1300' && hhmm < '1505')
  return isTrading ? 'signal' : null                                 // 盘中触发式
}

// ===== 状态：state.json（当天信号去重 + 发送计数 + 挂单提醒去重）=====
const STATE_FILE = 'state.json'
function loadState() {
  let st = { date: bjKey(), sentSig: [], sentOrder: [], sentType: [], count: 0 }
  try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } } catch { /* 首次 */ }
  if (st.date !== bjKey()) st = { date: bjKey(), sentSig: [], sentOrder: [], sentType: [], count: 0 }
  return st
}
function saveState(st) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(st))
}

// ===== 防重标记（早报/复盘当天一次）=====
const LAST_FILE = '.alert-last'
function markSent(type) {
  const marker = bjKey() + ':' + type
  let last = ''
  try { last = fs.readFileSync(LAST_FILE, 'utf-8').trim() } catch { /* 首次运行 */ }
  if (last === marker) return false
  fs.writeFileSync(LAST_FILE, marker)
  return true
}

// ===== 挂单临近检测 =====
// 返回 [{code, name, p, d, dist, price}]，dist=现价距挂单价百分比（正=接近）
function checkOrders(reports, sentOrder) {
  const alerts = []
  const byCode = {}
  for (const r of reports) if (!r.error) byCode[r.code] = r
  for (const o of ORDERS) {
    const r = byCode[o.code]
    if (!r) continue
    for (const lv of o.levels) {
      const key = `${o.code}:${lv.p}`
      if (sentOrder.includes(key)) continue
      const dist = lv.d === 'buy' ? (r.price - lv.p) / lv.p : (lv.p - r.price) / lv.p
      if (dist >= 0 && dist <= NEAR_RATIO) alerts.push({ code: o.code, name: o.name, p: lv.p, d: lv.d, dist, price: r.price })
    }
  }
  return alerts
}

// ===== 信号收集（结构化：code+类型 用于去重）=====
function collectSignals(reports) {
  const out = []
  for (const r of reports) {
    if (r.error) continue
    const sig = []
    if (r.strongSignal?.strong) sig.push({ code: r.code, sig: '转强', html: `🔥 <b>${ESC(r.name)}</b> 转强信号：量 ${ESC(r.strongSignal.volStr)}，连阳站上MA5（现价 ${r.price.toFixed(3)}，${sign(r.quotePct)}%）` })
    if (r.phase?.stage === '反转') sig.push({ code: r.code, sig: '反转', html: `↗️ <b>${ESC(r.name)}</b> 反转：突破20日高点（现价 ${r.price.toFixed(3)}）` })
    if (r.combine?.verdict === '出货') sig.push({ code: r.code, sig: '出货', html: `⚠️ <b>${ESC(r.name)}</b> 出货：放量+主力流出（主力${fmtYi(r.fund?.main)}，散户${r.fund?.small != null ? fmtYi(r.fund.small) : '--'}），最危险（现价 ${r.price.toFixed(3)}）` })
    if (r.fund?.verdict === '吸筹') sig.push({ code: r.code, sig: '吸筹', html: `🧲 <b>${ESC(r.name)}</b> 吸筹：跌+主力流入（主力${fmtYi(r.fund.main)}，散户${r.fund.small != null ? fmtYi(r.fund.small) : '--'}），跌着有人接（现价 ${r.price.toFixed(3)}）` })
    if (r.phase?.stage === '止跌') sig.push({ code: r.code, sig: '止跌', html: `🛑 <b>${ESC(r.name)}</b> 止跌：缩量不创新低（现价 ${r.price.toFixed(3)}）` })
    out.push(...sig)
  }
  return out
}

// ===== 时段侧重（盘中精简邮件）=====
function periodFocus(hhmm) {
  const t = parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(2), 10)
  if (t < 11 * 60) return { title: '早盘 · 开盘异动', key: 'early' }
  if (t < 14 * 60 + 20) return { title: '午后 · 趋势延续', key: 'mid' }
  return { title: '尾盘 · 资金收尾', key: 'late' }
}

// focus 段内容：3只正式标的 + 持仓
function focusHtml(reports, focus) {
  const list = reports.slice(0, 3).concat(reports.find(r => r.code === 'sh588000')).filter((r, i, a) => r && !r.error && a.indexOf(r) === i)
  if (!list.length) return ''
  const lines = list.map(r => {
    const parts = []
    if (focus.key === 'early') {
      const openGap = r.prevClose ? (r.dayOpen / r.prevClose - 1) * 100 : null
      const vsOpen = r.dayOpen ? (r.price / r.dayOpen - 1) * 100 : null
      parts.push(`开盘${openGap != null ? sign(openGap) + '%' : '--'}`)
      parts.push(`现价${vsOpen != null ? (vsOpen >= 0 ? '高走' : '回落') + sign(vsOpen) + '%' : '--'}`)
      parts.push(`量比${r.volume.volRatio ? r.volume.volRatio.toFixed(2) : '--'}`)
    } else if (focus.key === 'mid') {
      parts.push(`阶段 ${r.phase.stage}`)
      parts.push(r.ma.aboveMA5 ? '站上MA5' : '跌破MA5')
      parts.push(`主力5日 ${r.fund ? fmtYi(r.fund.main5d) : '--'}`)
    } else {
      parts.push(`主力今日 ${r.fund ? fmtYi(r.fund.main) : '--'}`)
      parts.push(`散户 ${r.fund && r.fund.small != null ? fmtYi(r.fund.small) : '--'}`)
      parts.push(r.ma.aboveMA5 ? '收在MA5上方' : '收在MA5下方')
    }
    return `<p style="margin:3px 0;font-size:13px"><b>${ESC(r.name)}</b> ${r.price.toFixed(3)}（${sign(r.quotePct)}%） · ${parts.join(' · ')}</p>`
  }).join('')
  return `<h3 style="margin-top:20px">${focus.title}</h3>${lines}`
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
      rep.dayOpen = klines[klines.length - 1].open
      rep.prevClose = klines.length > 1 ? klines[klines.length - 2].close : null
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
    if (r.error) return `<tr><td>${ESC(r.name)}</td><td colspan="8" style="color:#f23645">${ESC(r.error)}</td></tr>`
    const pct = r.quotePct ?? r.price
    const v = r.volume
    const fundMain = r.fund?.main
    const main5 = r.fund?.main5d
    const fundSmall = r.fund?.small
    return `<tr style="border-bottom:1px solid #eee">
      <td style="padding:6px 8px;font-weight:600">${ESC(r.name)}</td>
      <td style="padding:6px 8px;text-align:right">${r.price.toFixed(3)}</td>
      <td style="padding:6px 8px;text-align:right;color:${pct != null && !isNaN(pct) ? colorOf(pct) : GRAY}">${pct != null && !isNaN(pct) ? sign(pct) + '%' : '--'}</td>
      <td style="padding:6px 8px;text-align:center">${stageBadge(r.phase.stage)}</td>
      <td style="padding:6px 8px;text-align:center">${v.volRatio ? v.volRatio.toFixed(2) : '--'}<span style="color:#8e99a4;font-size:11px"> ${ESC(v.quad)}</span></td>
      <td style="padding:6px 8px;text-align:center;color:${r.combine?.verdict === '真转强' ? RED : r.combine?.verdict === '出货' ? GREEN : GRAY};font-weight:600">${ESC(r.combine?.verdict || '--')}</td>
      <td style="padding:6px 8px;text-align:right;color:${fundMain ? colorOf(fundMain) : GRAY}">${fundMain ? fmtYi(fundMain) : '--'}</td>
      <td style="padding:6px 8px;text-align:right;color:${fundSmall != null ? colorOf(fundSmall) : GRAY}">${fundSmall != null ? fmtYi(fundSmall) : '--'}</td>
      <td style="padding:6px 8px;text-align:right;color:${main5 ? colorOf(main5) : GRAY}">${main5 ? fmtYi(main5) : '--'}</td>
    </tr>`
  }).join('')
}

// 挂单提醒 HTML
function orderHtml(orderAlerts) {
  if (!orderAlerts.length) return ''
  const dirText = { buy: '买入', sell: '卖出' }
  const lines = orderAlerts.map(o =>
    `<p style="margin:4px 0;font-size:13px">🎯 <b>${ESC(o.name)}</b> 距${dirText[o.d]}价 <b>${o.p.toFixed(3)}</b> 还有 <b style="color:${RED}">${(o.dist * 100).toFixed(1)}%</b>（现价 ${o.price.toFixed(3)}）——准备操作</p>`
  ).join('')
  return `<h3 style="margin-top:20px">🎯 挂单临近提醒</h3>${lines}`
}

// 盘中持仓速览（精简邮件专用）：一行
function heldLine(r) {
  if (!r || r.error) return ''
  const pct = r.quotePct ?? r.price
  return `<p style="margin:4px 0;font-size:13px">⭐ <b>持仓 ${ESC(r.name)}</b> ${r.price.toFixed(3)}（${sign(pct)}%） · ${stageBadge(r.phase.stage)} · 量比${r.volume.volRatio ? r.volume.volRatio.toFixed(2) : '--'} · 主力${r.fund ? fmtYi(r.fund.main) : '--'} · 散户${r.fund && r.fund.small != null ? fmtYi(r.fund.small) : '--'}</p>`
}

function buildHtml(type, reports, news, signals, orderAlerts, focus) {
  const p = bjParts()
  const typeName = { morning: '早报', review: '复盘', signal: '盘中信号' }[type]
  const dateStr = `${p.m}月${p.day}日 周${p.week}`
  const headerColor = { morning: '#1a73e8', review: '#8e44ad', signal: '#e67e22' }[type]

  const head = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;max-width:720px;margin:0 auto;padding:20px;color:#333">
  <div style="background:${headerColor};color:#fff;padding:14px 20px;border-radius:10px">
    <h2 style="margin:0;font-size:18px">📈 ETF量能${typeName} · ${dateStr}</h2>
    <p style="margin:6px 0 0;font-size:13px;opacity:.9">自动分析 · 数据仅供参考</p>
  </div>`

  const foot = `<p style="margin-top:28px;font-size:11px;color:#8e99a4;border-top:1px solid #eee;padding-top:10px">
    信号口径：转强=量≥5500万(科创50)/25日均量×1.3 + 连续2天收阳 + 站稳MA5 · 主力/散户为按单笔成交金额估算的代理指标<br>
    本邮件由 GitHub Actions 自动生成，不构成投资建议
  </p></body></html>`

  // ===== 盘中精简邮件 =====
  if (type === 'signal') {
    const held = reports.find(r => r.code === 'sh588000')
    return head +
      (focus ? focusHtml(reports, focus) : '') +
      (signals.length ? `<h3 style="margin-top:20px">🔔 新信号</h3>${signals.map(s => `<p style="font-size:13px;margin:4px 0">${s.html}</p>`).join('')}` : '') +
      orderHtml(orderAlerts) +
      heldLine(held) +
      foot
  }

  // ===== 全量邮件（早报/复盘）=====
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
        <th style="padding:6px 8px">241分位</th><th style="padding:6px 8px">主力今日</th><th style="padding:6px 8px">散户今日</th><th style="padding:6px 8px">5日累计</th>
      </tr>
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:6px 8px;text-align:center">${stageBadge(held.phase.stage)}</td>
        <td style="padding:6px 8px;text-align:center">${held.volume.volRatio ? held.volume.volRatio.toFixed(2) : '--'} ${ESC(held.volume.quad)}</td>
        <td style="padding:6px 8px;text-align:center;color:${held.ma.aboveMA5 ? RED : GRAY}">${held.ma.ma5?.toFixed(3) ?? '--'}</td>
        <td style="padding:6px 8px;text-align:center;color:${held.ma.aboveMA10 ? RED : GRAY}">${held.ma.ma10?.toFixed(3) ?? '--'}</td>
        <td style="padding:6px 8px;text-align:center;color:${held.ma.aboveMA20 ? RED : GRAY}">${held.ma.ma20?.toFixed(3) ?? '--'}</td>
        <td style="padding:6px 8px;text-align:center">${held.percentile?.pct ?? '--'}%</td>
        <td style="padding:6px 8px;text-align:right;color:${held.fund ? colorOf(held.fund.main) : GRAY}">${held.fund ? fmtYi(held.fund.main) : '--'}</td>
        <td style="padding:6px 8px;text-align:right;color:${held.fund && held.fund.small != null ? colorOf(held.fund.small) : GRAY}">${held.fund && held.fund.small != null ? fmtYi(held.fund.small) : '--'}</td>
        <td style="padding:6px 8px;text-align:right;color:${held.fund ? colorOf(held.fund.main5d) : GRAY}">${held.fund ? fmtYi(held.fund.main5d) : '--'}</td>
      </tr>
    </table>
    <p style="font-size:13px;color:#333;background:#fff8e6;border-left:4px solid #ffc107;padding:8px 12px;border-radius:4px">${ESC(held.conclusion)}</p>`
  }

  let signalHtml = ''
  if (signals.length) {
    signalHtml = `
    <h3 style="margin-top:24px">🔔 盘中关键信号</h3>
    ${signals.map(s => `<p style="font-size:13px;margin:4px 0">${s.html}</p>`).join('')}`
  }

  return head + `
  <p style="font-size:13px;margin-top:16px">大盘情绪：<b style="color:${moodColor};font-size:15px">${moodText}</b>
    <span style="color:#8e99a4">${formalOk.map(r => `${ESC(r.name)} ${sign(r.quotePct)}%`).join(' · ')}</span></p>

  ${signalHtml}
  ${orderHtml(orderAlerts)}
  ${heldHtml}

  <h3 style="margin-top:24px">📋 全部标的速览</h3>
  <table style="border-collapse:collapse;width:100%;font-size:13px;background:#fafbfc">
    <tr style="background:#f0f2f5">
      <th style="padding:6px 8px;text-align:left">标的</th><th style="padding:6px 8px">现价</th><th style="padding:6px 8px">涨跌</th>
      <th style="padding:6px 8px">阶段</th><th style="padding:6px 8px">量比</th><th style="padding:6px 8px">组合</th>
      <th style="padding:6px 8px">主力今日</th><th style="padding:6px 8px">散户今日</th><th style="padding:6px 8px">5日累计</th>
    </tr>
    ${reportRows(reports)}
  </table>

  <h3 style="margin-top:24px">📰 要闻（利好/利空）</h3>
  ${newsHtml(news)}
  ${foot}`
}

// ===== 主流程 =====
async function main() {
  const now = bjParts()
  const hhmm = now.hh + now.mm
  const type = process.env.ALERT_TYPE || decideType(hhmm)
  if (!type) {
    console.log('非发送时点，跳过')
    process.exit(0)
  }

  const st = loadState()
  const p = bjParts()
  const dateStr = `${p.m}月${p.day}日 周${p.week}`

  // 早报/复盘：当天一次（.alert-last 防重）
  if (type !== 'signal') {
    if (!markSent(type)) {
      console.log(`今天已发过 ${type}，跳过`)
      process.exit(0)
    }
  } else if (st.count >= MAX_DAILY) {
    console.log(`今天已发 ${st.count} 条，达到上限 ${MAX_DAILY}，跳过`)
    process.exit(0)
  }

  console.log(`开始分析（${type} ${hhmm}）...`)
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

  // 信号：盘中只发"新出现"的（当天已发过的同标的同信号不再发）
  const allSignals = collectSignals(reports)
  const freshSignals = allSignals.filter(s => !st.sentSig.includes(s.code + ':' + s.sig))

  // 挂单临近（每单当天提醒一次）
  const orderAlerts = checkOrders(reports, st.sentOrder)

  // 盘中：无新信号且无挂单临近 → 不发
  if (type === 'signal' && !freshSignals.length && !orderAlerts.length) {
    console.log('盘中无新信号、无挂单临近，不发送')
    process.exit(0)
  }

  // 新闻（早报/复盘带，盘中不带）
  let news = []
  if (type !== 'signal') {
    const groups = await Promise.all([
      fetchNews('A股', 3),
      fetchNews('ETF', 2),
      fetchNews('科创50', 2),
    ])
    news = groups.flat()
  }

  // 盘中：当日已发信号也列出（标注"延续"），让持仓者知道状态
  const focus = type === 'signal' ? periodFocus(hhmm) : null
  const html = buildHtml(type, reports, news, freshSignals, orderAlerts, focus)
  const typeName = { morning: '早报', review: '复盘', signal: '盘中信号' }[type]
  fs.writeFileSync('mail.html', html)
  fs.writeFileSync('mail_subject.txt', `ETF量能${typeName} ${p.m}月${p.day}日 ${freshSignals.length ? `(${freshSignals.length}个新信号)` : orderAlerts.length ? '(挂单临近)' : ''}`)
  console.log(`已生成邮件：${typeName}，新信号 ${freshSignals.length} 条，挂单提醒 ${orderAlerts.length} 条`)

  // 发送成功前不更新状态；由 workflow 调用方在发送后执行 saveState 的后续（通过 git commit）
  // 但 state 需要发送后才算数——这里把本次内容记入，workflow 发送失败也不会重发（宁可少发）
  if (type !== 'signal' && !st.sentType.includes(type)) st.sentType.push(type)
  for (const s of freshSignals) st.sentSig.push(s.code + ':' + s.sig)
  for (const o of orderAlerts) st.sentOrder.push(o.code + ':' + o.p)
  st.count += 1
  saveState(st)
}

if (!process.env.SKIP_MAIN) {
  main().catch(e => {
    console.error('分析失败:', e)
    process.exit(1)
  })
}
export { buildHtml, decideType, checkOrders, collectSignals }
