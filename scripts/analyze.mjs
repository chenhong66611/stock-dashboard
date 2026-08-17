#!/usr/bin/env node
/**
 * 云端量能分析脚本（GitHub Actions 每5分钟调度）
 *
 * 调度（事件驱动，无固定时点，误差≤5分钟）：
 *  - 早报  09:00  必发（全量报告 + 新闻）
 *  - 盘中  09:30-15:00 每5分钟检查，出现新信号/挂单临近立即发（精简邮件）
 *  - 复盘  15:05  必发（全量报告 + 新闻）
 * 每天总上限 MAX_DAILY=60 条（防异常刷屏），早报/复盘不受上限限制
 *
 * 状态：state.json（信号去重 + 当天发送计数 + 挂单提醒去重），推回仓库
 * 防重：.alert-last 记录"日期:类型"（早报/复盘当天一次），兼容旧机制
 * 假日：K线最后日期距今天超过3天则跳过（避免节假日空报）
 *
 * 输出：mail.html（邮件正文）+ mail_subject.txt；无需发送时不生成
 */
import fs from 'node:fs'
import { buildReport, tagNews, cleanTitle, fmtYi, fmtVolHand, judgePhase, calcMA, calcVolRatio } from '../src/services/analysisCore.js'
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
  { code: 'sh588000', name: '科创50ETF', held: true, levels: [{ p: 1.55, d: 'buy' }, { p: 2.02, d: 'sell' }] }, // 已持仓
  { code: 'sz159755', name: '电池', levels: [{ p: 0.93, d: 'buy' }] },
  { code: 'sh515790', name: '光伏', levels: [{ p: 0.83, d: 'buy' }] },
  { code: 'sz159869', name: '游戏', held: true, levels: [{ p: 1.10, d: 'buy' }, { p: 1.30, d: 'sell' }] }, // 已持仓(8/14)，加卖出目标提醒
  { code: 'sh515250', name: '智能汽车', levels: [{ p: 0.945, d: 'buy' }, { p: 0.928, d: 'buy' }] },
  { code: 'sh512710', name: '军工', levels: [{ p: 0.615, d: 'buy' }] },
  { code: 'sz159996', name: '家电', levels: [{ p: 1.392, d: 'buy' }] },
  { code: 'sz159766', name: '旅游', levels: [{ p: 0.547, d: 'buy' }] },
  { code: 'sh512980', name: '传媒', held: true, levels: [{ p: 0.98, d: 'sell' }] }, // 已持仓(8/14)，卖出目标提醒
]
const NEAR_RATIO = 0.01   // 距挂单价 ≤1% 触发提醒
// 每天发送总上限：自然天花板约63条（55个信号指纹+8个挂单），60足够放行全部真信号
// 超过60说明状态去重失效（如state.json推送失败），保险丝兜底防刷屏
const MAX_DAILY = 60      // 早报/复盘必发，不受限

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
// 窗口放宽原因：GitHub Actions schedule 不保证按时执行（高负载时跳过/延迟，
// 实测一天 55+ 个检查点只执行了 4 次）。早报窗口 09:00-10:00、复盘 15:05 后，
// 只要当天还没发过（st.sentType 防重），任何迟到的 run 都能补发；
// 已发过则让位给盘中 signal 检查，不抢占。
function decideType(hhmm, st) {
  const sent = st?.sentType || []
  if (!sent.includes('morning') && hhmm >= '0900' && hhmm < '1000') return 'morning'
  if (!sent.includes('review') && hhmm >= '1505') return 'review'
  const isTrading = (hhmm >= '0930' && hhmm < '1135') || (hhmm >= '1300' && hhmm < '1505')
  return isTrading ? 'signal' : null                                 // 盘中触发式
}

// ===== 状态：state.json =====
// active：当前仍在提醒中的信号指纹（信号消失即移除，再出现会再提醒）
// sentOnce：当天发过的信号指纹（区分"首次完整提醒"和"消失后重现的简短提醒"）
const STATE_FILE = 'state.json'
function loadState() {
  let st = { date: bjKey(), active: [], sentOnce: [], sentOrder: [], sentType: [], count: 0 }
  try { st = { ...st, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) } } catch { /* 首次 */ }
  if (st.date !== bjKey()) st = { date: bjKey(), active: [], sentOnce: [], sentOrder: [], sentType: [], count: 0 }
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
// 返回 [{code, name, p, d, dist, price}]，dist=现价距挂单价百分比（正=在上方接近/超过）
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
      const rel = (r.price - lv.p) / lv.p
      // buy：现价在上方接近买入价（跌破=已成交，不提醒）
      // sell：现价到达或超过卖出目标价都提醒（跳空直接越过不漏报）
      const hit = lv.d === 'buy' ? rel >= 0 && rel <= NEAR_RATIO : rel >= -NEAR_RATIO
      if (hit) alerts.push({ code: o.code, name: o.name, p: lv.p, d: lv.d, dist: Math.abs(rel), price: r.price })
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

// ===== 数据日期切换：昨日数据→今日数据时，昨日信号作废，今日重新提醒 =====
// 场景：9:00早报基于昨日K线（信号=昨日状态），9:30后K线切到今日，
// 若active里还留着昨日的指纹，今日同一标的再出现同信号会被误判为"已提醒过"而漏报。
export function onDataDate(st, dataDate) {
  if (dataDate && st.dataDate && dataDate !== st.dataDate) {
    st.active = []
    st.sentOnce = []
  }
  st.dataDate = dataDate
  return st
}

// ===== 信号过滤：只发"新出现"的；消失后再出现 → 简短提醒（🔄）=====
export function filterSignals(allSignals, st, reports) {
  const activeKeys = new Set(st.active)
  const sentOnceSet = new Set(st.sentOnce)
  const fresh = allSignals.filter(s => !activeKeys.has(s.code + ':' + s.sig))
  for (const s of fresh) {
    if (sentOnceSet.has(s.code + ':' + s.sig)) {
      const name = s.html.match(/<b>([^<]+)<\/b>/)?.[1] ?? ''
      const rep = reports.find(r => r.code === s.code)
      const px = rep && rep.price != null ? rep.price.toFixed(3) : '--'
      s.html = `🔄 <b>${name}</b> 再度${s.sig}（现价 ${px}）`
    }
  }
  return fresh
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
      // 昨日对照（变动一览用）：用去掉今日的K线窗口重算昨日阶段 + 昨日主力
      rep.yDay = (() => {
        const yk = klines.slice(0, -1)
        if (yk.length < 20) return { date: yk[yk.length - 1]?.date ?? null, stage: null, main: null, small: null }
        const yc = yk.map(k => k.close)
        const yv = yk.map(k => k.volume)
        const yma = { ma5: calcMA(yc, 5), ma10: calcMA(yc, 10), ma20: calcMA(yc, 20) }
        return {
          date: yk[yk.length - 1].date,
          stage: judgePhase(yk, yma, calcVolRatio(yv)).stage,
          main: fund.length > 1 ? (fund[fund.length - 2]?.main ?? null) : null,
          small: fund.length > 1 ? (fund[fund.length - 2]?.small ?? null) : null,
        }
      })()
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
    const pct = r.quotePct ?? null
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

// 数据异常警告条（拉取失败/缺资金数据的标的过半时显示）
function warnHtml(dataWarn) {
  if (!dataWarn) return ''
  return `<div style="background:#fff0f0;border:1px solid #f23645;color:#f23645;padding:8px 12px;border-radius:6px;margin-top:12px;font-size:13px">
    <b>⚠️ 数据异常</b>：11只中 ${dataWarn.err} 只拉取失败、${dataWarn.fundMiss} 只缺资金数据，<b>本邮件分析可能不完整，请谨慎参考</b>
  </div>`
}

// 挂单提醒 HTML
function orderHtml(orderAlerts) {
  if (!orderAlerts.length) return ''
  const dirText = { buy: '买入', sell: '卖出' }
  const lines = orderAlerts.map(o => {
    const reached = o.d === 'sell' && o.price >= o.p
    const distText = reached
      ? `<b style="color:${RED}">已到达/超过卖出价</b>`
      : `还有 <b style="color:${RED}">${(o.dist * 100).toFixed(1)}%</b>`
    return `<p style="margin:4px 0;font-size:13px">🎯 <b>${ESC(o.name)}</b> 距${dirText[o.d]}价 <b>${o.p.toFixed(3)}</b> ${distText}（现价 ${o.price.toFixed(3)}）——准备操作</p>`
  }).join('')
  return `<h3 style="margin-top:20px">🎯 挂单临近提醒</h3>${lines}`
}

// ===== 变动一览（昨日 → 今日，邮件末尾）：阶段 + 主力 =====
function changeHtml(reports, list) {
  const rows = list.filter(r => !r.error && r.yDay)
  if (!rows.length) return ''
  const tDate = (rows[0].date || '').slice(5)
  const yDate = (rows[0].yDay.date || '').slice(5)
  const lines = rows.map(r => {
    const y = r.yDay
    const stageNow = r.phase.stage
    const stageChanged = y.stage && stageNow && y.stage !== stageNow
    const stageText = `<b style="color:${stageChanged ? '#1a73e8' : GRAY}">${ESC(y.stage ?? '--')} → ${ESC(stageNow ?? '--')}</b>`
    const mainNow = r.fund?.main
    const mainChanged = y.main != null && mainNow != null && y.main !== mainNow
    const mainCol = mainChanged ? (mainNow > y.main ? RED : GREEN) : GRAY
    const mainText = `<b style="color:${mainCol}">${y.main != null ? fmtYi(y.main) : '--'} → ${mainNow != null ? fmtYi(mainNow) : '--'}</b>`
    const smallNow = r.fund?.small
    const smallChanged = y.small != null && smallNow != null && y.small !== smallNow
    const smallCol = smallChanged ? (smallNow > y.small ? RED : GREEN) : GRAY
    const smallText = `<b style="color:${smallCol}">${y.small != null ? fmtYi(y.small) : '--'} → ${smallNow != null ? fmtYi(smallNow) : '--'}</b>`
    return `<p style="margin:4px 0;font-size:13px"><b>${ESC(r.name)}</b> · 阶段 ${stageText} · 主力 ${mainText} · 散户 ${smallText}</p>`
  }).join('')
  return `<h3 style="margin-top:24px">📊 变动一览（${yDate} → ${tDate}）</h3>${lines}`
}

// 盘中持仓速览（精简邮件专用）：每只持仓一行
function heldLine(heldReports) {
  if (!heldReports?.length) return ''
  return heldReports.map(r => {
    const pct = r.quotePct ?? null
    return `<p style="margin:4px 0;font-size:13px">⭐ <b>持仓 ${ESC(r.name)}</b> ${r.price.toFixed(3)}（${sign(pct)}%） · ${stageBadge(r.phase.stage)} · 量比${r.volume.volRatio ? r.volume.volRatio.toFixed(2) : '--'} · 主力${r.fund ? fmtYi(r.fund.main) : '--'} · 散户${r.fund && r.fund.small != null ? fmtYi(r.fund.small) : '--'}</p>`
  }).join('')
}

function buildHtml(type, reports, news, signals, orderAlerts, focus, dataWarn) {
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
    // 持仓：所有已持仓标的（科创50/游戏/传媒）
    const heldAll = ORDERS.filter(o => o.held).map(o => reports.find(r => r.code === o.code)).filter(r => r && !r.error)
    // 变动一览聚焦：3只正式 + 持仓
    const focusList = reports.slice(0, 3).concat(heldAll).filter((r, i, a) => r && !r.error && a.indexOf(r) === i)
    return head + warnHtml(dataWarn) +
      (focus ? focusHtml(reports, focus) : '') +
      (signals.length ? `<h3 style="margin-top:20px">🔔 新信号</h3>${signals.map(s => `<p style="font-size:13px;margin:4px 0">${s.html}</p>`).join('')}` : '') +
      orderHtml(orderAlerts) +
      heldLine(heldAll) +
      changeHtml(reports, focusList) +
      foot
  }

  // ===== 全量邮件（早报/复盘）=====
  const formal = reports.slice(0, 3)
  const formalOk = formal.filter(r => !r.error)
  const avg = formalOk.length ? formalOk.reduce((a, r) => a + (r.quotePct ?? 0), 0) / formalOk.length : null
  const moodText = avg == null ? '数据不足' : avg > 0.3 ? '偏暖 🔥' : avg < -0.3 ? '偏冷 🧊' : '中性 ⚖️'
  const moodColor = avg == null ? GRAY : avg > 0.3 ? RED : avg < -0.3 ? GREEN : GRAY

  // 持仓重点：所有已持仓标的（科创50/游戏/传媒），动态生成
  const heldAll = ORDERS.filter(o => o.held).map(o => reports.find(r => r.code === o.code)).filter(r => r && !r.error)
  let heldHtml = ''
  if (heldAll.length) {
    const heldTitle = heldAll.map(r => ESC(r.name)).join('、')
    const heldRows = heldAll.map(held => `
      <tr style="border-bottom:1px solid #eee">
        <td style="padding:6px 8px;text-align:left"><b>${ESC(held.name)}</b></td>
        <td style="padding:6px 8px;text-align:center">${stageBadge(held.phase.stage)}</td>
        <td style="padding:6px 8px;text-align:center">${held.volume.volRatio ? held.volume.volRatio.toFixed(2) : '--'} ${ESC(held.volume.quad)}</td>
        <td style="padding:6px 8px;text-align:center;color:${held.ma.aboveMA5 ? RED : GRAY}">${held.ma.ma5?.toFixed(3) ?? '--'}</td>
        <td style="padding:6px 8px;text-align:center;color:${held.ma.aboveMA10 ? RED : GRAY}">${held.ma.ma10?.toFixed(3) ?? '--'}</td>
        <td style="padding:6px 8px;text-align:center;color:${held.ma.aboveMA20 ? RED : GRAY}">${held.ma.ma20?.toFixed(3) ?? '--'}</td>
        <td style="padding:6px 8px;text-align:center">${held.percentile?.pct ?? '--'}%</td>
        <td style="padding:6px 8px;text-align:right;color:${held.fund ? colorOf(held.fund.main) : GRAY}">${held.fund ? fmtYi(held.fund.main) : '--'}</td>
        <td style="padding:6px 8px;text-align:right;color:${held.fund && held.fund.small != null ? colorOf(held.fund.small) : GRAY}">${held.fund && held.fund.small != null ? fmtYi(held.fund.small) : '--'}</td>
        <td style="padding:6px 8px;text-align:right;color:${held.fund ? colorOf(held.fund.main5d) : GRAY}">${held.fund ? fmtYi(held.fund.main5d) : '--'}</td>
      </tr>`).join('')
    const heldCons = heldAll.map(held =>
      `<p style="font-size:13px;color:#333;background:#fff8e6;border-left:4px solid #ffc107;padding:8px 12px;border-radius:4px">${ESC(held.name)}：${ESC(held.conclusion)}</p>`).join('')
    heldHtml = `
    <h3 style="margin-top:24px">⭐ 持仓：${heldTitle}</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;background:#fafbfc">
      <tr style="background:#f0f2f5">
        <th style="padding:6px 8px;text-align:left">标的</th><th style="padding:6px 8px;text-align:left">阶段</th><th style="padding:6px 8px">量比/量价</th><th style="padding:6px 8px">MA5</th><th style="padding:6px 8px">MA10</th><th style="padding:6px 8px">MA20</th>
        <th style="padding:6px 8px">241分位</th><th style="padding:6px 8px">主力今日</th><th style="padding:6px 8px">散户今日</th><th style="padding:6px 8px">5日累计</th>
      </tr>${heldRows}
    </table>
    ${heldCons}`
  }

  let signalHtml = ''
  if (signals.length) {
    signalHtml = `
    <h3 style="margin-top:24px">🔔 盘中关键信号</h3>
    ${signals.map(s => `<p style="font-size:13px;margin:4px 0">${s.html}</p>`).join('')}`
  }

  return head + warnHtml(dataWarn) + `
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

  ${changeHtml(reports, reports)}
  ${foot}`
}

// ===== 主流程 =====
async function main() {
  const now = bjParts()
  const hhmm = now.hh + now.mm
  const st = loadState()
  const type = process.env.ALERT_TYPE || decideType(hhmm, st)
  if (!type) {
    console.log('非发送时点，跳过')
    process.exit(0)
  }

  const p = bjParts()

  // 先拉数据、先判断假日，再标记"已发"——
  // 教训(8/17)：周一九点开盘前 K线还是上周五(距今天3.37天>3)会误判非交易日，
  // 若先 markSent 则状态被污染，全天所有 run 都跳过、无法补发。
  console.log(`开始分析（${type} ${hhmm}）...`)
  const reports = await fetchAll()

  // 假日判断：K线最后日期距今天 >3天（长假/周末后开盘前数据未更新）
  const lastDate = reports.find(r => !r.error)?.date
  if (lastDate) {
    const diff = (Date.now() - new Date(lastDate + 'T00:00:00+08:00')) / 86400_000
    if (diff > 3) {
      console.log('非交易日（最后K线 ' + lastDate + '），跳过')
      process.exit(0)
    }
  }

  // 数据完整性门槛：拉取失败/缺资金数据的标的过半 → 本次不发送、不打标记
  // 与假日判断同理（8/17 教训）：没确认数据可靠，就不消耗当天的发送机会，
  // 下一个 run（5分钟后）数据恢复即自动补发，保证收到的邮件数据完整
  const errCount = reports.filter(r => r.error).length
  const fundMiss = reports.filter(r => !r.error && !r.fund).length
  const HALF = Math.ceil(INDEX_LIST.length / 2)
  if (errCount >= HALF || fundMiss >= HALF) {
    console.log(`数据拉取失败 ${errCount} 只 / 缺资金数据 ${fundMiss} 只（≥${HALF}/${INDEX_LIST.length}），本次不发送，数据恢复后自动补发`)
    process.exit(0)
  }

  // 早报/复盘：当天一次（.alert-last 防重）——在假日判断之后，误判不会污染状态
  if (type !== 'signal') {
    if (!markSent(type)) {
      console.log(`今天已发过 ${type}，跳过`)
      process.exit(0)
    }
  } else if (st.count >= MAX_DAILY) {
    console.log(`今天已发 ${st.count} 条，达到上限 ${MAX_DAILY}，跳过`)
    process.exit(0)
  }

  // 数据日期切换（昨日数据→今日数据）：昨日信号作废，今日重新提醒
  const dataDate = reports.find(r => !r.error)?.date
  onDataDate(st, dataDate)

  // 信号：只发"新出现"的（正在提醒中的不重复）；信号消失后再出现 → 再提醒（简短版）
  const allSignals = collectSignals(reports)
  const freshSignals = filterSignals(allSignals, st, reports)

  // 挂单临近（每单当天提醒一次）
  const orderAlerts = checkOrders(reports, st.sentOrder)

  // 盘中：无新信号且无挂单临近 → 不发
  // 但必须刷新 active（信号消失即移除，否则再现会被旧指纹挡住漏报）
  if (type === 'signal' && !freshSignals.length && !orderAlerts.length) {
    const nextActive = allSignals.map(s => s.code + ':' + s.sig)
    if (nextActive.join() !== st.active.join()) {
      st.active = nextActive
      saveState(st)
    }
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

  // 数据异常警告：失败过半已被前方门槛拦截（不发送），邮件数据必完整，恒为 null
  const dataWarn = null

  // 盘中发新信号（精简）；早报/复盘发当天全部活跃信号（总结）
  const showSignals = type === 'signal' ? freshSignals : allSignals
  const focus = type === 'signal' ? periodFocus(hhmm) : null
  const html = buildHtml(type, reports, news, showSignals, orderAlerts, focus, dataWarn)
  const typeName = { morning: '早报', review: '复盘', signal: '盘中信号' }[type]
  fs.writeFileSync('mail.html', html)
  fs.writeFileSync('mail_subject.txt', `ETF量能${typeName} ${p.m}月${p.day}日 ${showSignals.length ? `(${showSignals.length}个信号)` : orderAlerts.length ? '(挂单临近)' : ''}`)
  console.log(`已生成邮件：${typeName}，新信号 ${freshSignals.length} 条，挂单提醒 ${orderAlerts.length} 条`)

  // 状态更新：active=当前全部活跃信号（消失自动移除，再出现会再提醒）
  if (type !== 'signal' && !st.sentType.includes(type)) st.sentType.push(type)
  st.active = allSignals.map(s => s.code + ':' + s.sig)
  for (const s of freshSignals) {
    const fp = s.code + ':' + s.sig
    if (!st.sentOnce.includes(fp)) st.sentOnce.push(fp)
  }
  for (const o of orderAlerts) {
    const fp = o.code + ':' + o.p
    if (!st.sentOrder.includes(fp)) st.sentOrder.push(fp)
  }
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
